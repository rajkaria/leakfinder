import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderReport, writeReport } from "../src/report.js";
import { normalizeFindings, type FixSummary, type RunMeta, type Score } from "../src/types.js";

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

function findings(email = "priya.kapoor32@leakfinder.test") {
  return normalizeFindings({
    pro_without_subscription: Array.from({ length: 12 }, (_, i) => ({
      user_id: uuid(i),
      email: i === 0 ? email : `user${i}@leakfinder.test`,
      plan: "pro",
      monthly_cents: 2900,
      cause: i < 5 ? "cancelled_unsynced" : "never_paid",
    })),
    payers_without_account: Array.from({ length: 3 }, (_, i) => ({ stripe_customer_id: `cus_o${i}`, subscription_id: `sub_o${i}`, monthly_cents: 2900 })),
    stale_subscription_rows: Array.from({ length: 5 }, (_, i) => ({ user_id: uuid(i), subscription_id: `sub_c${i}`, app_status: "active", stripe_status: "canceled" })),
    monthly_leak_cents: 34800,
    totals: { app_users: 252, app_pro_entitlements: 44, stripe_active_subscriptions: 35 },
  });
}

const meta: RunMeta = {
  sandboxId: "sbx_test",
  egress: ["api.stripe.com", "10.0.0.5:5432"],
  sealed: true,
  sealDetail: "example.com → blocked in 0.3s · api.stripe.com → 401",
  turns: 3,
  rewrites: 1,
  reusedSkill: false,
  inputTokens: 18432,
  outputTokens: 4211,
  redacted: 37,
  transcriptPath: "runs/x/transcript.jsonl",
  canaryHits: 0,
  model: "claude-sonnet-5-5",
  startedAt: "2026-10-18T01:32:10.114Z",
  seconds: 84.3,
};

const perfect: Score = {
  pro_without_subscription: { found: 12, planted: 12, extra: 0 },
  payers_without_account: { found: 3, planted: 3, extra: 0 },
  stale_subscription_rows: { found: 5, planted: 5, extra: 0 },
  leak_cents: { found: 34800, planted: 34800 },
};

const applied: FixSummary = {
  mode: "applied",
  revoked: 12,
  invoices: 12,
  invoiced_cents: 34800,
  refunds: 3,
  refunded_cents: 8700,
  cancelled: 3,
  rows_synced: 5,
  leak_closed_cents: 34800,
};

const scriptOf = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");

test("the hero shows the monthly leak in dollars, and the cards show the counts", () => {
  const html = renderReport(findings(), meta);
  assert.match(html, /<span class="leak-amt">\$348<\/span><span class="leak-unit">\/ month leaking<\/span>/);
  assert.match(html, /<title>LeakFinder · \$348\/month leaking<\/title>/);
  assert.match(html, /\$4,176<\/b> a year/);
  assert.match(html, /<b>12<\/b><span>users<\/span>/);
  assert.match(html, /<b>3<\/b><span>payers<\/span>/);
  assert.match(html, /<b>5<\/b><span>rows<\/span>/);
  assert.match(html, /\$87 <small>\/ month billed/);
});

test("agent-written values are escaped: a <script> inside an email never becomes markup", () => {
  const evil = `"><script>alert(1)</script><img src=x onerror=alert(2)>@x.test`;
  const f = findings(evil);
  f.stale_subscription_rows[0].stripe_status = "<b>canceled</b>";
  const html = renderReport(f, { ...meta, sandboxId: "<i>sbx</i>", sealDetail: "<script>x</script>" }, { live: true, canary: "<script>c</script>" });
  assert.equal((html.match(/<script/g) ?? []).length, 1, "only the page's own script tag");
  assert.ok(!html.includes("<img src=x"));
  assert.ok(!html.includes("<b>canceled</b>"));
  assert.ok(!html.includes("<i>sbx</i>"));
  assert.ok(html.includes("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"));
});

