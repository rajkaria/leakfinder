/**
 * The agent loop, offline: a fake room that runs nothing and a scripted model.
 * What would embarrass the demo: a raw email in the transcript, a wrong
 * rewrite count, a second run that still calls the model, a leaked sandbox.
 */
process.env.DOTENV_CONFIG_PATH = "/nonexistent/leakfinder-test.env"; // tests never read a real .env
process.env.LEAKFINDER_MODEL ??= "test-model";

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

const agent = await import("../src/agent.js");
const { Coder, Transcript } = await import("../src/llm.js");
const { SkillStore, fingerprint, PROBE_PY } = await import("../src/skills.js");
const { normalizeFindings } = await import("../src/types.js");
const { FINDINGS_PATH, FIX_PATH, DRYRUN_PATH, DONE, runAudit, writeFix, assertTestKey, errorLine, checkFindings, reconcileProblem } = agent;

const CANARY = "priya.kapoor32@leakfinder.test";
const tmp = (p: string) => mkdtempSync(join(tmpdir(), `leakfinder-${p}-`));

const SCHEMA = [
  "public.users.id uuid",
  "public.users.email text",
  "public.entitlements.user_id uuid",
  "public.entitlements.plan text",
  "public.subscriptions.id text",
  "public.subscriptions.status text",
].join("\n");

const FINDINGS = {
  pro_without_subscription: [
    { user_id: "u1", email: CANARY, plan: "pro", monthly_cents: 2900, cause: "cancelled_unsynced" },
    { user_id: "u2", email: "arjun.nair1@leakfinder.test", plan: "pro", monthly_cents: 2900, cause: "never_paid" },
  ],
  payers_without_account: [{ stripe_customer_id: "cus_1", subscription_id: "sub_1", monthly_cents: 2900 }],
  stale_subscription_rows: [{ user_id: "u1", subscription_id: "sub_9", app_status: "active", stripe_status: "canceled" }],
  monthly_leak_cents: 5800,
  totals: { app_users: 252, app_pro_entitlements: 44, stripe_active_subscriptions: 43 },
};

const SUMMARY = `LEAKFINDER_SUMMARY {"mode": "dry_run", "revoked": 2, "invoices": 2, "invoiced_cents": 5800, "refunds": 1, "refunded_cents": 2900, "cancelled": 1, "rows_synced": 1, "leak_closed_cents": 5800}`;

/**
 * A room that "runs" scripts by recognising a marker comment in them. Its
 * outputs carry the canary email the way a careless script would print it.
 */
class FakeRoom {
  id = "sbx-fake";
  files = new Map<string, string>();
  runs: { path: string; env: Record<string, string> }[] = [];
  destroyed = false;
  constructor(private schema = SCHEMA) {}
  async sealCheck() {
    return { sealed: true, detail: "example.com → blocked in 0.3s · api.stripe.com → 401", stripeReachable: true };
  }
  async upload(path: string, content: string) {
    this.files.set(path, content);
  }
  async download(path: string) {
    const f = this.files.get(path);
    if (f == null) throw new Error(`no such file ${path}`);
    return f;
  }
  async exec(shell: string) {
    const m = shell.match(/^rm -f (\S+)$/);
    if (m) this.files.delete(m[1]);
    return { stdout: "", stderr: "", exit_code: 0, ms: 5 };
  }
  async runPython(path: string, env: Record<string, string> = {}) {
    // The dry-run harness runs fix.py in-process; record and dispatch it as fix.py.
    if (path === DRYRUN_PATH) {
      assert.match(this.files.get(DRYRUN_PATH) ?? "", /DryRunWriteRefused/, "the harness is uploaded before every dry run");
      path = FIX_PATH;
    }
    this.runs.push({ path, env });
    const code = this.files.get(path) ?? "";
    const ok = (stdout: string) => ({ stdout, stderr: "", exit_code: 0, ms: 1200 });
    if (code === PROBE_PY) return ok(this.schema);
    if (code.includes("# STAGE1")) return ok(`users 252\nentitlements 44\nfirst row email: ${CANARY}\nactive 35`);
    if (code.includes("# BROKEN"))
      return {
        stdout: "",
        stderr: `Traceback (most recent call last):\n  File "turn2.py", line 9, in <module>\npsycopg.errors.UndefinedColumn: column "stripe_id" does not exist\nLINE 1: select stripe_id from customers where email = '${CANARY}'\n               ^\nHINT:  Perhaps you meant to reference the column "customers.stripe_customer_id".`,
        exit_code: 1,
        ms: 800,
      };
    if (code.includes("# DONE_NO_FILE")) return ok(`A=2\n${DONE}`);
    if (code.includes("# PER_MEMBER")) {
      // One entry per team member, unpriced: valid JSON, wrong on any schema.
      const a = [...FINDINGS.pro_without_subscription, { ...FINDINGS.pro_without_subscription[0], monthly_cents: 0 }];
      this.files.set(FINDINGS_PATH, JSON.stringify({ ...FINDINGS, pro_without_subscription: a }));
      return ok(`A=3 B=1 C=1 (sample ${CANARY})\n${DONE}`);
    }
    if (code.includes("# AUDIT")) {
      this.files.set(FINDINGS_PATH, JSON.stringify(FINDINGS));
      return ok(`A=2 B=1 C=1 leak=5800 (sample ${CANARY})\n${DONE}`);
    }
    if (code.includes("# FIX")) return ok(`would revoke 2 (first: ${CANARY})\n${SUMMARY}`);
    return { stdout: "", stderr: "NameError: name 'x' is not defined", exit_code: 1, ms: 10 };
  }
  async destroy() {
    this.destroyed = true;
  }
}

