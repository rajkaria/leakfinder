/**
 * vm/server.py is the only thing in the VM a stranger can reach, and its
 * /apply button sends real (test-mode) invoices. Run it locally against a
 * fake fix.py and check the token gate, redaction and apply-once.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../vm/server.py", import.meta.url));
const DRYRUN = fileURLToPath(new URL("../vm/dryrun.py", import.meta.url));
const TOKEN = "test-token-abc123";
const EMAIL = "jane.doe@example.com";

const FAKE_FIX = `
import json, os
with open("runs.txt", "a") as f:
    f.write(os.environ.get("APPLY", "?") + "\\n")
print("checking 252 users")
print("would invoice ${EMAIL} for one month of Pro")
mode = "applied" if os.environ.get("APPLY") == "1" else "dry_run"
print("LEAKFINDER_SUMMARY " + json.dumps({"mode": mode, "revoked": 12, "invoices": 12,
  "invoiced_cents": 34800, "refunds": 3, "refunded_cents": 8700, "cancelled": 3,
  "rows_synced": 5, "leak_closed_cents": 34800}))
`;

interface Running {
  proc: ChildProcess;
  base: string;
  dir: string;
}

async function startServer(extraEnv: Record<string, string> = {}): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), "leakfinder-server-"));
  writeFileSync(join(dir, "report.html"), "<h1>$348 / month leaking</h1>");
  writeFileSync(join(dir, "fix.py"), FAKE_FIX);
  if (!extraEnv.NO_DRYRUN_GUARD) writeFileSync(join(dir, "leakfinder_dryrun.py"), readFileSync(DRYRUN, "utf8"));
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.STRIPE_SECRET_KEY;
  Object.assign(env, {
    LEAKFINDER_WORKDIR: dir,
    LEAKFINDER_TOKEN: TOKEN,
    LEAKFINDER_PORT: "0",
    LEAKFINDER_BIND: "127.0.0.1",
    ...extraEnv,
  });
  const proc = spawn("python3", [SERVER], { env, stdio: ["ignore", "pipe", "pipe"] });
  const base = await new Promise<string>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`server did not start: ${out}`)), 10_000);
    proc.stdout!.on("data", (chunk) => {
      out += chunk;
      const m = out.match(/LEAKFINDER_SERVER listening ([\d.]+):(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(`http://${m[1]}:${m[2]}`);
      }
    });
    proc.stderr!.on("data", (chunk) => (out += chunk));
    proc.on("exit", (code) => reject(new Error(`server exited ${code}: ${out}`)));
  });
  return { proc, base, dir };
}

function stop(r: Running | undefined) {
  if (!r) return;
  r.proc.kill();
  rmSync(r.dir, { recursive: true, force: true });
}

const runs = (r: Running) => (existsSync(join(r.dir, "runs.txt")) ? readFileSync(join(r.dir, "runs.txt"), "utf8") : "");

let srv: Running;
let cookie = "";

before(async () => {
  srv = await startServer();
});
after(() => stop(srv));

test("GET / without a token is 403", async () => {
  assert.equal((await fetch(`${srv.base}/`)).status, 403);
  assert.equal((await fetch(`${srv.base}/?k=wrong`)).status, 403);
  assert.equal((await fetch(`${srv.base}/status.json`)).status, 403);
});

test("GET /?k=<token> serves the report and sets an HttpOnly cookie", async () => {
  const res = await fetch(`${srv.base}/?k=${TOKEN}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(await res.text(), "<h1>$348 / month leaking</h1>");
  const setCookie = res.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  cookie = setCookie.split(";")[0];
  assert.equal(cookie, `lf_token=${TOKEN}`);
});

test("the cookie alone authorizes a reload and status.json", async () => {
  const page = await fetch(`${srv.base}/`, { headers: { cookie } });
  assert.equal(page.status, 200);
  const status = await fetch(`${srv.base}/status.json`, { headers: { cookie } });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { applied: false });
});

test("never serves any file other than report.html", async () => {
  for (const p of ["/fix.py", "/runs.txt", "/../fix.py", "/report.html/../fix.py", "/applied.json"]) {
    const res = await fetch(`${srv.base}${p}?k=${TOKEN}`);
    assert.equal(res.status, 404, p);
  }
});

test("POST without a token is 403 and runs nothing", async () => {
  assert.equal((await fetch(`${srv.base}/dryrun`, { method: "POST" })).status, 403);
  assert.equal((await fetch(`${srv.base}/apply`, { method: "POST" })).status, 403);
  assert.equal(runs(srv), "");
});

test("POST /dryrun returns the parsed summary and a redacted log", async () => {
  const res = await fetch(`${srv.base}/dryrun`, { method: "POST", headers: { cookie } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { summary: any; log: string[] };
  assert.equal(body.summary.mode, "dry_run");
  assert.equal(body.summary.invoiced_cents, 34800);
  assert.equal(body.summary.leak_closed_cents, 34800);
  const log = body.log.join("\n");
  assert.ok(!log.includes(EMAIL), "email must be redacted");
  assert.match(log, /\[email\]/);
  assert.ok(body.log.length <= 40);
  assert.equal(runs(srv), "0\n");
});

test("POST /apply runs fix.py with APPLY=1 once and remembers the result", async () => {
  const first = await fetch(`${srv.base}/apply`, { method: "POST", headers: { cookie } });
  assert.equal(first.status, 200);
  const a = (await first.json()) as any;
  assert.equal(a.applied, true);
  assert.equal(a.summary.mode, "applied");
  assert.equal(a.summary.refunded_cents, 8700);
  assert.match(a.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(runs(srv), "0\n1\n");

  const second = await fetch(`${srv.base}/apply`, { method: "POST", headers: { "X-LeakFinder-Token": TOKEN } });
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), a);
  assert.equal(runs(srv), "0\n1\n", "fix.py must not run a second time");

  const status = await fetch(`${srv.base}/status.json`, { headers: { cookie } });
  assert.deepEqual(await status.json(), a);
});

test("POST /apply refuses a live Stripe key without running fix.py", async () => {
  const live = await startServer({ STRIPE_SECRET_KEY: "sk_live_not_a_real_key" });
  try {
    const res = await fetch(`${live.base}/apply`, { method: "POST", headers: { "X-LeakFinder-Token": TOKEN } });
    assert.equal(res.status, 403);
    assert.equal(runs(live), "");
  } finally {
    stop(live);
  }
});

test("POST /dryrun refuses to run fix.py when the dry-run guard is missing", async () => {
  const bare = await startServer({ NO_DRYRUN_GUARD: "1" });
  try {
    const login = await fetch(`${bare.base}/?k=${TOKEN}`, { redirect: "manual" });
    const c = (login.headers.get("set-cookie") ?? "").split(";")[0];
    const res = await fetch(`${bare.base}/dryrun`, { method: "POST", headers: { cookie: c } });
    assert.equal(res.status, 500);
    assert.match(JSON.stringify(await res.json()), /dry-run guard leakfinder_dryrun.py is missing/);
    assert.equal(runs(bare), "", "fix.py never ran");
  } finally {
    bare.proc.kill();
  }
});
