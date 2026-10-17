/**
 * The terminal half of the demo: numbered steps, aligned timestamps, color
 * only where it carries meaning. Modules that need credentials are imported
 * inside the commands that use them, so `report` works without a .env.
 *
 * Paths: runs/ and runs/last.json live under the current directory (where
 * the user runs the command); the seed answer key is read from
 * ./seed/expected.json, falling back to the package's own copy.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { money, renderReport, summaryLine, writeReport, type ReportOpts } from "./report.js";
import { loadExpected, scoreAgainstExpected, scoreTotals } from "./score.js";
import type { SealedRoom as Room } from "./sandbox.js";
import { SUMMARY_MARKER, normalizeFindings, parseSummary, type Findings, type FixSummary, type RunMeta, type Score } from "./types.js";

// ---------------------------------------------------------------- output

const COLOR = !!process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (open: string, close: string) => (s: string | number) => (COLOR ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
const dim = sgr("2", "22");
const bold = sgr("1", "22");
const red = sgr("31", "39");
const green = sgr("32", "39");
const yellow = sgr("33", "39");
const cyan = sgr("36", "39");
const link = sgr("4", "24");

const t0 = Date.now();
const stamp = () => dim(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`);
const GUTTER = " ".repeat(9);

/** Colour the few words that carry the story: exit codes, the seal, rewrites. */
const tint = (line: string) =>
  line
    .replace(/\bexit (\d+)\b/g, (m, code) => (code === "0" ? green(m) : red(m)))
    .replace(/\begress sealed\b/g, (m) => green(m))
    .replace(/EGRESS NOT SEALED/g, (m) => red(bold(m)))
    .replace(/agent rewriting/g, (m) => yellow(m))
    .replace(/^warning:/, (m) => yellow(m));

function log(line: string) {
  for (const l of String(line).split("\n")) console.log(`${stamp()}  ${tint(l)}`);
}

let stepNo = 0;
function step(title: string) {
  stepNo++;
  const rule = "─".repeat(Math.max(3, 60 - title.length));
  console.log(`\n${cyan(bold(String(stepNo).padStart(7)))}  ${bold(title)} ${dim(rule)}`);
}

function title(cmd: string, what: string) {
  console.log(`\n${GUTTER}${red("●")} ${bold("LeakFinder")} ${dim("·")} ${bold(cmd)}  ${dim(what)}`);
}

/** Script output, indented under the step; the summary marker line is shown formatted instead. */
function block(text: string, max = 20) {
  const lines = text
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !l.startsWith(SUMMARY_MARKER));
  const hidden = Math.max(0, lines.length - max);
  if (hidden) console.log(`${GUTTER}${dim(`│ … ${hidden} earlier line${hidden === 1 ? "" : "s"}`)}`);
  for (const l of lines.slice(hidden)) console.log(`${GUTTER}${dim("│")} ${l}`);
}

function headline(f: Findings) {
  return `${f.pro_without_subscription.length} with Pro and nobody paying · ${f.payers_without_account.length} paying with no account · ${f.stale_subscription_rows.length} rows out of sync`;
}