const say = (sentence: string, marker: string) => `${sentence}\n\`\`\`python\n# ${marker}\nimport os\nprint("hi")\n\`\`\``;
/** A fix draft that mentions every rule the static check looks for. */
const sayFix = (sentence: string, marker: string) =>
  `${sentence}\n\`\`\`python\n# ${marker}\nimport os\nAPPLY = os.environ.get("APPLY") == "1"\nassert os.environ["STRIPE_SECRET_KEY"].startswith(("sk_test_", "rk_test_")) or not APPLY\nimport hashlib\nRUN = hashlib.sha256(b"findings").hexdigest()[:12]\nkw = dict(idempotency_key=f"leakfinder-{RUN}-x")\nprint("LEAKFINDER_SUMMARY {}")\n\`\`\``;

/** A real Coder (so the real transcript path runs) over a scripted model. */
function scripted(replies: string[]) {
  const seen: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
  const make = (system: string, t: InstanceType<typeof Transcript>) =>
    new Coder(system, t, {
      model: "test-model",
      create: async (p) => {
        seen.push(structuredClone(p));
        const text = replies.shift();
        if (text == null) throw new Error("the scripted model ran out of replies");
        return {
          content: [{ type: "text", text, citations: null } as Anthropic.Beta.BetaTextBlock],
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as Anthropic.Beta.BetaUsage,
          stop_reason: "end_turn",
          stop_details: null,
        };
      },
    });
  return { make, seen, left: () => replies.length };
}

test("loop: schema, a failing turn, then DONE · one rewrite, findings parsed, no raw email anywhere the model looks", async () => {
  const runDir = tmp("run");
  const skills = new SkillStore(tmp("skills"));
  const room = new FakeRoom();
  const model = scripted([
    say("Discover the schema and Stripe status counts.", "STAGE1"),
    say("Reconcile entitlements against Stripe.", "BROKEN"),
    say("Use the right column and write the findings file.", "AUDIT"),
  ]);
  const lines: string[] = [];
  const out = await runAudit(runDir, (l) => lines.push(l), { ingress: true }, { openRoom: async () => room as any, coder: model.make, skills });

  assert.equal(out.turns, 3);
  assert.equal(out.rewrites, 1);
  assert.equal(out.reusedSkill, false);
  assert.equal(out.seal.sealed, true);
  assert.equal(out.findings.pro_without_subscription.length, 2);
  assert.equal(out.findings.monthly_leak_cents, 5800);
  assert.equal(out.redacted, 3, "stage-1 stdout, the traceback and the audit stdout each carried the canary");
  assert.equal(room.destroyed, false);

  const transcript = readFileSync(out.transcript.path, "utf8");
  assert.ok(!transcript.includes(CANARY), "the canary never reaches the transcript");
  assert.ok(!/@leakfinder\.test/.test(transcript));
  assert.ok(!JSON.stringify(model.seen).includes("@leakfinder.test"), "nor any request to the model");
  assert.ok(!lines.join("\n").includes("@leakfinder.test"), "nor the terminal");
  assert.ok(!transcript.includes("public.entitlements.plan"), "the schema probe output stays local");

  // The demo beats.
  assert.ok(lines.some((l) => l === "turn 2: Reconcile entitlements against Stripe."));
  assert.ok(lines.some((l) => /^turn 2: exit 1 · 0\.8s · UndefinedColumn: column "stripe_id" does not exist → agent rewriting$/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /^turn 3: running \d+ lines of agent-written Python$/.test(l)));
  assert.ok(lines.includes("turn 2: guard · 1 email redacted before the model saw the output"), lines.join("\n"));

  // findings.json lands locally (it has emails: it is the user's data, on the user's machine).
  assert.ok(readFileSync(join(runDir, "findings.json"), "utf8").includes(CANARY));

  // The working script is saved as a skill for this schema.
  const fp = fingerprint(SCHEMA);
  assert.ok(skills.audit(fp)?.includes("# AUDIT"));
  assert.equal(skills.meta(fp)?.turns, 3);
  assert.equal(skills.meta(fp)?.rewrites, 1);
});

