import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAudit, writeFix, FIX_PATH } from "./agent.js";
import { writeReport } from "./report.js";
import { SealedRoom, sealedEgress } from "./sandbox.js";
import { guard } from "./llm.js";
import { env } from "./env.js";

const t0 = Date.now();
const log = (line: string) => console.log(`\x1b[2m${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s\x1b[0m  ${line}`);
const RUNS = "runs";
const LAST = join(RUNS, "last.json");

async function audit() {
  const runDir = join(RUNS, new Date().toISOString().replace(/[:.]/g, "-"));
  log(`egress allowlist: ${sealedEgress().join(", ")}`);
  const out = await runAudit(runDir, log);
  const f = out.findings;
  log(`findings: ${f.pro_without_subscription.length} with Pro and no subscription · ${f.payers_without_account.length} paying with no account · ${f.stale_subscription_rows.length} rows out of sync`);
  log(`\x1b[1m$${(f.monthly_leak_cents / 100).toFixed(0)}/month leaking\x1b[0m`);
  log(`model saw ${out.transcript.inputTokens.toLocaleString()} input tokens; ${out.redacted} email(s) redacted on the way`);

  log("asking the agent for the fix script (dry run)");
  const fix = await writeFix(out.room, runDir, out.transcript, log);
  console.log(guard(fix.dryRun).text.trim().split("\n").map((l) => `         │ ${l}`).join("\n"));

  const report = writeReport(runDir, f, {
    sandboxId: out.room.id,
    turns: out.turns,
    inputTokens: out.transcript.inputTokens,
    redacted: out.redacted,
    transcriptPath: out.transcript.path,
  });
  writeFileSync(LAST, JSON.stringify({ runDir, sandboxId: out.room.id }));
  log(`report: ${report}`);
  log(`transcript: ${out.transcript.path}`);
  if (existsSync("seed/expected.json")) {
    const target = JSON.parse(readFileSync("seed/expected.json", "utf8")).grep_target_email;
    const hits = readFileSync(out.transcript.path, "utf8").split(target).length - 1;
    log(`grep "${target}" transcript → ${hits} hit(s)`);
  }
  log(`sandbox ${out.room.id} left running for apply (run: pnpm apply)`);
}

async function apply() {
  const last = JSON.parse(readFileSync(LAST, "utf8"));
  const room = await SealedRoom.attach(last.sandboxId);
  log(`forking ${room.id} so the dry run happens in a copy and the original stays untouched`);
  const copy = await room.pauseAndFork();
  log(`fork ${copy.id} running · dry run`);
  const dry = await copy.runPython(FIX_PATH, { APPLY: "0" });
  console.log(guard(dry.stdout).text.trim().split("\n").map((l) => `         │ ${l}`).join("\n"));
  await copy.destroy();
  if (process.argv.includes("--yes")) {
    log("APPLY=1 in the original sandbox");
    const real = await room.runPython(FIX_PATH, { APPLY: "1" });
    console.log(guard(real.stdout + real.stderr).text.trim().split("\n").map((l) => `         │ ${l}`).join("\n"));
    log(`exit ${real.exit_code}`);
  } else {
    log("re-run with --yes to apply");
  }
}

async function doctor() {
  log(`model: ${env.model()}`);
  const me = await SealedRoom.client().whoami();
  log(`createos: ${JSON.stringify(me)}`);
  const room = await SealedRoom.open({ name: `leakfinder-doctor-${Date.now().toString(36)}` });
  const seal = await room.sealCheck();
  log(`sandbox ${room.id} · sealed: ${seal.sealed} (${seal.detail})`);
  const s = await room.exec(`python3 -c "import stripe,os; print(len(stripe.Subscription.list(limit=1, api_key=os.environ['STRIPE_SECRET_KEY']).data))"`);
  log(`stripe from inside: exit ${s.exit_code} ${s.stdout.trim()} ${s.stderr.trim().slice(0, 200)}`);
  const d = await room.exec(`python3 -c "import psycopg,os; c=psycopg.connect(os.environ['DATABASE_URL']); print(c.execute('select count(*) from users').fetchone())"`);
  log(`postgres from inside: exit ${d.exit_code} ${d.stdout.trim()} ${d.stderr.trim().slice(0, 200)}`);
  await room.destroy();
  log("destroyed");
}

const cmd = process.argv[2];
const run = { audit, apply, doctor }[cmd as "audit" | "apply" | "doctor"];
if (!run) {
  console.error("usage: tsx src/cli.ts audit|apply [--yes]|doctor");
  process.exit(2);
}
run().catch((e) => {
  console.error(e);
  process.exit(1);
});