/** The closing block: the number and where to look. `big` frames it for the demo screen. */
function finale(lines: string[], big = false) {
  const width = Math.min(Math.max(40, (process.stdout.columns || 80) - 12), 76);
  console.log();
  if (big) console.log(`${GUTTER}${red("━".repeat(width))}`);
  for (const l of lines) console.log(`${GUTTER}${red("┃")}  ${l}`);
  if (big) console.log(`${GUTTER}${red("━".repeat(width))}`);
  console.log();
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const flag = (name: string) => process.argv.slice(3).includes(name);
const withToken = (url: string, token: string) => {
  const u = new URL(url);
  u.searchParams.set("k", token);
  return u.toString();
};
const newToken = () => randomBytes(24).toString("base64url");

class UserError extends Error {}

// ---------------------------------------------------------------- run state

const RUNS = "runs";
const LAST = join(RUNS, "last.json");

/** runs/last.json: the run the other commands act on. `url` is without the token. */
interface Last {
  runDir: string;
  sandboxId: string;
  token: string;
  url: string | null;
}

/** runs/<run>/run.json: everything besides findings.json needed to re-render the report. */
interface RunRecord {
  meta: RunMeta;
  score: Score | null;
  canary: string | null;
  summary: FixSummary | null;
  appliedAt: string | null;
  fixError: string | null;
}

function readLast(): Last {
  if (!existsSync(LAST)) throw new UserError("no audit yet: run pnpm scan first");
  return JSON.parse(readFileSync(LAST, "utf8"));
}

function tryReadLast(): Last | null {
  try {
    return readLast();
  } catch {
    return null;
  }
}

function writeLast(last: Last) {
  mkdirSync(RUNS, { recursive: true });
  writeFileSync(LAST, JSON.stringify(last, null, 2) + "\n");
}

function saveRecord(runDir: string, rec: RunRecord) {
  writeFileSync(join(runDir, "run.json"), JSON.stringify(rec, null, 2) + "\n");
}

/** The newest run directory that has findings, for `report` when last.json is gone. */
function latestRunDir(): string | null {
  if (!existsSync(RUNS)) return null;
  const dirs = readdirSync(RUNS)
    .map((d) => join(RUNS, d))
    .filter((d) => statSync(d).isDirectory() && existsSync(join(d, "findings.json")))
    .sort();
  return dirs.at(-1) ?? null;
}

function loadRun(runDir: string): { f: Findings; rec: RunRecord } {
  const fPath = join(runDir, "findings.json");
  const rPath = join(runDir, "run.json");
  if (!existsSync(fPath)) throw new UserError(`${fPath} is missing: run pnpm scan again`);
  if (!existsSync(rPath)) throw new UserError(`${rPath} is missing: this run predates the report; run pnpm scan again`);
  return { f: normalizeFindings(JSON.parse(readFileSync(fPath, "utf8"))), rec: JSON.parse(readFileSync(rPath, "utf8")) };
}

const reportOpts = (rec: RunRecord, live: boolean): ReportOpts => ({
  score: rec.score,
  summary: rec.summary,
  live,
  canary: rec.canary,
  appliedAt: rec.appliedAt,
  fixError: rec.fixError,
});

/** What `grep -c <needle> <file>` prints: matching lines, with `.` as grep's any-character. */
function grepCount(path: string, needle: string): number {
  if (!existsSync(path)) return 0;
  const re = new RegExp(needle.split(".").map((p) => p.replace(/[\\^$*+?()[\]{}|/]/g, "\\$&")).join("."));
  return readFileSync(path, "utf8").split("\n").filter((l) => re.test(l)).length;
}

// ---------------------------------------------------------------- commands

async function audit(demo: boolean) {
  const fresh = flag("--fresh");
  title(demo ? "demo" : "audit", fresh ? "fresh run, saved skills ignored" : "finds the money leaking between Stripe and your database");
  const { runAudit, writeFix } = await import("./agent.js");
  const { SealedRoom } = await import("./sandbox.js");
  const { guard } = await import("./llm.js");
  const { env } = await import("./env.js");

  const started = new Date();
  const runDir = join(RUNS, started.toISOString().replace(/[:.]/g, "-"));
  const token = newToken();

  const prev = tryReadLast();
  if (prev?.sandboxId) {
    // The Free plan runs one sandbox at a time; the last run's room would block this one until it is fully destroyed.
    try {
      if (await SealedRoom.retire(prev.sandboxId)) log(dim(`retired the last run's sandbox ${prev.sandboxId}`));
    } catch (e) {
      log(yellow(`could not retire the last run's sandbox ${prev.sandboxId}: ${msg(e)}`));
    }
  }

  step("The agent audits your schema inside a sealed CreateOS sandbox");
  // Recorded the moment the room exists, so a crash or Ctrl-C mid-audit leaves an id that pnpm down and the next scan can find.
  const openRoom = async (o: { ingress?: boolean }) => {
    const room = await SealedRoom.open(o);
    writeLast({ runDir, sandboxId: room.id, token, url: null });
    return room;
  };
  const out = await runAudit(runDir, log, { fresh, ingress: true }, { openRoom });
  writeLast({ runDir, sandboxId: out.room.id, token, url: null });
  const f = out.findings;
  writeFileSync(join(runDir, "findings.json"), JSON.stringify(f, null, 2) + "\n");
  log(headline(f));
  log(bold(red(`${money(f.monthly_leak_cents)} / month leaking`)));

  step("The agent writes the fix and dry-runs it");
  let plan: FixSummary | null = null;
  let fixError: string | null = null;
  try {
    const fix = await writeFix(out.room, runDir, out.transcript, log, { fresh });
    block(guard(fix.dryRun).text);
    plan = fix.plan;
    log(plan ? summaryLine(plan) : yellow("the dry run printed no LEAKFINDER_SUMMARY line"));
  } catch (e) {
    fixError = msg(e);
    log(red(`no working fix script: ${fixError}`));
  }

  step("Check the answer key and the privacy claim");
  const expected = loadExpected();
  const scored = expected ? scoreAgainstExpected(f, expected) : null;
  // A key that plants nothing (or only a summary) cannot grade the run.
  const score = scored && scoreTotals(scored).planted > 0 ? scored : null;
  if (score) {
    const t = scoreTotals(score);
    const parts = [score.pro_without_subscription, score.payers_without_account, score.stale_subscription_rows];
    const verdict = `${t.found} of ${t.planted} planted found · ${t.extra} extra`;
    log(`${t.found === t.planted && t.extra === 0 ? green(verdict) : yellow(verdict)}  ${dim(`A ${parts[0].found}/${parts[0].planted} · B ${parts[1].found}/${parts[1].planted} · C ${parts[2].found}/${parts[2].planted}`)}`);
  } else {
    log(dim("no planted cases in seed/expected.json, so no answer key to check against"));
  }
  const canary = typeof expected?.grep_target_email === "string" && expected.grep_target_email ? (expected.grep_target_email as string) : null;
  const canaryHits = canary ? grepCount(out.transcript.path, canary) : null;
  if (canary && canaryHits != null) {
    log(`grep -c "${canary}" ${out.transcript.path} → ${canaryHits === 0 ? green(bold("0")) : red(bold(String(canaryHits)))}`);
  }
  log(`the model saw ${out.transcript.inputTokens.toLocaleString("en-US")} tokens in, ${out.transcript.outputTokens.toLocaleString("en-US")} out · ${plural(out.redacted, "email")} redacted on the way`);

  const meta: RunMeta = {
    sandboxId: out.room.id,
    egress: out.room.egress,
    sealed: out.seal.sealed,
    sealDetail: out.seal.detail,
    turns: out.turns,
    rewrites: out.rewrites,
    reusedSkill: out.reusedSkill,
    inputTokens: out.transcript.inputTokens,
    outputTokens: out.transcript.outputTokens,
    redacted: out.redacted,
    transcriptPath: out.transcript.path,
    canaryHits,
    model: env.model(),
    startedAt: started.toISOString(),
    seconds: Math.round((Date.now() - started.getTime()) / 100) / 10,
  };

  step("Report");
  const rec: RunRecord = { meta, score, canary, summary: plan, appliedAt: null, fixError };
  saveRecord(runDir, rec);
  const local = writeReport(runDir, f, meta, reportOpts(rec, false));
  log(`local copy: ${local}`);
  let url: string | null = null;
  try {
    url = (await out.room.serveReport({ html: renderReport(f, meta, reportOpts(rec, true)), token })).url;
    log("served from inside the sandbox; the link carries its access token");
  } catch (e) {
    log(yellow(`could not serve from the sandbox: ${msg(e)}`));
    log(`open the local copy instead: ${local}`);
  }
  writeLast({ runDir, sandboxId: out.room.id, token, url });
  log(dim(`sandbox ${out.room.id} stays up for pnpm apply`));

  const where = url ? bold(cyan(link(withToken(url, token)))) : local;
  finale(
    demo
      ? [bold(red(`${money(f.monthly_leak_cents)} / month leaking`)), headline(f), "", `${dim("open the report")}`, where, "", dim(fixError ? "next: pnpm scan" : "next: pnpm apply --yes")]
      : [`${dim("report")}  ${where}`, dim(fixError ? "next: pnpm scan" : "next: pnpm apply   (dry run in a fork)   ·   pnpm apply --yes")],
    demo,
  );
}

async function apply() {
  const yes = flag("--yes");
  title("apply", yes ? "dry run in a fork, then fix in Stripe test mode" : "dry run in a fork; nothing changes");
  const last = readLast();
  const { SealedRoom, WORKDIR } = await import("./sandbox.js");
  const { FIX_PATH, assertTestKey } = await import("./agent.js");
  const { guard } = await import("./llm.js");

  /** Run fix.py, show its guarded output, return its summary. Throws on a non-zero exit. */
  async function runFix(room: Room, mode: "0" | "1"): Promise<FixSummary | null> {
    const r = await room.runPython(FIX_PATH, { APPLY: mode });
    block(guard(r.exit_code === 0 ? r.stdout : `${r.stdout}\n${r.stderr}`).text);
    log(`fix.py APPLY=${mode} · exit ${r.exit_code} in ${(r.ms / 1000).toFixed(1)}s`);
    if (r.exit_code !== 0) throw new Error(`fix.py exited ${r.exit_code}`);
    const s = parseSummary(r.stdout);
    log(s ? summaryLine(s) : yellow("fix.py printed no LEAKFINDER_SUMMARY line"));
    return s;
  }

  step("Dry run in a fork of the sealed sandbox");
  log(`attaching to ${last.sandboxId}`);
  const room = await SealedRoom.attach(last.sandboxId);

  let prior: { summary: FixSummary; at: string } | null = null;
  try {
    const raw = JSON.parse(await room.download(`${WORKDIR}/applied.json`));
    if (raw?.applied === true && raw.summary) prior = { summary: parseSummary(`${SUMMARY_MARKER} ${JSON.stringify(raw.summary)}`)!, at: String(raw.at ?? "") };
  } catch {
    /* not applied yet */
  }

  let applied: { summary: FixSummary; at: string } | null = null;
  if (prior) {
    const at = new Date(prior.at);
    log(yellow(`already applied${isNaN(at.getTime()) ? "" : ` at ${at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`}; fix.py does not run twice`));
    log(summaryLine(prior.summary));
    applied = prior;
  } else {
    let fork: Room | null = null;
    if (flag("--no-fork")) {
      // On Free the fork always fails after a full pause and resume of the room; skip straight to the fallback.
      log("--no-fork: dry run in the original; APPLY=0 changes nothing");
    } else {
      try {
        log(`forking ${room.id}: the dry run happens in a copy, the original stays untouched`);
        fork = await room.pauseAndFork();
        log(`fork ${fork.id} running`);
      } catch (e) {
        log(yellow(`no fork: ${msg(e)}`));
        log("dry run in the original instead; APPLY=0 changes nothing");
      }
    }
    try {
      await runFix(fork ?? room, "0");
    } finally {
      if (fork) {
        const id = fork.id;
        // A failed cleanup must not mask the dry run's own error, and the id is what the user needs to clean up by hand.
        await fork.destroy().then(
          () => log(dim(`fork ${id} destroyed`)),
          (e) => log(yellow(`fork ${id} was not destroyed (${msg(e)}); destroy it in the CreateOS console`)),
        );
      }
    }

    if (!yes) {
      finale([`${dim("nothing changed.")} ${bold("pnpm apply --yes")} applies it in Stripe test mode`]);
      return;
    }

    step("Apply in Stripe test mode");
    assertTestKey();
    log("STRIPE_SECRET_KEY is a test-mode key");
    log(`APPLY=1 in the original sandbox ${room.id}`);
    const s = await runFix(room, "1");
    if (s?.mode !== "applied") throw new Error("fix.py exited 0 but did not report mode \"applied\"; nothing recorded");
    applied = { summary: s, at: new Date().toISOString() };
    // The in-VM server reads this, so the page's Apply button cannot run fix.py a second time.
    await room.upload(`${WORKDIR}/applied.json`, JSON.stringify({ applied: true, ...applied, log: [] }));
  }

  step("Report, with the result");
  try {
    const { f, rec } = loadRun(last.runDir);
    rec.summary = applied.summary;
    rec.appliedAt = applied.at;
    saveRecord(last.runDir, rec);
    log(`local copy: ${writeReport(last.runDir, f, rec.meta, reportOpts(rec, false))}`);
    if (last.url) {
      const { url } = await room.serveReport({ html: renderReport(f, rec.meta, reportOpts(rec, true)), token: last.token });
      writeLast({ ...last, url });
      log("re-served from the sandbox");
    }
  } catch (e) {
    log(yellow(`report not updated: ${msg(e)}`));
  }

  const s = applied.summary;
  finale([
    bold(green(`Invoiced ${money(s.invoiced_cents)} · Refunded ${money(s.refunded_cents)} · ${money(s.leak_closed_cents)}/month leak closed`)),
    dim(`${plural(s.revoked, "entitlement")} revoked · ${plural(s.rows_synced, "row")} synced · ${plural(s.cancelled, "subscription")} cancelled`),
    ...(last.url ? ["", `${dim("report")}  ${bold(cyan(link(withToken(last.url, last.token))))}`] : []),
  ]);
}

async function serve() {
  title("serve", "re-serve the last report from its sandbox");
  const last = readLast();
  const { f, rec } = loadRun(last.runDir);
  const { SealedRoom } = await import("./sandbox.js");
  step("Serve the report from the sandbox");
  log(`attaching to ${last.sandboxId}`);
  const room = await SealedRoom.attach(last.sandboxId);
  const token = /^[A-Za-z0-9_-]{16,}$/.test(last.token ?? "") ? last.token : newToken();
  const { url } = await room.serveReport({ html: renderReport(f, rec.meta, reportOpts(rec, true)), token });
  writeLast({ ...last, token, url });
  log("served from inside the sandbox; the link carries its access token");
  finale([bold(red(`${money(f.monthly_leak_cents)} / month leaking`)), "", bold(cyan(link(withToken(url, token))))], true);
}

async function report() {
  title("report", "re-render the last report on this machine");
  // last.json can name a run whose audit failed (it is written when the room opens); fall back to the newest finished one.
  const lastDir = tryReadLast()?.runDir;
  const runDir = lastDir && existsSync(join(lastDir, "findings.json")) ? lastDir : latestRunDir();
  if (!runDir) throw new UserError("no runs yet: run pnpm scan first");
  const { f, rec } = loadRun(runDir);
  step("Render");
  const path = writeReport(runDir, f, rec.meta, reportOpts(rec, false));
  log(`${money(f.monthly_leak_cents)} / month leaking · ${headline(f)}`);
  finale([`${dim("report")}  ${bold(path)}`]);
}

async function doctor() {
  title("doctor", "credentials, CreateOS, and a sealed sandbox end to end");
  const { env } = await import("./env.js");
  step("Local setup");
  const names = ["CREATEOS_SANDBOX_API_KEY", "DATABASE_URL", "STRIPE_SECRET_KEY", "ANTHROPIC_API_KEY"];
  for (const n of names) log(`${n.padEnd(26)} ${process.env[n] ? green("set") : red("missing")}`);
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) throw new UserError(`missing ${missing.join(", ")} in .env`);
  log(`${"Stripe key mode".padEnd(26)} ${/^(sk|rk)_test_/.test(env.stripeKey()) ? green("test mode") : red("not a test key: apply will refuse")}`);
  log(`${"model".padEnd(26)} ${env.model()}`);
  const expected = loadExpected();
  log(`${"seed answer key".padEnd(26)} ${expected ? "seed/expected.json" : dim("none yet (pnpm seed)")}`);

  const { SealedRoom } = await import("./sandbox.js");
  step("CreateOS");
  const me = await SealedRoom.client().whoami();
  log(`signed in: ${JSON.stringify(me).slice(0, 160)}`);

  step("A sealed sandbox, end to end");
  const room = await SealedRoom.open({ name: `leakfinder-doctor-${Date.now().toString(36)}` });
  try {
    log(`sandbox ${room.id} · egress ${room.egress.join(", ")}`);
    const seal = await room.sealCheck();
    log(`${seal.sealed ? "egress sealed" : "EGRESS NOT SEALED"} · ${seal.detail}`);
    const s = await room.exec(`python3 -c "import stripe,os; print(len(stripe.Subscription.list(limit=1, api_key=os.environ['STRIPE_SECRET_KEY']).data))"`);
    log(`stripe from inside: exit ${s.exit_code} ${s.stdout.trim()} ${s.stderr.trim().slice(0, 200)}`);
    const d = await room.exec(`python3 -c "import psycopg,os; c=psycopg.connect(os.environ['DATABASE_URL']); print(c.execute('select count(*) from users').fetchone()[0])"`);
    log(`postgres from inside: exit ${d.exit_code} ${d.stdout.trim()} ${d.stderr.trim().slice(0, 200)}`);
  } finally {
    await room.destroy();
    log(dim(`sandbox ${room.id} destroyed`));
  }
}

/** Destroy the last run's sandbox (frees the Free plan's one concurrent slot). */
async function down() {
  title("down", "destroy the last run's sandbox");
  const last = readLast();
  const { SealedRoom } = await import("./sandbox.js");
  step("Destroy");
  try {
    log(`sandbox ${last.sandboxId} ${(await SealedRoom.retire(last.sandboxId)) ? "destroyed" : "was already gone"}`);
  } catch (e) {
    log(dim(`sandbox ${last.sandboxId}: ${msg(e)}`));
  }
  writeLast({ ...last, url: null });
}

const COMMANDS: Record<string, [() => Promise<void>, string]> = {
  doctor: [doctor, "check credentials, open a sealed sandbox, prove the seal, destroy it"],
  audit: [() => audit(false), "the agent audits your schema in a sealed sandbox [--fresh]"],
  apply: [apply, "dry run fix.py in a fork; --yes applies it in Stripe test mode [--no-fork on Free]"],
  serve: [serve, "re-serve the last report from its sandbox"],
  report: [report, "re-render the last report locally from findings.json"],
  demo: [() => audit(true), "audit, then print the report URL big"],
  down: [down, "destroy the last run's sandbox"],
};

function usage() {
  console.log(`\n${GUTTER}${red("●")} ${bold("LeakFinder")}  ${dim("finds the money leaking between Stripe and your database")}\n`);
  for (const [name, [, what]] of Object.entries(COMMANDS)) console.log(`${GUTTER}${bold(name.padEnd(8))} ${dim(what)}`);
  console.log(`\n${GUTTER}${dim("pnpm scan · pnpm check · pnpm apply [--yes] · pnpm serve · pnpm report · pnpm demo · pnpm lf <command>")}\n`);
}

const cmd = process.argv[2];
const entry = cmd ? COMMANDS[cmd] : undefined;
if (!entry) {
  usage();
  process.exit(cmd && !["-h", "--help", "help"].includes(cmd) ? 2 : 0);
}
// The CreateOS SDK keeps an HTTP/2 session (and a keep-alive pool) open that it never unrefs, so Node would sit at
// the prompt after the finale instead of exiting. Exit explicitly once stdout has drained.
const exit = (code: number) => process.stdout.write("", () => process.exit(code));
entry[0]().then(
  () => exit(0),
  (e) => {
    console.error(`${stamp()}  ${red(bold("error"))} ${red(msg(e))}`);
    if (process.env.DEBUG && !(e instanceof UserError)) console.error(e);
    exit(1);
  },
);