test("second audit of the same schema reuses the skill: zero model turns", async () => {
  const skills = new SkillStore(tmp("skills"));
  skills.saveAudit(fingerprint(SCHEMA), "# AUDIT\nprint(1)\n", { model: "m", turns: 3, rewrites: 1, tables: 3, columns: 6 });
  const model = scripted([]);
  const out = await runAudit(tmp("run"), () => {}, {}, { openRoom: async () => new FakeRoom() as any, coder: model.make, skills });
  assert.equal(out.reusedSkill, true);
  assert.equal(out.turns, 0);
  assert.equal(out.rewrites, 0);
  assert.equal(model.seen.length, 0);
  assert.equal(out.findings.payers_without_account.length, 1);
  assert.ok(existsSync(out.transcript.path), "the transcript exists for the canary grep even with no model call");
});

test("--fresh ignores the skill; a failing skill falls back to the model with the guarded error", async () => {
  const fp = fingerprint(SCHEMA);
  const skills = new SkillStore(tmp("skills"));
  skills.saveAudit(fp, "# AUDIT\nprint(1)\n", { model: "m", turns: 1, rewrites: 0, tables: 3, columns: 6 });
  const fresh = scripted([say("Audit.", "AUDIT")]);
  const a = await runAudit(tmp("run"), () => {}, { fresh: true }, { openRoom: async () => new FakeRoom() as any, coder: fresh.make, skills });
  assert.equal(a.reusedSkill, false);
  assert.equal(a.turns, 1);

  skills.saveAudit(fp, "# BROKEN\nprint(1)\n", { model: "m", turns: 1, rewrites: 0, tables: 3, columns: 6 });
  const model = scripted([say("Fix the column.", "AUDIT")]);
  const b = await runAudit(tmp("run"), () => {}, {}, { openRoom: async () => new FakeRoom() as any, coder: model.make, skills });
  assert.equal(b.reusedSkill, false);
  assert.equal(b.turns, 1);
  const first = JSON.stringify(model.seen[0].messages);
  assert.ok(first.includes("UndefinedColumn"), "the model is told why the saved script failed");
  assert.ok(!first.includes("@leakfinder.test"));
  assert.ok(skills.audit(fp)?.includes("# AUDIT"), "the passing script replaces the broken skill");
});

test("DONE without a valid findings file is a rewrite, and the model is told", async () => {
  const model = scripted([say("Finish.", "DONE_NO_FILE"), say("Write the file this time.", "AUDIT")]);
  const out = await runAudit(tmp("run"), () => {}, {}, { openRoom: async () => new FakeRoom() as any, coder: model.make, skills: new SkillStore(tmp("skills")) });
  assert.equal(out.turns, 2);
  assert.equal(out.rewrites, 1);
  assert.match(JSON.stringify(model.seen[1].messages), /findings\.json was not written/);
});

test("a reply with no python block counts as a rewrite; running out of turns destroys the room", async () => {
  const room = new FakeRoom();
  const replies = Array.from({ length: agent.MAX_TURNS }, (_, i) => (i === 0 ? "I will think about it." : say("Try.", "NOPE")));
  const model = scripted(replies);
  const lines: string[] = [];
  await assert.rejects(
    runAudit(tmp("run"), (l) => lines.push(l), {}, { openRoom: async () => room as any, coder: model.make, skills: new SkillStore(tmp("skills")) }),
    /did not finish in 8 turns/,
  );
  assert.equal(room.destroyed, true, "a failed audit must not leave the Free plan's one sandbox running");
  assert.ok(lines.some((l) => l.includes("no complete python block")));
});

