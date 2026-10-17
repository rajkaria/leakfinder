/**
 * vm/dryrun.py makes a dry run dry whatever fix.py does with APPLY: a live
 * rehearsal produced a fix.py that gated only its database commit on APPLY and
 * sent real Stripe refunds, cancellations and invoices during APPLY=0. These
 * tests run the harness with stand-in `stripe` and `psycopg` modules shaped
 * like the real ones at the points it patches.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HARNESS = readFileSync(new URL("../vm/dryrun.py", import.meta.url), "utf8");

/** stripe._http_client.HTTPClient.request_with_retries and psycopg.Connection.connect, as in stripe 16 and psycopg 3. */
const FAKE_STRIPE = `class HTTPClient:
    def request_with_retries(self, method, url, headers, post_data=None, max_network_retries=None, *, _usage=None):
        print("SENT", method.upper(), url)
        return ("{}", 200, {})
`;
const FAKE_PSYCOPG = `class Connection:
    def __init__(self):
        self.autocommit = False
        self.statements = []
    @classmethod
    def connect(cls, *a, **k):
        return cls()
    def execute(self, sql, params=None):
        if sql.startswith("SET SESSION default_transaction_read_only"):
            self.read_only = True
        elif sql.split()[0].upper() in ("UPDATE", "INSERT", "DELETE") and getattr(self, "read_only", False):
            raise RuntimeError("cannot execute %s in a read-only transaction" % sql.split()[0].upper())
        self.statements.append(sql)
connect = Connection.connect
`;

function run(fix: string, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "leakfinder-dryrun-"));
  mkdirSync(join(dir, "lib", "stripe"), { recursive: true });
  mkdirSync(join(dir, "lib", "psycopg"), { recursive: true });
  writeFileSync(join(dir, "lib", "stripe", "__init__.py"), "from . import _http_client\n");
  writeFileSync(join(dir, "lib", "stripe", "_http_client.py"), FAKE_STRIPE);
  writeFileSync(join(dir, "lib", "psycopg", "__init__.py"), FAKE_PSYCOPG);
  writeFileSync(join(dir, "leakfinder_dryrun.py"), HARNESS);
  writeFileSync(join(dir, "fix.py"), fix);
  const r = spawnSync("python3", ["leakfinder_dryrun.py", "fix.py"], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONPATH: join(dir, "lib"), APPLY: "1", ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const PRELUDE = `import os, stripe, psycopg
c = stripe._http_client.HTTPClient()
print("APPLY", os.environ.get("APPLY"))
`;

test("dry-run harness: GETs go through, APPLY is forced to 0", () => {
  const r = run(`${PRELUDE}c.request_with_retries("get", "https://api.stripe.com/v1/subscriptions?limit=100", {})\nprint("LEAKFINDER_SUMMARY {}")\n`);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /APPLY 0/, "APPLY=1 from the parent environment is overridden");
  assert.match(r.out, /SENT GET https:\/\/api.stripe.com\/v1\/subscriptions/);
});

test("dry-run harness: a Stripe POST or DELETE is refused before it is sent, even when the script ignores APPLY", () => {
  for (const method of ["post", "delete"]) {
    const r = run(`${PRELUDE}c.request_with_retries("${method}", "https://api.stripe.com/v1/refunds?x=1", {}, "amount=2900")\n`);
    assert.notEqual(r.code, 0);
    assert.ok(!r.out.includes("SENT"), "nothing reached the wire");
    assert.match(r.err, new RegExp(`DryRunWriteRefused: dry run: Stripe ${method.toUpperCase()} /v1/refunds refused`));
  }
});

test("dry-run harness: every Postgres session is read-only", () => {
  const ok = run(`${PRELUDE}conn = psycopg.connect("postgres://x")\nconn.execute("SELECT 1")\nprint("autocommit", conn.autocommit)\n`);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /autocommit False/, "the script's own autocommit setting is restored");
  const bad = run(`${PRELUDE}conn = psycopg.Connection.connect("postgres://x")\nconn.execute("UPDATE teams SET plan_name = NULL")\n`);
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /read-only transaction/);
});