test("Dry run and Apply buttons appear only when live; otherwise the terminal command is shown", () => {
  const live = renderReport(findings(), meta, { live: true });
  assert.ok(live.includes('id="btn-dry"') && live.includes('id="btn-apply"'));
  assert.ok(live.includes('data-live="1"'));
  assert.ok(live.includes('fetch("status.json"'));

  const local = renderReport(findings(), meta);
  assert.ok(!local.includes('id="btn-apply"') && !local.includes('id="btn-dry"'));
  assert.ok(!local.includes("fetch("), "a local report makes no requests");
  assert.ok(local.includes("pnpm apply --yes"));

  const broken = renderReport(findings(), meta, { live: true, fixError: "dry run exited 1" });
  assert.ok(!broken.includes('id="btn-apply"'), "no Apply button without a working fix script");
  assert.ok(broken.includes("dry run exited 1"));
});

test("an applied summary renders the result line and disables Apply", () => {
  const html = renderReport(findings(), meta, { live: true, summary: applied, appliedAt: "2026-10-18T01:41:00Z" });
  assert.ok(html.includes("Invoiced $348 to 12 users · Refunded $87 to 3 payers · 12 entitlements revoked · 5 rows synced · $348/month closed"));
  assert.match(html, /id="btn-apply" disabled>Applied</);
  assert.ok(html.includes('data-applied="1"'));
  assert.ok(!/id="closed-pill" hidden/.test(html));

  const dry = renderReport(findings(), meta, { live: true, summary: { ...applied, mode: "dry_run" } });
  assert.ok(dry.includes("Would invoice $348 to 12 users"));
  assert.ok(dry.includes("Dry run · nothing changed"));
  assert.match(dry, /id="closed-pill" hidden/);
});

test("the page's own formatter renders a result exactly as the CLI does", () => {
  const html = renderReport(findings(), meta, { live: true, summary: applied });
  const summaryHtml = new Function("location", "document", `${scriptOf(html)}\nreturn summaryHtml;`)(
    { search: "" },
    { getElementById: () => null, documentElement: { setAttribute() {} } },
  );
  assert.ok(html.includes(summaryHtml(applied, null)));
});

test("planted-vs-found and the privacy grep come from the run", () => {
  const html = renderReport(findings(), meta, { score: perfect, canary: "priya.kapoor32@leakfinder.test" });
  assert.ok(html.includes("20 of 20 planted found"));
  assert.ok(html.includes("0 extra"));
  assert.ok(html.includes('grep -c "priya.kapoor32@leakfinder.test" runs/x/transcript.jsonl'));
  assert.ok(html.includes("api.stripe.com") && html.includes("10.0.0.5:5432"));
  assert.ok(html.includes("3 turns · 1 rewrite"));
  assert.ok(html.includes("18,432 in · 4,211 out"));
  assert.ok(!renderReport(findings(), meta).includes("planted found"), "no score panel without an answer key");
});

test("the page is self-contained: CSP set, nothing fetched from elsewhere, script parses", () => {
  const html = renderReport(findings(), meta, { live: true, score: perfect, summary: applied });
  assert.ok(
    html.includes(
      `content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:;`,
    ),
  );
  for (const m of html.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/g)) assert.match(m[1], /^(data:|#)/, `external reference: ${m[1]}`);
  assert.ok(!/@import|url\(\s*['"]?http/i.test(html));
  assert.doesNotThrow(() => new Function(scriptOf(html)));
});

test("an empty audit renders without throwing and says so", () => {
  const html = renderReport(normalizeFindings({}), { ...meta, sealed: false, canaryHits: null }, {});
  assert.ok(html.includes("No leak found"));
  assert.ok(html.includes("Seal check failed"));
  assert.ok(html.includes("None found."));
});

test("writeReport writes report.html into the run directory", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "lf-report-")), "run");
  const path = writeReport(dir, findings(), meta);
  assert.equal(path, join(dir, "report.html"));
  assert.ok(existsSync(path));
  assert.ok(readFileSync(path, "utf8").includes("$348"));
});
