/**
 * The Next.js SaaS Starter demo, offline and for real: the CLI
 * `tsx src/starters/saas-starter.ts seed|verify` unchanged, as child
 * processes, against a real Postgres (a local one, or PGlite over its socket
 * server) and the in-memory Stripe from test/fake-stripe.ts. Same loader hook
 * as scripts/rehearse-offline.ts: the `stripe` import points at the fake. No
 * .env, no key, nothing leaves 127.0.0.1.
 *
 *   pnpm exec tsx scripts/rehearse-starter.ts --pglite <dir with @electric-sql/pglite and @electric-sql/pglite-socket installed>
 *   pnpm exec tsx scripts/rehearse-starter.ts --db postgresql://postgres:postgres@127.0.0.1:5432/postgres
 *       [--main-first]      seed the main demo (src/seed.ts) first, to check the switch drops its tables
 *       [--keep-key <path>] copy the starter's answer key there before restoring seed/expected.json
 *
 * Seeds twice (the second run sweeps the first) and verifies after each, then
 * checks the database holds exactly the starter's five tables, its constraints,
 * and sequences that continue after the seeded ids. Exits 1 unless both
 * recounts read 12 · 3 · 5 · $348.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { STARTER_SCHEMA, STARTER_TABLES, USER_ID_BASE } from "../src/starters/saas-starter.js";
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

function run(argv: string[], env: Record<string, string>, label: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(STRIPE_|DATABASE_URL|ANTHROPIC_|CREATEOS_|CLAUDECODE|CLAUDE_CODE_)/.test(k)));
    const child = spawn(process.execPath, argv, { cwd: root, env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"] });
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

const noisy = (out: string) => /DeprecationWarning|Warning:|SECURITY WARNING/.test(out);
const seedOk = (out: string) =>
  !noisy(out) && out.includes("planted: A 12 · B 3 · C 5 · $348/month") && out.includes("self-check: the recount reads the same back") && !/warning:/.test(out);
const verifyOk = (out: string) =>
  !noisy(out) &&
  out.includes(`schema  ${STARTER_SCHEMA}`) &&
  /A  paid plan nobody pays for +12 +\(7 never paid · 5 cancelled in Stripe\)/.test(out) &&
  /B  paying with no team +3 /.test(out) &&
  /C  team rows out of sync +5\b/.test(out) &&
  out.includes("leak  $348 / month") &&
  /read  252 app users · \d+ teams · 48 on a paid plan · 39 active or trialing Stripe subscriptions/.test(out) &&
  out.includes("seed answer key: matches");

/** The database after the seed: only the starter's tables, its constraints, rows that add up, sequences past the seeded ids. */
async function inspect(url: string): Promise<string[]> {
  const bad: string[] = [];
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    const tables = (await db.query("select table_name from information_schema.tables where table_schema = 'public' order by 1")).rows.map((r) => r.table_name);
    if (JSON.stringify(tables) !== JSON.stringify([...STARTER_TABLES].sort())) bad.push(`public tables are ${tables.join(", ")}, not the starter's five`);
    const fks = Number((await db.query("select count(*)::int as n from information_schema.table_constraints where table_schema = 'public' and constraint_type = 'FOREIGN KEY'")).rows[0].n);
    if (fks !== 6) bad.push(`${fks} foreign keys, the migration creates 6`);
    const counts = (await db.query(
      "select (select count(*)::int from users) as users, (select count(*)::int from teams) as teams, (select count(*)::int from team_members) as members, (select count(*)::int from teams where plan_name is not null and subscription_status in ('active','trialing')) as paid, (select count(*)::int from users u where not exists (select 1 from team_members m where m.user_id = u.id)) as teamless, (select min(id)::int from users) as min_user",
    )).rows[0];
    log(`db: ${counts.users} users · ${counts.teams} teams · ${counts.members} memberships · ${counts.paid} paid teams`);
    if (counts.users !== 252 || counts.members !== 252 || counts.paid !== 48 || counts.teamless !== 0) bad.push(`row counts off: ${JSON.stringify(counts)}`);
    if (counts.min_user <= USER_ID_BASE) bad.push(`user ids start at ${counts.min_user}`);
    // The app can still sign people up: the next serial ids do not collide with the seeded ones.
    await db.query("begin");
    const u = (await db.query("insert into users (email, password_hash) values ('probe@leakfinder.test', 'x') returning id")).rows[0].id;
    const t = (await db.query("insert into teams (name) values ('probe') returning id")).rows[0].id;
    await db.query("rollback");
    if (u !== USER_ID_BASE + 253 || t !== counts.teams + 1) bad.push(`next ids are user ${u}, team ${t}`);
    // The migration's unique constraints hold.
    await db.query("begin");
    try {
      await db.query("update teams set stripe_customer_id = (select stripe_customer_id from teams where stripe_customer_id is not null limit 1) where id = (select max(id) from teams where stripe_customer_id is null)");
      bad.push("teams.stripe_customer_id is not unique");
    } catch {
      // expected: teams_stripe_customer_id_unique
    }
    await db.query("rollback");
  } finally {
    await db.end();
  }
  return bad;
}

