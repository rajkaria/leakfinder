/**
 * The loop: the model writes a Python script, the sealed room runs it, the
 * guarded output goes back, until the script reports it is done. The model is
 * shown only code, schema names, counts and error text; findings stay in a
 * file inside the room.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Coder, type CoderLike, Transcript, guard, intentLine, pythonBlock } from "./llm.js";
import { SealedRoom, WORKDIR, type RunResult, type SealCheck } from "./sandbox.js";
import { PROBE_PY, SkillStore, fingerprint, schemaShape } from "./skills.js";
import { normalizeFindings, parseSummary, SUMMARY_MARKER, type Findings, type FixSummary } from "./types.js";
import { env } from "./env.js";

export const FINDINGS_PATH = `${WORKDIR}/findings.json`;
export const FIX_PATH = `${WORKDIR}/fix.py`;
/** vm/dryrun.py, next to fix.py: runs it with APPLY=0 so that no Stripe write or database write can happen. */
export const DRYRUN_PATH = `${WORKDIR}/leakfinder_dryrun.py`;
const DRYRUN_SRC = new URL("../vm/dryrun.py", import.meta.url);
export const DONE = "LEAKFINDER_DONE";
export const MAX_TURNS = 8;
const FIX_TURNS = 4;
const PROBE_PATH = `${WORKDIR}/leakfinder_probe.py`;
const SKILL_PATH = `${WORKDIR}/skill_audit.py`;

const SYSTEM = `You are LeakFinder, a reconciliation engineer. You find entitlement drift between a SaaS app's Postgres database and its Stripe account, by writing Python that runs inside a sealed sandbox. You never see the data yourself: your scripts run where the data is, and only what they print comes back to you.

Rules that are enforced on you:
- Each reply is one short sentence saying what this script does, then exactly one \`\`\`python block. Nothing else.
- Your script runs in ${WORKDIR} with env vars STRIPE_SECRET_KEY and DATABASE_URL. Libraries: stripe, psycopg (v3), and the standard library. Outbound network reaches only api.stripe.com and the database host; anything else fails.
- NEVER print rows, names, emails, ids or any per-customer value. Print only structure (table and column names, types), counts, sums, error messages, and Stripe object field names. Emails are redacted and long output is truncated before you see it.
- Full findings go to a file, not stdout: write ${FINDINGS_PATH} with this exact shape:
  {"pro_without_subscription": [{"user_id": str, "email": str, "plan": str, "monthly_cents": int, "cause": "never_paid" | "cancelled_unsynced" | "other"}],
   "payers_without_account": [{"stripe_customer_id": str, "subscription_id": str, "monthly_cents": int}],
   "stale_subscription_rows": [{"user_id": str, "subscription_id": str, "app_status": str, "stripe_status": str}],
   "monthly_leak_cents": int, "totals": {"app_users": int, "app_pro_entitlements": int, "stripe_active_subscriptions": int}}
  monthly_leak_cents is the sum of monthly_cents over pro_without_subscription. totals.stripe_active_subscriptions counts subscriptions whose status is active or trialing.
- When the file is written and the counts printed, print the line ${DONE} as the last line. Only do that from a script that runs the whole audit from scratch on its own: that final script is saved and re-run as-is on the next audit of this schema.
- Stripe: set stripe.api_key = os.environ["STRIPE_SECRET_KEY"]. Read every subscription with stripe.Subscription.list(status="all", limit=100).auto_paging_iter(); sub.customer is the customer id. stripe-python objects are not dicts: use attribute or [] access (sub.status, sub["items"].data, obj.metadata["k"] after checking "k" in obj.metadata), never obj.get(...). Only status active and trialing count as paying. On the current API, current_period_end lives on subscription items (sub["items"].data[0].current_period_end), not on the subscription; read price amounts from sub["items"].data[i].price.unit_amount times quantity, per month. A pro user with no Stripe subscription is still worth the plan's monthly price: take it from the app's own price data, or, if the app stores none, from the active Stripe price of that plan (stripe.Price.list(active=True)).
- A "pro entitlement" is whatever the app uses to grant paid access; discover it from the schema first. Never write to the database or to Stripe during the audit.
- What each list holds:
  pro_without_subscription: every paid entitlement the app grants (a paid plan with a status the app treats as paying) that has no active or trialing Stripe subscription behind it. cause "never_paid": the app links no Stripe subscription, or one Stripe does not have; "cancelled_unsynced": the linked subscription is canceled in Stripe while the app still grants access. If the app bills per team, account or organization, list one entry per paying entity, never one per member: user_id is that entity's id and email its owner's. monthly_cents is the plan's monthly price and never 0: match the app's stored product or price id, or its plan name against the Stripe Product name (stripe.Price.list(active=True, expand=["data.product"])).
  payers_without_account: active or trialing Stripe subscriptions whose customer no app row links to.
  stale_subscription_rows: app rows whose stored subscription status differs from the status Stripe reports for the same subscription id (for example the app says active, Stripe says canceled). A row can be here and in pro_without_subscription at once.
- The books must balance: totals.app_pro_entitlements minus len(pro_without_subscription) equals totals.stripe_active_subscriptions minus len(payers_without_account) whenever each paying entity has one subscription. Count both sides the same way (per entity) and print both.

Work in stages: (1) print the schema (tables, columns, types), a row count per table, stripe.VERSION and stripe.api_version, and the Stripe subscription counts by status; (2) write the audit that produces the findings file; if you get an error, fix it and send the corrected full script.`;

