/**
 * The Free plan allows one sandbox, so cleanup and the fork fallback are on
 * the demo's critical path. These run SealedRoom against a fake SDK handle.
 */
process.env.DOTENV_CONFIG_PATH = "/nonexistent/leakfinder-test.env"; // tests never read a real .env

import { test } from "node:test";
import assert from "node:assert/strict";
import { CreateosSandboxRateLimitError } from "@nodeops-createos/sandbox";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SealedRoom as Room } from "../src/sandbox.js";

const { FORK_NEEDS_PLAN, SealedRoom, hostWheels } = await import("../src/sandbox.js");

class FakeBox {
  id = "sb-fake";
  status = "running";
  data = { ingress_enabled: false };
  calls: string[] = [];
  forkError: unknown = null;
  resumeError: unknown = null;
  statusOnRefresh: string | null = null;
  out = "PROBE 401 0.10\n";
  scripts: string[] = [];
  uploads: { path: string; size: number; timeoutMs?: number }[] = [];
  files = {
    upload: async (path: string, data: Blob | string, opts?: { timeoutMs?: number }) => {
      this.uploads.push({ path, size: typeof data === "string" ? data.length : data.size, timeoutMs: opts?.timeoutMs });
    },
  };
  async refresh() {
    this.calls.push("refresh");
    if (this.statusOnRefresh) this.status = this.statusOnRefresh;
  }
  async getEgress() {
    return { id: this.id, egress: ["api.stripe.com", "10.0.0.5:5432"] };
  }
  async pause() {
    this.calls.push("pause");
    this.status = "paused";
  }
  async waitUntilPaused() {}
  async resume() {
    this.calls.push("resume");
    if (this.resumeError) throw this.resumeError;
    this.status = "running";
  }
  async waitUntilRunning() {
    this.calls.push("waitUntilRunning");
    this.status = "running";
  }
  async fork() {
    this.calls.push("fork");
    throw this.forkError;
  }
  async destroy() {
    this.calls.push("destroy");
    this.status = "destroying";
    return { id: this.id, status: "destroying" };
  }
  async waitUntilDestroyed() {
    this.calls.push("waitUntilDestroyed");
    this.status = "destroyed";
  }
  async runCommand(_cmd: string, args: string[]) {
    // Every exec is `timeout -k 5 N bash -lc <script>`; the only one here is the Stripe HTTP probe.
    this.calls.push(args.at(-1)?.includes("urllib") ? "stripe-probe" : "exec");
    this.scripts.push(args.at(-1) ?? "");
    return { result: { stdout: this.out, stderr: "", exit_code: 0 }, exec_ms: 100 };
  }
}

const roomOf = (box: FakeBox) => new (SealedRoom as any)(box, ["api.stripe.com", "10.0.0.5:5432"]) as Room;

test("destroy waits until the sandbox stops counting against the cap", async () => {
  const box = new FakeBox();
  await roomOf(box).destroy();
  assert.deepEqual(box.calls, ["destroy", "waitUntilDestroyed"]);
});

test("a fork refused for the plan cap resumes the original, waits for Stripe, and names the Beginner plan", async () => {
  const box = new FakeBox();
  box.forkError = new CreateosSandboxRateLimitError("concurrent sandbox limit reached", new Response(null, { status: 429 }));
  await assert.rejects(roomOf(box).pauseAndFork(), (e: Error) => e.message === FORK_NEEDS_PLAN);
  assert.equal(box.status, "running", "the original must be running again for the fallback dry run");
  const resumed = box.calls.indexOf("resume");
  assert.ok(resumed > box.calls.indexOf("fork"), "resumed after the failed fork");
  assert.ok(box.calls.indexOf("stripe-probe") > resumed, "Stripe answered from the resumed room before the fallback runs");
});

