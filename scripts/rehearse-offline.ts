/**
 * The first live step, offline: the real `pnpm seed` and `pnpm verify`, as
 * child processes running src/seed.ts and src/verify.ts unchanged, against a
 * local Postgres and the in-memory Stripe from test/fake-stripe.ts. The only
 * difference from the live run is a loader hook that points the `stripe`
 * import at the fake. No .env, no key, nothing leaves 127.0.0.1.
 *
 *   pnpm exec tsx scripts/rehearse-offline.ts --db postgresql://postgres:postgres@127.0.0.1:5432/postgres
 *   pnpm exec tsx scripts/rehearse-offline.ts --pglite <dir with @electric-sql/pglite and @electric-sql/pglite-socket installed>
 *       [--audit "<shell command>" --findings <path>]   also run an audit (DATABASE_URL, STRIPE_SECRET_KEY,
 *                                                       STRIPE_API_BASE in its env) and score its findings.json
 *       [--keep-key <path>]                             copy the answer key there before restoring seed/expected.json
 *
 * It seeds twice (the second run exercises the sweep of the first) and runs
 * verify after each. Exits 1 unless both read 12 · 3 · 5 · $348. The seed
 * drops its six tables, so --db must be a throwaway local database.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scoreAgainstExpected } from "../src/score.js";
import { normalizeFindings } from "../src/types.js";
import { startFakeStripe } from "../test/fake-stripe.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const t0 = Date.now();
const log = (s: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s  ${s}`);
const KEY = "sk_test_offline_rehearsal";

/** `stripe` resolves to a subclass whose every client talks to the fake. Same SDK, same requests, other host. */
function stripeHook(port: number) {
  const real = import.meta.resolve("stripe");
  const shim = `import Real from ${JSON.stringify(real)};
export * from ${JSON.stringify(real)};
export default class OfflineStripe extends Real {
  constructor(key, config = {}) { super(key, { ...config, host: "127.0.0.1", port: ${port}, protocol: "http", telemetry: false }); }
}`;
  const loader = `const shim = ${JSON.stringify(`data:text/javascript,${encodeURIComponent(shim)}`)};
export async function resolve(spec, ctx, next) {
  return spec === "stripe" ? { url: shim, format: "module", shortCircuit: true } : next(spec, ctx);
}`;
  const register = `import { register } from "node:module";
register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)});`;
  return `data:text/javascript,${encodeURIComponent(register)}`;
}

function run(cmd: string, argv: string[], env: Record<string, string>, label: string, shell = false): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    // Only what the child needs: no inherited STRIPE_SECRET_KEY or DATABASE_URL from the shell.
    // Nor CLAUDECODE, which makes stripe-node print a plugin hint a plain demo terminal never shows.
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(STRIPE_|DATABASE_URL|ANTHROPIC_|CREATEOS_|CLAUDECODE|CLAUDE_CODE_)/.test(k)));
    const child = spawn(cmd, argv, { cwd: root, env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"], shell });
    let out = "";
    const show = (d: Buffer) => {
      out += d;
      for (const line of String(d).split(/[\r\n]+/)) if (line.trim()) console.log(`        ${label} │ ${line}`);
    };
    child.stdout.on("data", show);
    child.stderr.on("data", show);
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

async function localPostgres(): Promise<{ url: string; stop: () => Promise<void> }> {
  const db = arg("--db");
  if (db) {
    const host = new URL(db).hostname;
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) throw new Error(`--db must be a local throwaway database (the seed drops its tables); got host ${host}`);
    return { url: db, stop: async () => {} };
  }
  const dir = arg("--pglite");
  if (!dir) throw new Error("pass --db <local postgres url> or --pglite <dir where @electric-sql/pglite and @electric-sql/pglite-socket are installed>");
  const req = createRequire(join(dir, "package.json"));
  const { PGlite } = await import(pathToFileURL(req.resolve("@electric-sql/pglite")).href);
  const { PGLiteSocketServer } = await import(pathToFileURL(req.resolve("@electric-sql/pglite-socket")).href);
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer().once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const p = (probe.address() as { port: number }).port;
      probe.close(() => resolve(p));
    });
  });
  const pglite = await PGlite.create();
  // The seed holds one connection while its self-check opens a second; Neon allows many, PGlite's default is one.
  const server = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port, maxConnections: 8 });
  await server.start();
  return {
    url: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
    stop: async () => {
      await server.stop();
      await pglite.close();
    },
  };
}

const want = { a: 12, b: 3, c: 5, leak: "$348" };
const noisy = (out: string) => /DeprecationWarning|Warning:|SECURITY WARNING/.test(out);
const seedOk = (out: string) =>
  !noisy(out) &&
  out.includes(`planted: A ${want.a} · B ${want.b} · C ${want.c} · ${want.leak}/month`) && out.includes("self-check: pnpm verify reads the same back") && !/warning:/.test(out);