const FIX_SYSTEM_SUFFIX = `

Now you write the fix script. It is saved as ${FIX_PATH} and runs in the same sealed room, from ${WORKDIR}, with the same env vars. It reads ${FINDINGS_PATH} (the file your audit wrote) and repairs each finding. LeakFinder checks the rules below and rejects a script that breaks them.

Modes
- APPLY = os.environ.get("APPLY") == "1". When APPLY is false, change nothing anywhere: no Stripe writes, no database writes. Every read (Stripe list and retrieve calls, database SELECTs) runs in both modes; gate only the writes themselves on APPLY, so the dry run counts exactly what APPLY would do. LeakFinder runs the dry run with every Stripe request other than GET refused and the database session read-only, so an ungated write fails the script. When APPLY is true, do it.
- First thing: if APPLY is true and STRIPE_SECRET_KEY does not start with "sk_test_" or "rk_test_", print one line saying the key is not a test-mode key and exit with code 3 before touching anything.

What to do per finding (in this order: pro_without_subscription, then payers_without_account, then stale_subscription_rows, so a revoke is counted before a row sync changes the same record)
- pro_without_subscription: revoke the paid entitlement in the database (the table you found in the audit; set it to the free plan or delete the row, whichever matches how the app represents no paid access). Change only what grants the access, such as the plan; leave subscription id and status columns to the stale_subscription_rows step, which sets them to Stripe's status. If cause is "cancelled_unsynced", stop there: they cancelled in Stripe on purpose, so never bill them. Otherwise (they never paid), bill one month so they can pay to keep access. Find the user's Stripe customer through the app's customer mapping; if there is none, create one with stripe.Customer.create(email=<the user's email from the database>, metadata={"leakfinder_user_id": user_id}). Create the invoice first and attach the item to it (pending items are not pulled into new invoices automatically):
    inv = stripe.Invoice.create(customer=cus, collection_method="send_invoice", days_until_due=7, auto_advance=False, metadata={"leakfinder_user_id": user_id}, idempotency_key=...)
    stripe.InvoiceItem.create(customer=cus, invoice=inv.id, amount=monthly_cents, currency="usd", description="Pro plan, one month", idempotency_key=...)
    stripe.Invoice.finalize_invoice(inv.id, idempotency_key=...)
    stripe.Invoice.send_invoice(inv.id, idempotency_key=...)
- payers_without_account: refund the latest paid payment for that subscription, then cancel the subscription. Since API version 2025-03-31.basil, Invoice.charge and Invoice.payment_intent do not exist: do not use them. A payment hangs off the invoice as an InvoicePayment:
    inv = next(iter(stripe.Invoice.list(subscription=sub_id, status="paid", limit=1).data), None)   # newest first
    pays = stripe.InvoicePayment.list(invoice=inv.id, status="paid").data
    p = pays[0].payment   # p.type is "payment_intent" (use p.payment_intent) or "charge" (use p.charge)
    stripe.Refund.create(payment_intent=<id>, amount=pays[0].amount_paid, metadata={"leakfinder_subscription_id": sub_id}, idempotency_key=...)   # or charge=<id>
  Skip the refund when there is no paid invoice or nothing was paid. Then stripe.Subscription.cancel(sub_id) unless its status is already "canceled".
- stale_subscription_rows: set the app's subscription row status to stripe_status (and updated_at, if the table has it).

Idempotency: the script may run twice, and the second run must change nothing.
- Pass idempotency_key on every Stripe create, finalize and send call, derived from a hash of the findings file and the object id. Stripe keeps a key for 24 hours and rejects it when it comes back with different parameters, and a re-seeded database has new Stripe customers under the same ids, so the key must change when the findings change and stay the same when this script re-runs on the same findings:
    RUN = hashlib.sha256(open("${FINDINGS_PATH}", "rb").read()).hexdigest()[:12]
    f"leakfinder-{RUN}-customer-{user_id}", f"leakfinder-{RUN}-invoice-{user_id}", f"leakfinder-{RUN}-invoiceitem-{user_id}", f"leakfinder-{RUN}-finalize-{user_id}", f"leakfinder-{RUN}-send-{user_id}", f"leakfinder-{RUN}-refund-{subscription_id}". Subscription.cancel is a DELETE, where keys have no effect, so check the status instead.
- Never swallow a Stripe error with a bare except: let it fail the script, so a half-done apply is visible.
- Also check state before each action, so a re-run days later is still a no-op: skip a user whose entitlement is already revoked; skip the invoice when stripe.Invoice.list(customer=cus, limit=100) already has one whose metadata leakfinder_user_id is that user; skip the refund when stripe.Refund.list(payment_intent=<id>) (or charge=<id>) already has one; skip the cancel when the subscription is already canceled; skip a row already at Stripe's status.
- Do all database writes in one transaction, committed only when APPLY is true.

Output
- Print counts and totals only: one line per action type. Never an email, a name, or a per-customer id or amount.
- The last line must be exactly ${SUMMARY_MARKER} followed by a space and one JSON object with every one of these keys:
  {"mode": "dry_run" or "applied", "revoked": int, "invoices": int, "invoiced_cents": int, "refunds": int, "refunded_cents": int, "cancelled": int, "rows_synced": int, "leak_closed_cents": int}
  In dry-run mode the counts are what would happen. leak_closed_cents is the sum of monthly_cents over the entitlements revoked (or that would be). Items skipped because they were already done do not count.`;