test("retire destroys a live sandbox by id and waits; an already destroyed one is left alone", async () => {
  const live = new FakeBox();
  const gone = Object.assign(new FakeBox(), { status: "destroyed" });
  const prev = (SealedRoom as any).cached;
  (SealedRoom as any).cached = { getSandbox: async (id: string) => (id === "live" ? live : gone) };
  try {
    assert.equal(await SealedRoom.retire("live"), true);
    assert.deepEqual(live.calls, ["destroy", "waitUntilDestroyed"]);
    assert.equal(await SealedRoom.retire("gone"), false);
    assert.deepEqual(gone.calls, []);
  } finally {
    (SealedRoom as any).cached = prev;
  }
});

/** Swap the cached client for one whose getSandbox hands back `box`. */
async function withClient<T>(box: FakeBox | (() => never), fn: () => Promise<T>): Promise<T> {
  const prev = (SealedRoom as any).cached;
  (SealedRoom as any).cached = { getSandbox: async () => (typeof box === "function" ? box() : box) };
  try {
    return await fn();
  } finally {
    (SealedRoom as any).cached = prev;
  }
}

test("retire leaves a destroying sandbox alone but waits until it frees the slot", async () => {
  const dying = Object.assign(new FakeBox(), { status: "destroying" });
  assert.equal(await withClient(dying, () => SealedRoom.retire("dying")), true);
  assert.deepEqual(dying.calls, ["waitUntilDestroyed"]);
});

test("attach resumes an auto-paused room and waits for Stripe before anything runs", async () => {
  const box = Object.assign(new FakeBox(), { status: "paused" });
  const room = await withClient(box, () => SealedRoom.attach("sb-fake"));
  assert.equal(room.id, "sb-fake");
  assert.deepEqual(box.calls, ["resume", "stripe-probe"]);
});

test("attach probes Stripe even when the room was already running (a link may have just woken it)", async () => {
  const box = new FakeBox();
  await withClient(box, () => SealedRoom.attach("sb-fake"));
  assert.deepEqual(box.calls, ["stripe-probe"]);
});

test("attach rides along when the report link woke the room between its GET and its resume", async () => {
  const box = Object.assign(new FakeBox(), { status: "paused", statusOnRefresh: "resuming" });
  box.resumeError = new Error("409 sandbox is resuming");
  await withClient(box, () => SealedRoom.attach("sb-fake"));
  assert.deepEqual(box.calls, ["resume", "refresh", "waitUntilRunning", "stripe-probe"]);
});

test("attach to a destroyed room says to scan again instead of waiting on it", async () => {
  const box = Object.assign(new FakeBox(), { status: "destroyed" });
  await assert.rejects(withClient(box, () => SealedRoom.attach("sb-old")), /sb-old is destroyed: run pnpm scan again/);
  assert.deepEqual(box.calls, []);
});

test("libraries: the wheel tarball matches the VM's Python and CPU, uploads with a long timeout, and AppleDouble twins are dropped", async () => {
  const home = mkdtempSync(join(tmpdir(), "lf-home-"));
  mkdirSync(join(home, ".cache", "leakfinder"), { recursive: true });
  writeFileSync(join(home, ".cache", "leakfinder", "wheels-cp312-aarch64.tgz"), "fake tarball");
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal(hostWheels("3.12.9", "aarch64"), join(home, ".cache", "leakfinder", "wheels-cp312-aarch64.tgz"));
    const box = new FakeBox();
    box.out = "ok\n";
    await (roomOf(box) as any).installLibraries("3.12.9", "aarch64");
    assert.deepEqual(box.uploads, [{ path: "/tmp/lf-wheels.tgz", size: "fake tarball".length, timeoutMs: 180_000 }]);
    assert.match(box.scripts[0], /tar xzf \/tmp\/lf-wheels\.tgz -C \/tmp\/lf-wheels && rm -f \/tmp\/lf-wheels\/\._\*/);
    assert.match(box.scripts[0], /--no-index --find-links \/tmp\/lf-wheels/);
  } finally {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});