async function main() {
  const keyPath = join(root, "seed/expected.json");
  const savedKey = existsSync(keyPath) ? readFileSync(keyPath) : null;
  const stripe = await startFakeStripe();
  const pgServer = await localPostgres();
  log(`fake Stripe on ${stripe.apiBase} · Postgres at ${pgServer.url.replace(/:[^:@/]+@/, ":***@")}`);
  const env = { STRIPE_SECRET_KEY: KEY, DATABASE_URL: pgServer.url, STRIPE_SUPPRESS_NOTICES: "true" };
  const tsx = (argv: string[], label: string) => run(["--import", "tsx", "--import", stripeHook(stripe.port), ...argv], env, label);
  const failures: string[] = [];
  try {
    if (args.includes("--main-first")) {
      log("main demo seed first (src/seed.ts), so the switch has its tables to drop");
      const m = await tsx(["src/seed.ts"], "main  ");
      if (m.code !== 0) failures.push(`main seed exited ${m.code}`);
    }
    for (const pass of [1, 2]) {
      log(`starter seed (pass ${pass}${pass === 2 ? ", sweeps pass 1" : ""})`);
      const s = await tsx(["src/starters/saas-starter.ts", "seed"], "seed  ");
      if (s.code !== 0 || !seedOk(s.out)) failures.push(`seed pass ${pass}: exit ${s.code}, did not print 12 · 3 · 5 · $348 with a clean self-check`);
      log("starter verify");
      const v = await tsx(["src/starters/saas-starter.ts", "verify"], "verify");
      if (v.code !== 0 || !verifyOk(v.out)) failures.push(`verify after pass ${pass}: exit ${v.code}, did not read 12 · 3 · 5 · $348`);
    }
    failures.push(...(await inspect(pgServer.url)));
    const key = JSON.parse(readFileSync(keyPath, "utf8"));
    if (key.schema !== STARTER_SCHEMA) failures.push(`answer key schema is ${key.schema}`);
    // A reference apply in the starter's own columns (what a correct fix.py does), then the recount must read zero.
    log("reference apply: sync C, revoke A on teams, cancel B in Stripe");
    {
      const db = new pg.Client({ connectionString: pgServer.url });
      await db.connect();
      try {
        await db.query("begin");
        for (const r of key.stale_subscription_rows) await db.query("update teams set subscription_status = $2, updated_at = now() where id = $1", [Number(r.user_id), r.stripe_status]);
        await db.query("update teams set plan_name = null, stripe_product_id = null, stripe_subscription_id = null, subscription_status = coalesce(subscription_status, 'canceled'), updated_at = now() where id = any($1::int[])", [
          key.pro_without_subscription.map((r: { user_id: string }) => Number(r.user_id)),
        ]);
        await db.query("commit");
      } finally {
        await db.end();
      }
      const sdk = stripe.client();
      for (const r of key.payers_without_account) await sdk.subscriptions.cancel(r.subscription_id);
    }
    const after = await tsx(["src/starters/saas-starter.ts", "verify"], "verify");
    const zero = /A  paid plan nobody pays for +0 /.test(after.out) && /B  paying with no team +0 /.test(after.out) && /C  team rows out of sync +0\b/.test(after.out) && after.out.includes("leak  $0 / month");
    if (after.code !== 0 || !zero || !after.out.includes("· 36 on a paid plan · 36 active or trialing")) failures.push("after the reference apply the recount does not read 0 · 0 · 0 · $0 with 36 paying teams");

    const live = stripe.fake.customers.size;
    const activePro = [...stripe.fake.prices.values()].filter((p) => p.active && p.metadata?.leakfinder_seed === "1");
    log(`fake Stripe after two seeds: ${live} customers · ${activePro.length} active seed price(s) · ${stripe.fake.calls.length} requests · route errors: ${stripe.fake.errors.length}`);
    if (live !== 54) failures.push(`expected 54 customers after the second seed swept the first, found ${live}`);
    if (activePro.length !== 1) failures.push(`expected exactly one active seed price, found ${activePro.length}`);
    if (stripe.fake.errors.length) failures.push(`fake Stripe route errors: ${stripe.fake.errors.join("; ")}`);
    const keep = arg("--keep-key");
    if (keep) copyFileSync(keyPath, keep);
  } finally {
    if (savedKey) writeFileSync(keyPath, savedKey);
    else rmSync(keyPath, { force: true });
    await stripe.close();
    await pgServer.stop();
  }
  if (failures.length) {
    for (const f of failures) log(`FAIL  ${f}`);
    process.exit(1);
  }
  log(`PASS  ${STARTER_SCHEMA}: seed → verify → re-seed → verify: 12 · 3 · 5 · $348 on real Postgres, offline`);
  process.exit(0);
}

main().catch((e) => {
  console.error(`rehearsal failed: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
  process.exit(1);
});
