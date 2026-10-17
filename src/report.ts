import { writeFileSync } from "node:fs";
import { join } from "node:path";

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 0 })}`;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

export function writeReport(runDir: string, f: any, meta: { sandboxId: string; turns: number; inputTokens: number; redacted: number; transcriptPath: string }) {
  const a = f.pro_without_subscription ?? [];
  const b = f.payers_without_account ?? [];
  const c = f.stale_subscription_rows ?? [];
  const rows = (items: any[], cols: string[]) =>
    items.length
      ? `<table><tr>${cols.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>${items.map((r) => `<tr>${cols.map((k) => `<td>${esc(k === "monthly_cents" ? money(r[k]) : r[k])}</td>`).join("")}</tr>`).join("")}</table>`
      : `<p class="muted">none</p>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>LeakFinder report</title>
<style>:root{color-scheme:light dark}body{font:15px/1.5 system-ui,sans-serif;max-width:960px;margin:40px auto;padding:0 16px}h1{font-size:28px}h2{margin-top:36px}table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid #8884;padding:6px 8px;text-align:left}.big{font-size:44px;font-weight:700}.muted{opacity:.6}.kpi{display:flex;gap:32px;flex-wrap:wrap}.kpi div{min-width:180px}code{font-size:12px}</style></head><body>
<h1>LeakFinder</h1>
<div class="kpi">
<div><div class="big">${money(f.monthly_leak_cents ?? 0)}</div><div class="muted">per month leaking</div></div>
<div><div class="big">${a.length}</div><div class="muted">users with Pro and no paying subscription</div></div>
<div><div class="big">${b.length}</div><div class="muted">paying customers with no account</div></div>
<div><div class="big">${c.length}</div><div class="muted">subscription rows out of sync</div></div>
</div>
<p class="muted">App: ${esc(f.totals?.app_users)} users, ${esc(f.totals?.app_pro_entitlements)} Pro entitlements. Stripe: ${esc(f.totals?.stripe_active_subscriptions)} active subscriptions.</p>
<h2>A. Pro access, nobody paying</h2>${rows(a, ["user_id", "email", "plan", "monthly_cents", "cause"])}
<h2>B. Paying, no account</h2>${rows(b, ["stripe_customer_id", "subscription_id", "monthly_cents"])}
<h2>C. App thinks active, Stripe says otherwise</h2>${rows(c, ["user_id", "subscription_id", "app_status", "stripe_status"])}
<h2>How this was produced</h2>
<p>The agent wrote the SQL and Stripe code for this schema in ${meta.turns} turn(s) and ran it in CreateOS sandbox <code>${esc(meta.sandboxId)}</code>, whose outbound network reaches only api.stripe.com and the database host. The model received ${meta.inputTokens.toLocaleString()} input tokens: code, schema, counts and errors. ${meta.redacted} email(s) were redacted before reaching it. This page was rendered on your machine from <code>findings.json</code>, which never left the sandbox and your laptop.</p>
<p>Check it yourself: <code>grep -c "&lt;any email above&gt;" ${esc(meta.transcriptPath)}</code> returns 0.</p>
</body></html>`;
  const path = join(runDir, "report.html");
  writeFileSync(path, html);
  return path;
}