/** The parts of the room the loop uses; tests pass a fake. */
export type Room = Pick<SealedRoom, "id" | "exec" | "runPython" | "upload" | "download" | "sealCheck" | "destroy">;

export interface AgentDeps {
  openRoom?: (opts: { ingress?: boolean }) => Promise<Room>;
  coder?: (system: string, transcript: Transcript) => CoderLike;
  skills?: SkillStore;
}

export interface AuditOutcome {
  room: SealedRoom;
  seal: SealCheck;
  turns: number;
  /** Turns that exited non-zero or failed validation, each followed by a rewrite. */
  rewrites: number;
  reusedSkill: boolean;
  findings: Findings;
  transcript: Transcript;
  redacted: number;
}

/** What writeFix needs to know about the audit that ran in this room. */
const audited = new WeakMap<object, { fp: string | null; fresh: boolean; auditCode?: string }>();

const fenced = (code: string) => `\`\`\`python\n${code.endsWith("\n") ? code : `${code}\n`}\`\`\``;
const secs = (r: RunResult) => `${(r.ms / 1000).toFixed(1)}s`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/** Refuse to apply with anything but a Stripe test-mode key. Call before every APPLY=1. */
export function assertTestKey(key: string = env.stripeKey()): void {
  if (!/^(sk|rk)_test_/.test(key)) {
    throw new Error("refusing to apply: STRIPE_SECRET_KEY is not a test-mode key (sk_test_ or rk_test_)");
  }
}

/**
 * The line of a failed run worth showing: the exception, without its module
 * path (`UndefinedColumn: column "x" does not exist`). Guarded, one line.
 */