test("writeFix dry-runs with APPLY=0, parses the plan, saves the fix, and reuses it next time", async () => {
  const skills = new SkillStore(tmp("skills"));
  const room = new FakeRoom();
  const runDir = tmp("run");
  const audit = scripted([say("Audit.", "AUDIT")]);
  const out = await runAudit(runDir, () => {}, {}, { openRoom: async () => room as any, coder: audit.make, skills });

  const fixModel = scripted([say("Draft the fix.", "FIX"), sayFix("Draft the fix.", "BROKEN"), sayFix("Fixed.", "FIX")]);
  const lines: string[] = [];
  const fix = await writeFix(out.room, runDir, out.transcript, (l) => lines.push(l), {}, { coder: fixModel.make, skills });
  assert.equal(fix.plan?.mode, "dry_run");
  assert.equal(fix.plan?.invoiced_cents, 5800);
  assert.equal(fix.plan?.leak_closed_cents, 5800);
  assert.ok(!fix.dryRun.includes(CANARY), "the dry-run text is guarded");
  assert.ok(room.files.get(FIX_PATH)?.includes("# FIX"), "the working fix is what sits at /workspace/fix.py");
  assert.ok(room.runs.filter((r) => r.path === FIX_PATH).every((r) => r.env.APPLY === "0"), "writeFix never applies");
  assert.ok(lines.some((l) => l.includes("would invoice $58 to 2 users")), lines.join("\n"));
  assert.ok(lines.some((l) => /^fix draft 1: rejected before running: it never reads APPLY; .*idempotency_key.* → agent rewriting$/.test(l)), "a draft missing the contract rules never runs");
  assert.ok(lines.some((l) => /^fix draft 2: exit 1 · .* → agent rewriting$/.test(l)));
  assert.equal(room.runs.filter((r) => r.path === FIX_PATH).length, 2, "the rejected draft was not run");
  assert.ok(!readFileSync(out.transcript.path, "utf8").includes(CANARY));
  const fixPrompt = JSON.stringify(fixModel.seen[0].messages);
  assert.ok(!fixPrompt.includes("@leakfinder.test"), "the fix prompt carries counts, not findings");
  assert.ok(fixPrompt.includes("# AUDIT"), "the fix draft sees the audit script, so it knows the schema");
  assert.ok(fixModel.seen[0].system && JSON.stringify(fixModel.seen[0].system).includes("InvoicePayment"));

  const again = scripted([]);
  const fix2 = await writeFix(out.room, runDir, out.transcript, () => {}, {}, { coder: again.make, skills });
  assert.equal(again.seen.length, 0, "the saved fix needs no model call");
  assert.equal(fix2.plan?.refunds, 1);
});

test("assertTestKey only lets test-mode keys through", () => {
  assert.doesNotThrow(() => assertTestKey("sk_test_abc"));
  assert.doesNotThrow(() => assertTestKey("rk_test_abc"));
  assert.throws(() => assertTestKey("sk_live_abc"), /not a test-mode key/);
  assert.throws(() => assertTestKey("rk_live_abc"), /not a test-mode key/);
  assert.throws(() => assertTestKey(""), /not a test-mode key/);
});

test("errorLine finds the exception and drops the module path", () => {
  const r = (stderr: string, stdout = "") => ({ stdout, stderr, exit_code: 1 });
  assert.equal(
    errorLine(r(`Traceback (most recent call last):\n  File "x.py", line 3\npsycopg.errors.UndefinedTable: relation "accounts" does not exist\nLINE 1: select * from accounts\nHINT:  nope`)),
    'UndefinedTable: relation "accounts" does not exist',
  );
  assert.equal(errorLine(r(`Traceback\nstripe._error.InvalidRequestError: Request req_1: No such customer: 'cus_x'`)), "InvalidRequestError: Request req_1: No such customer: 'cus_x'");
  assert.equal(errorLine(r(`Traceback\nKeyboardInterrupt`)), "KeyboardInterrupt");
  assert.equal(errorLine(r(`psycopg.errors.UniqueViolation: Key (email)=(${CANARY}) already exists.`)).includes("@"), false);
  assert.equal(errorLine(r("", "")), "exit 1 with no output");
});

test("checkFindings rejects bad files without echoing their content", () => {
  assert.match((checkFindings(null) as any).problem, /was not written/);
  const bad = checkFindings(`{"email": "${CANARY}"`) as any;
  assert.match(bad.problem, /not valid JSON/);
  assert.ok(!bad.problem.includes("@"));
  assert.match((checkFindings("[]") as any).problem, /not a JSON object/);
  assert.match((checkFindings('{"pro_without_subscription": []}') as any).problem, /payers_without_account, stale_subscription_rows/);
  assert.ok("findings" in checkFindings(JSON.stringify(FINDINGS)));
});