const verifyOk = (out: string) =>
  !noisy(out) &&
  new RegExp(`A  pro access nobody pays for +${want.a} +\\(7 never paid · 5 cancelled in Stripe\\)`).test(out) &&
  new RegExp(`B  paying with no app account +${want.b} `).test(out) &&
  new RegExp(`C  app rows out of sync +${want.c}\\b`).test(out) &&
  out.includes(`leak  ${want.leak} / month`) &&
  out.includes("read  252 app users · 48 pro entitlements · 39 active or trialing Stripe subscriptions") &&
  out.includes("seed answer key: matches");

async function main() {
  const keyPath = join(root, "seed/expected.json");
  const savedKey = existsSync(keyPath) ? readFileSync(keyPath) : null;
  const stripe = await startFakeStripe();
  const pg = await localPostgres();
  log(`fake Stripe on ${stripe.apiBase} · Postgres at ${pg.url.replace(/:[^:@/]+@/, ":***@")}`);
  const env = { STRIPE_SECRET_KEY: KEY, DATABASE_URL: pg.url, STRIPE_SUPPRESS_NOTICES: "true" };
  const tsx = (file: string, label: string) => run(process.execPath, ["--import", "tsx", "--import", stripeHook(stripe.port), file], env, label);
  const failures: string[] = [];
  try {
    for (const pass of [1, 2]) {
      log(`pnpm seed (pass ${pass}${pass === 2 ? ", sweeps pass 1" : ""})`);
      const s = await tsx("src/seed.ts", "seed  ");
      if (s.code !== 0 || !seedOk(s.out)) failures.push(`seed pass ${pass}: exit ${s.code}, did not print 12 · 3 · 5 · $348 with a clean self-check`);
      log("pnpm verify");
      const v = await tsx("src/verify.ts", "verify");
      if (v.code !== 0 || !verifyOk(v.out)) failures.push(`verify after pass ${pass}: exit ${v.code}, did not read 12 · 3 · 5 · $348`);
    }
    const live = [...stripe.fake.customers.values()].length;
    log(`fake Stripe after two seeds: ${live} customers (${stripe.fake.calls.length} requests) · route errors: ${stripe.fake.errors.length}`);
    if (live !== 54) failures.push(`expected 54 customers after the second seed swept the first, found ${live}`);
    if (stripe.fake.errors.length) failures.push(`fake Stripe route errors: ${stripe.fake.errors.join("; ")}`);

    const keep = arg("--keep-key");
    if (keep && existsSync(keyPath)) copyFileSync(keyPath, keep);

    const audit = arg("--audit");
    if (audit) {
      const findingsPath = arg("--findings") ?? "findings.json";
      rmSync(findingsPath, { force: true });
      log(`audit: ${audit}`);
      const a = await run(audit, [], { ...env, STRIPE_API_BASE: stripe.apiBase }, "audit ", true);
      if (a.code !== 0 || !existsSync(findingsPath)) failures.push(`audit exited ${a.code}${existsSync(findingsPath) ? "" : ", no findings file"}`);
      else {
        const expected = JSON.parse(readFileSync(keyPath, "utf8"));
        const f = normalizeFindings(JSON.parse(readFileSync(findingsPath, "utf8")));
        const sc = scoreAgainstExpected(f, expected);
        log(`score vs seed/expected.json: ${JSON.stringify(sc)}`);
        log(`totals: ${JSON.stringify(f.totals)} (answer key: ${JSON.stringify(expected.totals)})`);
        const parts = [sc.pro_without_subscription, sc.payers_without_account, sc.stale_subscription_rows];
        if (parts.some((p) => p.found !== p.planted || p.extra) || sc.leak_cents.found !== sc.leak_cents.planted) failures.push("audit findings do not match the answer key");
        if (JSON.stringify(f.totals) !== JSON.stringify(expected.totals)) failures.push("audit totals do not match the answer key");
        const causes = new Map(f.pro_without_subscription.map((r) => [r.user_id.toLowerCase(), r.cause]));
        const wrong = (expected.pro_without_subscription as { user_id: string; cause: string }[]).filter((k) => causes.get(k.user_id) !== k.cause).length;
        if (wrong) failures.push(`${wrong} pro_without_subscription causes differ from the answer key`);
      }
    }
  } finally {
    // The answer key belongs to whatever the live seed planted, not to this rehearsal.
    if (savedKey) writeFileSync(keyPath, savedKey);
    else rmSync(keyPath, { force: true });
    await stripe.close();
    await pg.stop();
  }
  if (failures.length) {
    for (const f of failures) log(`FAIL  ${f}`);
    process.exit(1);
  }
  log("PASS  seed → verify → re-seed → verify: 12 · 3 · 5 · $348, offline");
}

main().catch((e) => {
  console.error(`rehearsal failed: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
  process.exit(1);
});