export function errorLine(r: Pick<RunResult, "stdout" | "stderr" | "exit_code">): string {
  const pick = (text: string) => {
    const lines = text.split("\n").map((l) => l.trimEnd());
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/^([A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*):\s+(.+)$/);
      if (m && !/^[A-Z]+$/.test(m[1])) return `${m[1].split(".").pop()}: ${m[2]}`;
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/^([A-Za-z_][\w.]*(?:Error|Exception|Interrupt|Exit))$/);
      if (m) return m[1].split(".").pop()!;
    }
    return lines.filter((l) => l.trim()).pop()?.trim() ?? "";
  };
  const line = pick(r.stderr) || pick(r.stdout) || `exit ${r.exit_code} with no output`;
  const g = guard(line, Number.MAX_SAFE_INTEGER).text;
  return g.length > 160 ? `${g.slice(0, 159)}…` : g;
}

/** Validate agent-written findings without echoing any of their content back. */
export function checkFindings(text: string | null): { findings: Findings } | { problem: string } {
  if (text == null) return { problem: `${FINDINGS_PATH} was not written` };
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return { problem: `${FINDINGS_PATH} is not valid JSON` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { problem: `${FINDINGS_PATH} is not a JSON object` };
  const lists = ["pro_without_subscription", "payers_without_account", "stale_subscription_rows"];
  const missing = lists.filter((k) => !Array.isArray(raw[k]));
  if (missing.length) return { problem: `${FINDINGS_PATH} is missing the list(s) ${missing.join(", ")}` };
  if (!Number.isFinite(Number(raw.monthly_leak_cents))) return { problem: `${FINDINGS_PATH} has no numeric monthly_leak_cents` };
  return { findings: normalizeFindings(raw) };
}

/**
 * Counts-only sanity checks on valid findings: a list that cannot be right on any schema. The message names
 * counts, never a value, so it can go back to the model. The loop raises it on every changed script and accepts
 * findings that do not reconcile only when the agent resends the same script (real data can have two
 * subscriptions per customer).
 */
export function reconcileProblem(f: Findings): string | null {
  const a = f.pro_without_subscription;
  const problems: string[] = [];
  const unpriced = a.filter((x) => !(x.monthly_cents > 0)).length;
  if (unpriced) problems.push(`${unpriced} of the ${a.length} pro_without_subscription entries have monthly_cents 0; price each at its plan's monthly price`);
  const dupes = a.length - new Set(a.map((x) => x.user_id)).size;
  if (dupes) problems.push(`pro_without_subscription repeats ${dupes} user_id value${dupes === 1 ? "" : "s"}; list each paying entity once`);
  const { app_pro_entitlements: e, stripe_active_subscriptions: s } = f.totals;
  if (e > 0 && s > 0 && e - a.length !== s - f.payers_without_account.length) {
    problems.push(
      `the books do not balance: app_pro_entitlements ${e} - pro_without_subscription ${a.length} = ${e - a.length}, but stripe_active_subscriptions ${s} - payers_without_account ${f.payers_without_account.length} = ${s - f.payers_without_account.length}; every entitlement the app grants (paid plan and paying status, whatever Stripe says) is either backed by one active or trialing subscription or is in pro_without_subscription, and every active or trialing subscription either backs one entitlement or is in payers_without_account`,
    );
  }
  return problems.length ? problems.join("; ") : null;
}

/** The guard's work is a demo beat of its own: say what it removed before the model saw anything. */
function logGuard(log: (l: string) => void, who: string, g: { emailsRedacted: number; truncatedChars: number }) {
  const parts = [
    g.emailsRedacted ? `${plural(g.emailsRedacted, "email")} redacted` : "",
    g.truncatedChars ? `${g.truncatedChars.toLocaleString("en-US")} chars truncated` : "",
  ].filter(Boolean);
  if (parts.length) log(`${who}: guard · ${parts.join(" · ")} before the model saw the output`);
}

const countsOf = (f: Findings) =>
  `${plural(f.pro_without_subscription.length, "Pro user")} with no paying subscription · ${plural(f.payers_without_account.length, "payer")} with no account · ${plural(f.stale_subscription_rows.length, "row")} out of sync · ${money(f.monthly_leak_cents)}/month`;

async function tryDownload(room: Room, path: string): Promise<string | null> {
  try {
    return await room.download(path);
  } catch {
    return null;
  }
}

/** Fingerprint the schema with LeakFinder's own probe. The probe output never reaches the model. */
async function probeSchema(room: Room, log: (l: string) => void): Promise<{ fp: string; tables: number; columns: number } | null> {
  await room.upload(PROBE_PATH, PROBE_PY);
  const r = await room.runPython(PROBE_PATH, {}, 60_000);
  if (r.exit_code !== 0 || !r.stdout.trim()) {
    log(`schema probe failed (${errorLine(r)}) · saved skills are off for this run`);
    return null;
  }
  const fp = fingerprint(r.stdout);
  const shape = schemaShape(r.stdout);
  log(`schema fingerprint ${fp} · ${shape.tables} tables, ${shape.columns} columns (names only, kept local)`);
  return { fp, ...shape };
}

type Attempt =
  | { ok: true; findings: Findings; r: RunResult; out: ReturnType<typeof guard> }
  | { ok: false; r: RunResult; out: ReturnType<typeof guard>; why: string; error: boolean };

/** Run one audit script and judge it. Stale findings are removed first, so DONE must come with its own file. */
async function attempt(room: Room, path: string, code: string): Promise<Attempt> {
  await room.upload(path, code);
  await room.exec(`rm -f ${FINDINGS_PATH}`);
  const r = await room.runPython(path);
  const out = guard(`${r.stdout}\n${r.stderr}`.trim());
  if (r.exit_code !== 0) return { ok: false, r, out, why: errorLine(r), error: true };
  if (!r.stdout.includes(DONE)) return { ok: false, r, out, why: "no done marker yet", error: false };
  const check = checkFindings(await tryDownload(room, FINDINGS_PATH));
  if ("problem" in check) return { ok: false, r, out, why: `printed ${DONE} but ${check.problem}`, error: true };
  return { ok: true, findings: check.findings, r, out };
}

export async function runAudit(
  runDir: string,
  log: (line: string) => void,
  opts: { fresh?: boolean; ingress?: boolean } = {},
  deps: AgentDeps = {},
): Promise<AuditOutcome> {
  mkdirSync(runDir, { recursive: true });
  const transcript = new Transcript(runDir);
  const store = deps.skills ?? new SkillStore();
  log("opening the sealed room");
  const room = await (deps.openRoom ?? ((o) => SealedRoom.open(o)))({ ingress: opts.ingress });
  try {
    const seal = await room.sealCheck();
    log(`sandbox ${room.id} · ${seal.sealed ? "egress sealed" : "EGRESS NOT SEALED"} · ${seal.detail}`);
    if (!seal.stripeReachable) log("warning: api.stripe.com did not answer from inside the room; the audit will likely fail");

    const schema = await probeSchema(room, log);
    const fp = schema?.fp ?? null;
    audited.set(room, { fp, fresh: !!opts.fresh });
    let redacted = 0;
    const done = (findings: Findings, code: string, turns: number, rewrites: number, reusedSkill: boolean): AuditOutcome => {
      audited.set(room, { fp, fresh: !!opts.fresh, auditCode: code });
      writeFileSync(join(runDir, "findings.json"), JSON.stringify(findings, null, 2));
      log(`findings: ${countsOf(findings)}`);
      return { room: room as SealedRoom, seal, turns, rewrites, reusedSkill, findings, transcript, redacted };
    };

    let prompt =
      "Start with stage 1: discover the Postgres schema and the Stripe subscription status counts. Remember: structure and counts only.";
    const saved = fp && !opts.fresh ? store.audit(fp) : null;
    if (fp && saved) {
      log(`saved skill found for this schema · running skills/${fp}.py before asking the model`);
      writeFileSync(join(runDir, "skill_audit.py"), saved);
      const a = await attempt(room, SKILL_PATH, saved);
      redacted += a.out.report.emailsRedacted;
      if (a.ok) {
        log(`skill: exit 0 · ${secs(a.r)} · valid findings · 0 model turns`);
        transcript.log({ kind: "skill", fingerprint: fp, note: "saved audit script ran and passed; no model call was made" });
        return done(a.findings, saved, 0, 0, true);
      }
      logGuard(log, "skill", a.out.report);
      log(`skill: exit ${a.r.exit_code} · ${secs(a.r)} · ${a.why} → asking the agent`);
      prompt =
        `A script you wrote on an earlier audit of what looked like this same schema no longer passes.\n\n` +
        `${fenced(saved)}\n\nIt exited ${a.r.exit_code}: ${a.why}. Output (guarded):\n\n${a.out.text}\n\n` +
        "Fix it and send the corrected full script, or start again from stage 1 if the schema has changed.";
    } else if (fp && opts.fresh && store.audit(fp)) {
      log("--fresh: ignoring the saved skill for this schema");
    }

    const coder = (deps.coder ?? ((s, t) => new Coder(s, t)))(SYSTEM, transcript);
    let rewrites = 0;
    let rejected: string | null = null;
    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      const reply = await coder.ask(prompt);
      const intent = intentLine(reply);
      if (intent) log(`turn ${turn}: ${intent}`);
      const code = pythonBlock(reply);
      if (!code) {
        rewrites++;
        log(`turn ${turn}: no complete python block in the reply → asking again`);
        prompt = "No complete ```python block found (a reply that is too long gets cut off). Reply with one short sentence and exactly one complete ```python block.";
        continue;
      }
      writeFileSync(join(runDir, `turn${turn}.py`), code);
      log(`turn ${turn}: running ${code.trimEnd().split("\n").length} lines of agent-written Python`);
      const a = await attempt(room, `${WORKDIR}/turn${turn}.py`, code);
      redacted += a.out.report.emailsRedacted;
      logGuard(log, `turn ${turn}`, a.out.report);
      // A resend of the script that was just rejected is the agent saying the counts are right for this schema.
      const off = a.ok && code !== rejected && turn < MAX_TURNS ? reconcileProblem(a.findings) : null;
      if (a.ok && off) {
        rejected = code;
        rewrites++;
        log(`turn ${turn}: exit 0 · ${secs(a.r)} · ${DONE} · counts do not reconcile → agent rewriting`);
        prompt =
          `Exit code 0 and ${FINDINGS_PATH} was written, but LeakFinder's counts-only check failed: ${off}. Output (guarded):\n\n${a.out.text}\n\n` +
          `Re-read the definitions of the three lists, fix the audit, and send the corrected full script. If the counts are right for this schema, send the same script again and say why in your sentence.`;
        continue;
      }
      if (a.ok) {
        log(`turn ${turn}: exit 0 · ${secs(a.r)} · ${DONE} · findings.json valid (never shown to the model)`);
        if (fp) {
          store.saveAudit(fp, code, { model: env.model(), turns: turn, rewrites, tables: schema!.tables, columns: schema!.columns });
          log(`saved this script as skills/${fp}.py · the next audit of this schema runs it first`);
        }
        return done(a.findings, code, turn, rewrites, false);
      }
      if (a.error) {
        rewrites++;
        log(`turn ${turn}: exit ${a.r.exit_code} · ${secs(a.r)} · ${a.why} → agent rewriting`);
        prompt =
          `Exit code ${a.r.exit_code}${a.r.exit_code === 0 ? ` (${a.why})` : ""}. Output (guarded):\n\n${a.out.text}\n\n` +
          "Fix it and send the corrected full script.";
      } else {
        log(`turn ${turn}: exit 0 · ${secs(a.r)} · ${plural(a.r.stdout.trim() ? a.r.stdout.trim().split("\n").length : 0, "line")} of output back to the model`);
        prompt =
          `Exit code 0. Output (guarded):\n\n${a.out.text}\n\n` +
          `Good. Continue to the next stage, or finish: write ${FINDINGS_PATH}, print the counts, and print ${DONE} as the last line, from one script that runs the whole audit on its own.`;
      }
    }
    throw new Error(`audit did not finish in ${MAX_TURNS} turns`);
  } catch (e) {
    // A leaked room blocks the next run on the Free plan (one concurrent sandbox).
    log(`audit failed · destroying sandbox ${room.id}`);
    await room.destroy();
    throw e;
  }
}