test("fingerprint ignores order and whitespace and changes when a column does", () => {
  const shuffled = SCHEMA.split("\n").reverse().map((l) => `  ${l}  `).join("\n") + "\n\n";
  assert.equal(fingerprint(shuffled), fingerprint(SCHEMA));
  assert.match(fingerprint(SCHEMA), /^[0-9a-f]{16}$/);
  assert.notEqual(fingerprint(SCHEMA + "\npublic.users.full_name text"), fingerprint(SCHEMA));
});

test("the probe is valid Python that selects names only", () => {
  const dir = tmp("probe");
  const file = join(dir, "probe.py");
  writeFileSync(file, PROBE_PY);
  const r = spawnSync("python3", ["-I", "-c", "import ast,sys; ast.parse(open(sys.argv[1]).read())", file], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(PROBE_PY, /information_schema\.columns/);
  assert.match(PROBE_PY, /'pg\\\\_%'/, "the LIKE pattern escapes the underscore");
  assert.ok(!/count\(|select \*/i.test(PROBE_PY), "no rows, no counts");
});

test("reconcileProblem: counts only; flags unpriced, repeated and unbalanced findings", () => {
  assert.equal(reconcileProblem(normalizeFindings(FINDINGS)), null, "the fixture balances: 44 - 2 = 43 - 1");
  const a = FINDINGS.pro_without_subscription;
  const bad = normalizeFindings({ ...FINDINGS, pro_without_subscription: [...a, { ...a[0], monthly_cents: 0 }] });
  const why = reconcileProblem(bad)!;
  assert.match(why, /1 of the 3 pro_without_subscription entries have monthly_cents 0/);
  assert.match(why, /repeats 1 user_id value;/);
  assert.match(why, /app_pro_entitlements 44 - pro_without_subscription 3 = 41, but stripe_active_subscriptions 43 - payers_without_account 1 = 42/);
  assert.ok(!why.includes(CANARY) && !why.includes("u1") && !why.includes("cus_1"), "no value from the findings, only counts");
  assert.equal(reconcileProblem(normalizeFindings({ ...FINDINGS, totals: { app_users: 0, app_pro_entitlements: 0, stripe_active_subscriptions: 0 } })), null, "no totals, no balance check");
});

test("loop: findings that do not reconcile get one rewrite with counts only, then the agent's answer stands", async () => {
  const room = new FakeRoom();
  const model = scripted([say("Audit per member.", "PER_MEMBER"), say("Audit per team.", "AUDIT")]);
  const lines: string[] = [];
  const out = await runAudit(tmp("run"), (l) => lines.push(l), {}, { openRoom: async () => room as any, coder: model.make, skills: new SkillStore(tmp("skills")) });
  assert.equal(out.turns, 2);
  assert.equal(out.rewrites, 1);
  assert.equal(out.findings.pro_without_subscription.length, 2);
  assert.ok(lines.includes(`turn 1: exit 0 · 1.2s · ${DONE} · counts do not reconcile → agent rewriting`), lines.join("\n"));
  const told = JSON.stringify(model.seen.at(-1)!.messages.at(-1));
  assert.match(told, /the books do not balance/);
  assert.ok(!told.includes(CANARY));

  // Raised once only: a second unbalanced pass is accepted (real data can have two subscriptions per customer).
  const again = scripted([say("Audit per member.", "PER_MEMBER"), say("Same script: the counts are right here.", "PER_MEMBER")]);
  const out2 = await runAudit(tmp("run"), () => {}, {}, { openRoom: async () => new FakeRoom() as any, coder: again.make, skills: new SkillStore(tmp("skills")) });
  assert.equal(out2.turns, 2);
  assert.equal(out2.findings.pro_without_subscription.length, 3);
});

test("fixRuleGaps: idempotency keys must carry the findings hash, so a re-seed cannot replay an old key", () => {
  const { fixRuleGaps } = agent;
  const ok = `APPLY = os.environ.get("APPLY") == "1"\n# sk_test_ rk_test_\nRUN = hashlib.sha256(open(p, "rb").read()).hexdigest()[:12]\nstripe.Invoice.create(idempotency_key=f"leakfinder-{RUN}-invoice-{u}")\nprint("LEAKFINDER_SUMMARY {}")`;
  assert.equal(fixRuleGaps(ok), null);
  assert.match(fixRuleGaps(ok.replace(/RUN = .*\n/, "").replace("{RUN}-", ""))!, /do not include the hash of the findings file/);
});
