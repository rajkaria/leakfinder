/**
 * The Free plan allows one sandbox, so cleanup and the fork fallback are on
 * the demo's critical path. These run SealedRoom against a fake SDK handle.
 */
process.env.DOTENV_CONFIG_PATH = "/nonexistent/leakfinder-test.env"; // tests never read a real .env

import { test } from "node:test";
import assert from "node:assert/strict";
import { CreateosSandboxRateLimitError } from "@nodeops-createos/sandbox";
import type { SealedRoom as Room } from "../src/sandbox.js";

const { FORK_NEEDS_PLAN, SealedRoom } = await import("../src/sandbox.js");

class FakeBox {
  id = "sb-fake";
  status = "running";
  data = { ingress_enabled: false };
  calls: string[] = [];
  forkError: unknown = null;
  async refresh() {
    this.calls.push("refresh");
  }
  async pause() {
    this.calls.push("pause");
    this.status = "paused";
  }
  async waitUntilPaused() {}
  async resume() {
    this.calls.push("resume");
    this.status = "running";
  }
  async waitUntilRunning() {}
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
    return { result: { stdout: "PROBE 401 0.10\n", stderr: "", exit_code: 0 }, exec_ms: 100 };
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