const summaryLine = (p: FixSummary) =>
  `${p.mode === "applied" ? "" : "would "}invoice ${money(p.invoiced_cents)} to ${plural(p.invoices, "user")} · refund ${money(p.refunded_cents)} to ${plural(p.refunds, "payer")} · revoke ${p.revoked} · cancel ${p.cancelled} · sync ${plural(p.rows_synced, "row")} · ${money(p.leak_closed_cents)}/month closed`;

type FixRun = { r: RunResult; out: ReturnType<typeof guard>; plan: FixSummary | null; why: string | null };

/** Cheap static checks for the contract rules a dry run cannot exercise. */
export function fixRuleGaps(code: string): string | null {
  const gaps = [
    /APPLY/.test(code) ? "" : "it never reads APPLY",
    /sk_test_/.test(code) && /rk_test_/.test(code) ? "" : "it does not refuse keys that are not sk_test_ or rk_test_",
    /idempotency_key/.test(code) ? "" : "its Stripe calls pass no idempotency_key",
    /sha256/.test(code) ? "" : "its idempotency keys do not include the hash of the findings file (a key reused after a re-seed fails in Stripe)",
    code.includes(SUMMARY_MARKER) ? "" : `it never prints ${SUMMARY_MARKER}`,
  ].filter(Boolean);
  return gaps.length ? `rejected before running: ${gaps.join("; ")}` : null;
}

