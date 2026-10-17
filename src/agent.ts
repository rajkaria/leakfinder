/**
 * The loop: the model writes a Python script, the sealed room runs it, the
 * guarded output goes back, until the script reports it is done.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Coder, Transcript, guard, pythonBlock } from "./llm.js";
import { SealedRoom, WORKDIR } from "./sandbox.js";

export const FINDINGS_PATH = `${WORKDIR}/findings.json`;
export const FIX_PATH = `${WORKDIR}/fix.py`;
const DONE = "LEAKFINDER_DONE";
const MAX_TURNS = 6;

const SYSTEM = `You are LeakFinder, a reconciliation engineer. You find entitlement drift between a SaaS app's Postgres database and its Stripe account, by writing Python that runs inside a sealed sandbox. You never see the data yourself: your scripts run where the data is, and only what they print comes back to you.

Rules that are enforced on you:
- Reply with exactly one \`\`\`python block per turn and nothing else outside it except one short sentence.
- Your script runs in /workspace with env vars STRIPE_SECRET_KEY and DATABASE_URL. Libraries available: stripe, psycopg (v3), json, os. Outbound network reaches only api.stripe.com and the database host.
- NEVER print rows, names, emails, or any per-customer value. Print only structure (table and column names), counts, error messages, and Stripe object field names. Anything that looks like an email is redacted before you see it.
- Full findings go to a file, not stdout: write ${FINDINGS_PATH} with this exact shape:
  {"pro_without_subscription": [{"user_id": str, "email": str, "plan": str, "monthly_cents": int, "cause": str}],
   "payers_without_account": [{"stripe_customer_id": str, "subscription_id": str, "monthly_cents": int}],
   "stale_subscription_rows": [{"user_id": str, "subscription_id": str, "app_status": str, "stripe_status": str}],
   "monthly_leak_cents": int, "totals": {"app_users": int, "app_pro_entitlements": int, "stripe_active_subscriptions": int}}
- When the file is written and the counts printed, print the line ${DONE} as the last line.
- Use stripe.Subscription.list(status="all", limit=100, expand=["data.customer"]) and auto_paging_iter() to read every subscription; treat only status active and trialing as paying.
- A "pro entitlement" is whatever the app uses to grant paid access; discover it from the schema first.

Work in stages: (1) print the schema (tables, columns, types) and a count per table, plus the Stripe account's subscription status counts; (2) write the audit that produces the findings file; fix any error you get and run again.`;

export interface AuditOutcome {
  room: SealedRoom;
  turns: number;
  findings: any;
  transcript: Transcript;
  redacted: number;
}

export async function runAudit(runDir: string, log: (line: string) => void): Promise<AuditOutcome> {
  const transcript = new Transcript(runDir);
  const coder = new Coder(SYSTEM, transcript);
  log("opening the sealed room");
  const room = await SealedRoom.open();
  const seal = await room.sealCheck();
  log(`sandbox ${room.id} · egress sealed: ${seal.sealed ? "yes" : "NO"} (${seal.detail})`);

  let prompt =
    "Start with stage 1: discover the Postgres schema and the Stripe subscription status counts. Remember: structure and counts only.";
  let redacted = 0;
  let findings: any = null;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const reply = await coder.ask(prompt);
    const code = pythonBlock(reply);
    if (!code) {
      prompt = "No python block found. Reply with exactly one ```python block.";
      continue;
    }
    const file = `${WORKDIR}/turn${turn}.py`;
    writeFileSync(join(runDir, `turn${turn}.py`), code);
    await room.upload(file, code);
    log(`turn ${turn}: running ${code.split("\n").length} lines of agent-written Python`);
    const r = await room.runPython(file);
    const raw = `${r.stdout}\n${r.stderr}`.slice(0, 12_000);
    const g = guard(raw);
    redacted += g.report.emailsRedacted;
    log(`turn ${turn}: exit ${r.exit_code} in ${(r.ms / 1000).toFixed(1)}s${g.report.emailsRedacted ? ` · ${g.report.emailsRedacted} email(s) redacted before the model saw them` : ""}`);
    if (r.exit_code === 0 && r.stdout.includes(DONE)) {
      findings = JSON.parse(await room.download(FINDINGS_PATH));
      writeFileSync(join(runDir, "findings.json"), JSON.stringify(findings, null, 2));
      return { room, turns: turn, findings, transcript, redacted };
    }
    prompt =
      `Exit code ${r.exit_code}. Output (guarded):\n\n${g.text}\n\n` +
      (r.exit_code === 0
        ? "Good. Continue to the next stage, or finish by writing the findings file and printing the done marker."
        : "Fix the error and send the corrected full script.");
  }
  throw new Error(`audit did not finish in ${MAX_TURNS} turns`);
}

const FIX_SYSTEM_SUFFIX = `

Now write ${FIX_PATH}: a script that repairs the drift. It reads ${FINDINGS_PATH} and, for each finding:
- pro_without_subscription: revoke the paid entitlement in the database, and create a Stripe invoice item + invoice (collection_method send_invoice, days_until_due 7) for one month so they can pay to keep access.
- payers_without_account: refund the latest paid invoice for that subscription and cancel the subscription.
- stale_subscription_rows: update the app's subscription row to Stripe's status.
It MUST honour env var APPLY: when APPLY is not "1", it only prints a plan ("would revoke ...", counts, and the total that would be refunded and invoiced) and changes nothing. When APPLY is "1", it performs the changes and prints what it did. Print counts only; never print emails or names.`;

export async function writeFix(room: SealedRoom, runDir: string, transcript: Transcript, log: (l: string) => void) {
  const coder = new Coder(SYSTEM + FIX_SYSTEM_SUFFIX, transcript);
  const findings = JSON.parse(await room.download(FINDINGS_PATH));
  const counts = {
    pro_without_subscription: findings.pro_without_subscription.length,
    payers_without_account: findings.payers_without_account.length,
    stale_subscription_rows: findings.stale_subscription_rows.length,
    monthly_leak_cents: findings.monthly_leak_cents,
  };
  let prompt = `Findings counts: ${JSON.stringify(counts)}. Write the fix script now. It will be saved as ${FIX_PATH} and run with APPLY unset first.`;
  for (let turn = 1; turn <= 4; turn++) {
    const reply = await coder.ask(prompt);
    const code = pythonBlock(reply);
    if (!code) {
      prompt = "Reply with exactly one ```python block.";
      continue;
    }
    writeFileSync(join(runDir, "fix.py"), code);
    await room.upload(FIX_PATH, code);
    const r = await room.runPython(FIX_PATH, { APPLY: "0" });
    const g = guard(`${r.stdout}\n${r.stderr}`.slice(0, 8000));
    log(`fix draft ${turn}: dry run exit ${r.exit_code} in ${(r.ms / 1000).toFixed(1)}s`);
    if (r.exit_code === 0) return { code, dryRun: r.stdout };
    prompt = `Dry run failed with exit ${r.exit_code}:\n\n${g.text}\n\nFix it and resend the full script.`;
  }
  throw new Error("could not produce a working fix script");
}
