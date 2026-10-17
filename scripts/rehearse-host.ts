/**
 * The real agent loop against your real services, with the room on this
 * machine instead of a CreateOS sandbox: for rehearsing prompts when the
 * sandbox quota is spent. Same model, same guard and transcript, same answer
 * key; the scripts run from a temp dir with a local python3, and /workspace
 * in their code is rewritten to that dir.
 *
 * Not sealed: the agent's code runs on this machine with your credentials and
 * this machine's network. It is read-only all the same: the audit prompt
 * forbids writes and the fix only ever dry-runs here, under vm/dryrun.py
 * (Stripe requests other than GET refused, Postgres read-only).
 *
 *   python3 -m venv .venv && .venv/bin/pip install stripe "psycopg[binary]"
 *   LEAKFINDER_HOST_PYTHON=.venv/bin/python3 pnpm rehearse:host [--fresh] [--skills <dir>]
 *
 * Saved skills go to runs/host-skills unless --skills says otherwise, so a
 * rehearsal never changes what `pnpm scan` runs.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runAudit, writeFix } from "../src/agent.js";
import { env } from "../src/env.js";
import { guard } from "../src/llm.js";
import { WORKDIR, type RunResult } from "../src/sandbox.js";
import { loadExpected, scoreAgainstExpected, scoreTotals } from "../src/score.js";
import { SkillStore } from "../src/skills.js";

const args = process.argv.slice(2);
const arg = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const fresh = args.includes("--fresh");
const PY = resolve(process.env.LEAKFINDER_HOST_PYTHON || "python3");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join("runs", `host-${stamp}`);
const box = mkdtempSync(join(tmpdir(), "leakfinder-host-"));
const t0 = Date.now();
const log = (l: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s  ${l}`);
const map = (s: string) => s.replaceAll(WORKDIR, box);

const check = spawnSync(PY, ["-c", "import stripe, psycopg; stripe.InvoicePayment; print(stripe.VERSION)"], { encoding: "utf8" });
if (check.status !== 0) {
  console.error(`${PY} cannot import stripe (with InvoicePayment) and psycopg. Make a venv:\n  python3 -m venv .venv && .venv/bin/pip install stripe "psycopg[binary]"\n  LEAKFINDER_HOST_PYTHON=.venv/bin/python3 pnpm rehearse:host`);
  process.exit(2);
}

/** The parts of SealedRoom the loop uses, on this machine. */
class HostRoom {
  id = `host-${stamp}`;
  egress = ["not sealed: host rehearsal"];
  async exec(shell: string, timeoutMs = 120_000): Promise<RunResult> {
    const t = Date.now();
    const r = spawnSync("bash", ["-c", map(shell)], {
      cwd: box,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: { PATH: `${dirname(PY)}:/usr/bin:/bin`, HOME: box, PYTHONUNBUFFERED: "1", STRIPE_SECRET_KEY: env.stripeKey(), DATABASE_URL: env.databaseUrl() },
    });
    const timedOut = r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    return { stdout: r.stdout ?? "", stderr: `${r.stderr ?? ""}${timedOut ? `\ntimed out after ${Math.ceil(timeoutMs / 1000)}s` : ""}`, exit_code: timedOut ? 124 : (r.status ?? 1), ms: Date.now() - t };
  }
  async runPython(path: string, extraEnv: Record<string, string> = {}, timeoutMs = 180_000): Promise<RunResult> {
    const assigns = Object.entries(extraEnv).map(([k, v]) => `${k}='${v.replace(/'/g, "'\\''")}'`);
    return this.exec(`cd ${WORKDIR} && ${assigns.length ? `env ${assigns.join(" ")} ` : ""}${PY} '${path}'`, timeoutMs);
  }
  async upload(path: string, content: string) {
    mkdirSync(dirname(map(path)), { recursive: true });
    writeFileSync(map(path), map(content));
  }
  async download(path: string) {
    return readFileSync(map(path), "utf8");
  }
  async sealCheck() {
    return { sealed: false, detail: "host rehearsal: no seal, read-only by prompt and by the dry-run harness", stripeReachable: true };
  }
  async destroy() {}
}

const skills = new SkillStore(arg("--skills") ?? join("runs", "host-skills"));
const room = new HostRoom();
log(`host rehearsal · model ${env.model()} · python ${check.stdout.trim() ? `stripe ${check.stdout.trim()}` : PY}`);
const out = await runAudit(runDir, log, { fresh }, { openRoom: async () => room as never, skills });
const f = out.findings;
const expected = loadExpected();
if (expected) {
  const s = scoreAgainstExpected(f, expected);
  const t = scoreTotals(s);
  log(`${t.found} of ${t.planted} planted found · ${t.extra} extra · A ${s.pro_without_subscription.found}/${s.pro_without_subscription.planted} · B ${s.payers_without_account.found}/${s.payers_without_account.planted} · C ${s.stale_subscription_rows.found}/${s.stale_subscription_rows.planted}`);
}
let failed = false;
try {
  const fix = await writeFix(room as never, runDir, out.transcript, log, { fresh }, { skills });
  console.log(guard(fix.dryRun).text);
} catch (e) {
  failed = true;
  log(`no working fix script: ${e instanceof Error ? e.message : e}`);
}
log(`${out.turns} audit turns · ${out.rewrites} rewrites · ${out.transcript.inputTokens.toLocaleString("en-US")} tokens in, ${out.transcript.outputTokens.toLocaleString("en-US")} out · ${runDir}`);
process.exit(failed ? 1 : 0);