/**
 * Run the fix.py already in the room with APPLY=0, through vm/dryrun.py: the script is not trusted to honour
 * APPLY, so its non-GET Stripe requests are refused in-process and its Postgres sessions are read-only.
 */
export async function runDryRun(room: Pick<Room, "upload" | "runPython">): Promise<RunResult> {
  await room.upload(DRYRUN_PATH, readFileSync(DRYRUN_SRC, "utf8"));
  return room.runPython(DRYRUN_PATH, { APPLY: "0" });
}

/** A plan that does more than the findings allow is wrong whatever the schema: counts only, safe to show the model. */
export function planProblem(p: FixSummary, f: Findings): string | null {
  const a = f.pro_without_subscription.length;
  const b = f.payers_without_account.length;
  const c = f.stale_subscription_rows.length;
  const over = [
    p.revoked > a ? `revoked ${p.revoked} > ${a} pro_without_subscription` : "",
    p.invoices > a ? `invoices ${p.invoices} > ${a} pro_without_subscription` : "",
    p.refunds > b ? `refunds ${p.refunds} > ${b} payers_without_account` : "",
    p.cancelled > b ? `cancelled ${p.cancelled} > ${b} payers_without_account` : "",
    p.rows_synced > c ? `rows_synced ${p.rows_synced} > ${c} stale_subscription_rows` : "",
    p.leak_closed_cents > f.monthly_leak_cents ? `leak_closed_cents ${p.leak_closed_cents} > monthly_leak_cents ${f.monthly_leak_cents}` : "",
  ].filter(Boolean);
  return over.length ? `the plan does more than the findings allow: ${over.join("; ")}` : null;
}

async function dryRun(room: Room, code: string, f?: Findings): Promise<FixRun> {
  const gap = fixRuleGaps(code);
  if (gap) return { r: { stdout: "", stderr: "", exit_code: 0, ms: 0 }, out: guard(""), plan: null, why: gap };
  await room.upload(FIX_PATH, code);
  const r = await runDryRun(room);
  const out = guard(`${r.stdout}\n${r.stderr}`.trim());
  const plan = parseSummary(r.stdout);
  let why: string | null = null;
  if (r.exit_code !== 0) why = errorLine(r);
  else if (!plan) why = `exit 0 but the last line was not ${SUMMARY_MARKER} {json}`;
  else if (plan.mode !== "dry_run") why = `the dry run reported mode "${plan.mode}"; with APPLY unset it must be "dry_run" and change nothing`;
  else if (f) why = planProblem(plan, f);
  return { r, out, plan, why };
}

/**
 * Ask the agent for fix.py and dry-run it in the room (APPLY=0). Returns the
 * code, the guarded dry-run output and the parsed plan. A saved fix for this
 * schema is tried first unless the audit ran with --fresh.
 */
export async function writeFix(
  room: SealedRoom,
  runDir: string,
  transcript: Transcript,
  log: (l: string) => void,
  opts: { fresh?: boolean } = {},
  deps: AgentDeps = {},
): Promise<{ code: string; dryRun: string; plan: FixSummary | null }> {
  const store = deps.skills ?? new SkillStore();
  const known = audited.get(room);
  const fp = known ? known.fp : ((await probeSchema(room, log))?.fp ?? null);
  const fresh = opts.fresh ?? known?.fresh ?? false;
  const check = checkFindings(await tryDownload(room, FINDINGS_PATH));
  if ("problem" in check) throw new Error(`cannot write a fix: ${check.problem}`);
  const f = check.findings;
  const finish = (code: string, run: FixRun) => {
    writeFileSync(join(runDir, "fix.py"), code);
    return { code, dryRun: run.out.text, plan: run.plan };
  };

  let prompt =
    `The audit is done. Findings counts: ${JSON.stringify({
      pro_without_subscription: f.pro_without_subscription.length,
      payers_without_account: f.payers_without_account.length,
      stale_subscription_rows: f.stale_subscription_rows.length,
      monthly_leak_cents: f.monthly_leak_cents,
    })}. Write the fix script now. It will be saved as ${FIX_PATH} and dry-run first with APPLY=0.`;
  if (known?.auditCode) {
    // The fix needs the schema the audit learned; the audit script carries it as code, with no data.
    prompt += `\n\nThis is the audit script that wrote ${FINDINGS_PATH}; it shows the tables, columns and matching rules:\n\n${fenced(known.auditCode)}`;
  }

  const saved = fp && !fresh ? store.fix(fp) : null;
  if (fp && saved) {
    log(`saved fix found for this schema · dry run of skills/${fp}.fix.py`);
    const run = await dryRun(room, saved, f);
    if (!run.why) {
      log(`fix (saved): dry run exit 0 · ${secs(run.r)} · ${summaryLine(run.plan!)}`);
      transcript.log({ kind: "skill", fingerprint: fp, note: "saved fix script dry run passed; no model call was made" });
      return finish(saved, run);
    }
    log(`fix (saved): ${run.why} → asking the agent`);
    prompt +=
      `\n\nA fix script you wrote on an earlier run for this schema no longer passes:\n\n${fenced(saved)}\n\n` +
      `Its dry run failed (${run.why}). Output (guarded):\n\n${run.out.text}`;
  }

  const coder = (deps.coder ?? ((s, t) => new Coder(s, t)))(SYSTEM + FIX_SYSTEM_SUFFIX, transcript);
  for (let turn = 1; turn <= FIX_TURNS; turn++) {
    const reply = await coder.ask(prompt);
    const intent = intentLine(reply);
    if (intent) log(`fix draft ${turn}: ${intent}`);
    const code = pythonBlock(reply);
    if (!code) {
      log(`fix draft ${turn}: no complete python block → asking again`);
      prompt = "No complete ```python block found. Reply with one short sentence and exactly one complete ```python block.";
      continue;
    }
    const gap = fixRuleGaps(code);
    if (gap) {
      log(`fix draft ${turn}: ${gap} → agent rewriting`);
      prompt = `The fix script was ${gap}. Send the corrected full script.`;
      continue;
    }
    log(`fix draft ${turn}: dry run of ${code.trimEnd().split("\n").length} lines with APPLY=0`);
    const run = await dryRun(room, code, f);
    if (!run.why) {
      log(`fix draft ${turn}: exit 0 · ${secs(run.r)} · ${summaryLine(run.plan!)}`);
      if (fp) {
        store.saveFix(fp, code);
        log(`saved this fix as skills/${fp}.fix.py`);
      }
      return finish(code, run);
    }
    log(`fix draft ${turn}: exit ${run.r.exit_code} · ${secs(run.r)} · ${run.why} → agent rewriting`);
    const readOnly = /DryRunWriteRefused|ReadOnlySqlTransaction|read-only transaction/.test(`${run.why} ${run.out.text}`)
      ? " The dry run is read-only on both sides: gate each write on APPLY and keep every read in both modes, so the dry-run counts still match what APPLY does."
      : "";
    prompt = `Dry run failed: ${run.why}. Output (guarded):\n\n${run.out.text}\n\nFix it and send the corrected full script.${readOnly}`;
  }
  throw new Error(`could not produce a working fix script in ${FIX_TURNS} drafts`);
}
