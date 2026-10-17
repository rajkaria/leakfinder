/**
 * The report: the demo's hero screen. One self-contained page (no external
 * requests, locked down by CSP) rendered from findings.json. findings.json is
 * written by agent-authored Python, so every value on the page is escaped.
 * When served from the sandbox (`live`), the "Recover it" buttons POST to the
 * in-VM server (vm/server.py) on the same origin.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scoreTotals } from "./score.js";
import type { Findings, FixSummary, RunMeta, Score } from "./types.js";

export interface ReportOpts {
  score?: Score | null;
  /** A fix.py result to show: the audit's dry-run plan, or the applied result. */
  summary?: FixSummary | null;
  /** Served from the sandbox: show Dry run / Apply buttons wired to the in-VM server. */
  live?: boolean;
  /** The seed's canary email, for the grep line. */
  canary?: string | null;
  /** When the summary was applied (ISO). */
  appliedAt?: string | null;
  /** Set when the agent could not produce a working fix script; replaces the buttons. */
  fixError?: string | null;
}

/**
 * Formatters shared by this module and the page's own script, so a result the
 * CLI rendered and one the Apply button rendered are byte-for-byte the same.
 * Plain ES5 on purpose: it runs in Node via `new Function` and in any browser.
 */
const FMT_JS = String.raw`
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function int(v) { var n = Math.round(Number(v)); return isFinite(n) ? n : 0; }
function num(v) { return int(v).toLocaleString("en-US"); }
function money(c) {
  c = int(c);
  var a = Math.abs(c);
  return (c < 0 ? "-$" : "$") + (a / 100).toLocaleString("en-US", { minimumFractionDigits: a % 100 ? 2 : 0, maximumFractionDigits: 2 });
}
function pl(n, one, many) { n = int(n); return num(n) + " " + (n === 1 ? one : many || one + "s"); }
function when(iso) {
  var d = new Date(iso);
  return !iso || isNaN(d.getTime()) ? "" : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function summaryLine(s) {
  if (s.mode === "applied") return [
    "Invoiced " + money(s.invoiced_cents) + " to " + pl(s.invoices, "user"),
    "Refunded " + money(s.refunded_cents) + " to " + pl(s.refunds, "payer"),
    pl(s.revoked, "entitlement") + " revoked",
    pl(s.rows_synced, "row") + " synced",
    money(s.leak_closed_cents) + "/month closed"
  ].join(" · ");
  return [
    "Would invoice " + money(s.invoiced_cents) + " to " + pl(s.invoices, "user"),
    "refund " + money(s.refunded_cents) + " to " + pl(s.refunds, "payer"),
    "revoke " + pl(s.revoked, "entitlement"),
    "sync " + pl(s.rows_synced, "row"),
    "close " + money(s.leak_closed_cents) + "/month"
  ].join(" · ");
}
function summaryHtml(s, at) {
  var done = s.mode === "applied";
  function stat(v, k) { return '<div class="stat"><div class="stat-v">' + v + '</div><div class="stat-k">' + esc(k) + "</div></div>"; }
  return '<div class="sum ' + (done ? "is-applied" : "is-dry") + '">' +
    '<div class="sum-head"><span class="tag ' + (done ? "tag-ok" : "tag-warn") + '"><i></i>' +
    (done ? "Applied in Stripe test mode" : "Dry run · nothing changed") + "</span>" +
    (when(at) ? '<span class="sum-at">' + esc(when(at)) + "</span>" : "") + "</div>" +
    '<div class="sum-grid">' +
    '<div class="stat stat-hero"><div class="stat-k">' + (done ? "Leak closed" : "Leak this closes") + '</div><div class="stat-v">' +
    money(s.leak_closed_cents) + "<small> / month</small></div></div>" +
    stat(money(s.invoiced_cents), (done ? "invoiced · " : "to invoice · ") + pl(s.invoices, "user")) +
    stat(money(s.refunded_cents), (done ? "refunded · " : "to refund · ") + pl(s.refunds, "payer") + (int(s.cancelled) ? " · " + num(s.cancelled) + " cancelled" : "")) +
    stat(num(s.revoked), done ? "entitlements revoked" : "entitlements to revoke") +
    stat(num(s.rows_synced), done ? "rows synced" : "rows to sync") +
    "</div>" +
    '<p class="sum-line">' + esc(summaryLine(s)) + "</p></div>";
}
`;

const fmt = new Function(`${FMT_JS}\nreturn { esc, int, num, money, pl, when, summaryLine, summaryHtml };`)() as {
  esc: (s: unknown) => string;
  int: (v: unknown) => number;
  num: (v: unknown) => string;
  money: (cents: unknown) => string;
  pl: (n: unknown, one: string, many?: string) => string;
  when: (iso: unknown) => string;
  summaryLine: (s: FixSummary) => string;
  summaryHtml: (s: FixSummary, at?: string | null) => string;
};
export const { esc, money, summaryLine } = fmt;
const { num, pl, when, int } = fmt;

/** `?theme=dark|light` forces a theme (handy on a screen share); runs on every page. */
const THEME_JS = String.raw`
(function () {
  var t = new URLSearchParams(location.search).get("theme");
  if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t);
})();
`;

/**
 * The Recover panel, live. Relative URLs, so it talks only to the server that
 * served the page (the sandbox); the server's cookie authorises the POSTs and
 * the token from ?k= rides along as a header for servers that check it.
 */
const LIVE_JS = String.raw`
(function () {
  var box = document.getElementById("recover");
  if (!box || box.getAttribute("data-live") !== "1") return;
  var dry = document.getElementById("btn-dry"), app = document.getElementById("btn-apply");
  var res = document.getElementById("result"), msg = document.getElementById("recover-msg");
  var logBox = document.getElementById("fixlog"), pill = document.getElementById("closed-pill");
  var k = new URLSearchParams(location.search).get("k") || "";
  var APPLY_LABEL = app.textContent, busy = false, done = box.getAttribute("data-applied") === "1", armTimer = 0;

  function say(text, bad) { msg.textContent = text || ""; msg.className = "recover-msg" + (bad ? " bad" : ""); }
  function showLog(lines) {
    if (!lines || !lines.length) return;
    logBox.hidden = false;
    logBox.querySelector("pre").textContent = [].concat(lines).join("\n");
  }
  function setApplied(s, at) {
    done = true;
    res.innerHTML = summaryHtml(s, at);
    dry.disabled = true; app.disabled = true;
    app.classList.remove("armed"); app.classList.add("done"); app.textContent = "Applied";
    box.setAttribute("data-applied", "1");
    if (pill) { pill.querySelector("b").textContent = money(s.leak_closed_cents); pill.hidden = false; }
  }
  function post(path) {
    var h = {}; if (k) h["X-LeakFinder-Token"] = k;
    return fetch(path, { method: "POST", credentials: "same-origin", cache: "no-store", headers: h }).then(function (r) {
      return r.text().then(function (t) {
        var j = null; try { j = JSON.parse(t); } catch (e) {}
        if (!r.ok) {
          var e = new Error((j && j.error) || (j && j.exit_code != null ? "fix.py exited " + j.exit_code : "HTTP " + r.status));
          e.data = j; throw e;
        }
        if (!j) throw new Error("the sandbox did not answer with JSON");
        return j;
      });
    });
  }
  function run(btn, path, label) {
    if (busy || done) return;
    busy = true; dry.disabled = true; app.disabled = true;
    var orig = btn.textContent, t0 = Date.now();
    btn.classList.add("busy");
    function tick() { btn.textContent = label + " " + Math.floor((Date.now() - t0) / 1000) + "s"; }
    tick(); var timer = setInterval(tick, 250);
    say(path === "apply" ? "Running fix.py with APPLY=1 inside the sandbox" : "Running fix.py with APPLY=0 inside the sandbox");
    post(path).then(function (j) {
      showLog(j.log);
      if (!j.summary) throw new Error("fix.py printed no LEAKFINDER_SUMMARY line");
      if (path === "apply") { setApplied(j.summary, j.at); say(""); }
      else { res.innerHTML = summaryHtml(j.summary); say("Nothing was changed. Apply when the plan looks right."); }
    }).catch(function (e) {
      if (e.data) showLog(e.data.log);
      say((path === "apply" ? "Apply" : "Dry run") + " failed: " + e.message, true);
    }).then(function () {
      clearInterval(timer); busy = false; btn.classList.remove("busy");
      if (!done) { btn.textContent = orig; dry.disabled = false; app.disabled = false; }
    });
  }
  dry.addEventListener("click", function () { run(dry, "dryrun", "Dry run"); });
  app.addEventListener("click", function () {
    if (busy || done) return;
    if (!app.classList.contains("armed")) {
      app.classList.add("armed"); app.textContent = "Click again to apply";
      armTimer = setTimeout(function () { app.classList.remove("armed"); app.textContent = APPLY_LABEL; }, 4000);
      return;
    }
    clearTimeout(armTimer); app.classList.remove("armed"); app.textContent = APPLY_LABEL;
    run(app, "apply", "Applying");
  });
  // An apply from the terminal or another tab shows up here without a reload.
  function poll() {
    if (done) return;
    fetch("status.json", { credentials: "same-origin", cache: "no-store", headers: k ? { "X-LeakFinder-Token": k } : {} })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.applied && j.summary) { setApplied(j.summary, j.at); showLog(j.log); } else setTimeout(poll, 5000); })
      .catch(function () { setTimeout(poll, 8000); });
  }
  poll();
})();
`;

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'";

const DROP_PATH = "M12 2.4c-3.7 4.7-6.6 8.4-6.6 11.9a6.6 6.6 0 0 0 13.2 0c0-3.5-2.9-7.2-6.6-11.9Z";
const FAVICON = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${DROP_PATH}" fill="#e5484d"/></svg>`)}`;
const icon = {
  drop: `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="${DROP_PATH}" fill="currentColor"/><path d="M9 14.5a3 3 0 0 0 3 3" stroke="var(--surface)" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>`,
  check: `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M5 10.5l3.2 3.2L15 7" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  cross: `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round"/></svg>`,
  chevron: `<svg class="chev" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M7 8l3 3 3-3" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

const LIGHT = `
  --bg:#f4f5f7; --surface:#ffffff; --sunken:#eef0f3; --line:#e1e4e9; --line-2:#cfd4dc;
  --text:#0b1220; --muted:#545e6e; --faint:#878f9c;
  --leak:#d42a1c; --leak-soft:#fdeceb; --warn:#a35a00; --warn-soft:#fdf2df; --cool:#3a4bd6; --cool-soft:#eceefe;
  --ok:#067a4b; --ok-soft:#e5f6ed; --bad:#c4291c;
  --shadow:0 1px 2px rgba(16,24,40,.05),0 2px 6px rgba(16,24,40,.04);
  --btn:#0b1220; --btn-text:#ffffff;`;
const DARK = `
  color-scheme:dark;
  --bg:#090b0f; --surface:#11141a; --sunken:#0c0f14; --line:#222833; --line-2:#323a48;
  --text:#ebeef3; --muted:#9ba4b3; --faint:#6b7483;
  --leak:#ff6b5e; --leak-soft:#2b1311; --warn:#f1b157; --warn-soft:#2a1d0a; --cool:#8f9cff; --cool-soft:#171a33;
  --ok:#3fd394; --ok-soft:#0c2219; --bad:#ff6b5e;
  --shadow:0 1px 0 rgba(255,255,255,.03) inset;
  --btn:#ebeef3; --btn-text:#0b1220;`;

const CSS = `
:root{color-scheme:light;${LIGHT}}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${DARK}}}
:root[data-theme="dark"]{${DARK}}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased;font-feature-settings:"tnum" 1,"cv11" 1}
code,pre,.mono{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;font-size:.9em}
.wrap{max-width:1100px;margin:0 auto;padding:0 16px 56px}
@media (min-width:700px){.wrap{padding:0 32px 72px}}
h1,h2,h3{margin:0;font-weight:700;letter-spacing:-.015em}
.muted{color:var(--muted)}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:20px 0;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:8px;font-weight:750;font-size:17px;letter-spacing:-.02em;color:var(--text)}
.brand svg{color:var(--leak)}
.top-meta{display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:flex-end;font-size:13px;color:var(--muted)}
.pill{display:inline-flex;align-items:center;gap:7px;padding:4px 10px 4px 9px;border-radius:999px;font-size:12.5px;font-weight:600;border:1px solid var(--line);background:var(--surface)}
.pill i{width:7px;height:7px;border-radius:50%;background:currentColor}
.pill-ok{color:var(--ok)} .pill-bad{color:var(--bad)}
.hero{padding:44px 0 32px}
@media (min-width:700px){.hero{padding:64px 0 44px}}
.eyebrow{display:inline-flex;align-items:center;gap:8px;font-size:12.5px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--leak)}
.eyebrow i{width:8px;height:8px;border-radius:50%;background:currentColor;box-shadow:0 0 0 0 currentColor;animation:pulse 2s infinite}
.hero.is-clean .eyebrow,.hero.is-clean .leak-amt{color:var(--ok)}
@keyframes pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,currentColor 45%,transparent)}70%{box-shadow:0 0 0 9px transparent}100%{box-shadow:0 0 0 0 transparent}}
@media (prefers-reduced-motion:reduce){.eyebrow i{animation:none}}
.leak{display:flex;flex-wrap:wrap;align-items:baseline;column-gap:18px;row-gap:2px;margin:14px 0 14px}
.leak-amt{font-size:clamp(68px,17vw,164px);font-weight:800;letter-spacing:-.05em;line-height:.92;color:var(--leak)}
.leak-unit{font-size:clamp(24px,4.6vw,46px);font-weight:700;letter-spacing:-.03em;line-height:1.1}
.hero-sub{margin:0;font-size:clamp(16px,2vw,19px);color:var(--muted);max-width:760px}
.hero-sub b{color:var(--text);font-weight:650}
.closed{display:inline-flex;align-items:center;gap:8px;margin-top:20px;padding:8px 14px;border-radius:12px;background:var(--ok-soft);color:var(--ok);font-weight:650}
.closed b{font-size:1.1em}
.cards{display:grid;gap:14px;grid-template-columns:1fr}
@media (min-width:860px){.cards{grid-template-columns:repeat(3,1fr);gap:18px}}
.card{background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:20px 22px 22px;box-shadow:var(--shadow);display:flex;flex-direction:column;gap:6px;min-width:0}
.card-head{display:flex;align-items:center;gap:10px;font-weight:650;font-size:15px}
.letter{flex:none;display:inline-grid;place-items:center;width:28px;height:28px;border-radius:8px;font-weight:800;font-size:14px}
.tone-leak{background:var(--leak-soft);color:var(--leak)} .tone-warn{background:var(--warn-soft);color:var(--warn)} .tone-cool{background:var(--cool-soft);color:var(--cool)}
.card-count{display:flex;align-items:baseline;gap:8px;margin-top:8px}
.card-count b{font-size:60px;font-weight:780;letter-spacing:-.04em;line-height:1}
.card-count span{color:var(--muted);font-size:15px}
.card-money{font-size:18px;font-weight:700;letter-spacing:-.01em;line-height:1.35}
.card-money small{font-size:14px;font-weight:550;color:var(--muted)}
.c-leak .card-money{color:var(--leak)} .c-warn .card-money{color:var(--warn)} .c-cool .card-money{color:var(--cool)}
.card-note{margin:4px 0 0;font-size:13.5px;color:var(--muted);line-height:1.5}
.panel{margin-top:22px;background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:22px;box-shadow:var(--shadow);min-width:0}
@media (min-width:700px){.panel{padding:28px 30px}}
.panel-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 14px;margin-bottom:6px}
.panel-head h2{font-size:22px}
.panel-head .muted{font-size:13.5px}
.recover{display:grid;gap:22px;grid-template-columns:1fr}
@media (min-width:960px){.recover{grid-template-columns:minmax(0,5fr) minmax(0,7fr);gap:32px}}
.recover-copy p{margin:8px 0 0;color:var(--muted)}
.testmode{display:inline-block;padding:2px 8px;border-radius:6px;background:var(--warn-soft);color:var(--warn);font-size:11.5px;font-weight:750;letter-spacing:.06em;text-transform:uppercase;vertical-align:middle}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:20px}
.btn{appearance:none;font:inherit;font-weight:650;font-size:15px;min-height:46px;padding:0 20px;border-radius:12px;cursor:pointer;border:1px solid var(--line-2);background:var(--surface);color:var(--text);transition:transform .06s ease,background .15s ease,opacity .15s ease;font-variant-numeric:tabular-nums}
.btn:hover:not(:disabled){background:var(--sunken)}
.btn:active:not(:disabled){transform:translateY(1px)}
.btn:focus-visible{outline:2px solid var(--cool);outline-offset:2px}
.btn:disabled{cursor:default;opacity:.55}
.btn-primary{background:var(--btn);color:var(--btn-text);border-color:transparent}
.btn-primary:hover:not(:disabled){background:var(--btn);opacity:.9}
.btn-primary.armed{background:var(--warn);color:#fff}
.btn.busy{opacity:1;cursor:progress}
.btn-primary.done,.btn-primary.done:disabled{background:var(--ok);color:#fff;opacity:1}
.btn.busy::before{content:"";display:inline-block;width:13px;height:13px;margin-right:9px;vertical-align:-2px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.recover-msg{min-height:1.5em;margin:12px 0 0;font-size:13.5px;color:var(--muted)}
.recover-msg.bad{color:var(--bad);font-weight:600}
.cmds{margin-top:18px;display:grid;gap:8px}
.cmd{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:11px 14px;border-radius:12px;background:var(--sunken);border:1px solid var(--line)}
.cmd code{font-weight:650;color:var(--text)}
.cmd span{font-size:13.5px;color:var(--muted)}
.result{min-width:0;container-type:inline-size}
.empty{height:100%;min-height:150px;display:grid;place-items:center;text-align:center;padding:24px;border:1.5px dashed var(--line-2);border-radius:16px;color:var(--muted);font-size:14px}
.sum-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin-bottom:14px}
.sum-at{font-size:13px;color:var(--muted)}
.tag{display:inline-flex;align-items:center;gap:7px;padding:5px 11px;border-radius:999px;font-size:13px;font-weight:700}
.tag i{width:7px;height:7px;border-radius:50%;background:currentColor}
.tag-ok{background:var(--ok-soft);color:var(--ok)} .tag-warn{background:var(--warn-soft);color:var(--warn)}
.sum-grid{display:grid;gap:10px;grid-template-columns:repeat(2,minmax(0,1fr))}
.stat{padding:14px 16px;border-radius:14px;background:var(--sunken);border:1px solid var(--line);min-width:0}
.stat-v{font-size:26px;font-weight:760;letter-spacing:-.03em;line-height:1.15}
.stat-v small{font-size:15px;font-weight:600;color:var(--muted);letter-spacing:0}
.stat-k{font-size:13px;color:var(--muted);margin-top:2px}
.stat-hero{grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:4px 16px}
.stat-hero .stat-k{order:0;font-size:14px;font-weight:650;color:var(--text);margin:0}
.stat-hero .stat-v{font-size:36px}
.is-applied .stat-hero{background:var(--ok-soft);border-color:transparent}
.is-applied .stat-hero .stat-v{color:var(--ok)}
.is-dry .stat-hero{background:var(--warn-soft);border-color:transparent}
@container (min-width:540px){.sum-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
.sum-line{margin:14px 0 0;font-size:13.5px;color:var(--muted)}
.fixlog{margin-top:14px}
.fixlog summary{cursor:pointer;font-size:13px;color:var(--muted)}
.fixlog pre{margin:8px 0 0;padding:12px 14px;border-radius:12px;background:var(--sunken);border:1px solid var(--line);overflow:auto;max-height:280px;font-size:12px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}
.fix-error{padding:14px 16px;border-radius:14px;background:var(--leak-soft);color:var(--bad);font-weight:600}
.verdict{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:10px 0 18px;font-size:clamp(20px,3vw,26px);font-weight:700;letter-spacing:-.02em}
.verdict .ic{display:inline-grid;place-items:center;width:30px;height:30px;border-radius:50%}
.verdict.ok .ic{background:var(--ok-soft);color:var(--ok)} .verdict.miss .ic{background:var(--warn-soft);color:var(--warn)}
.verdict .sep{color:var(--faint);font-weight:500}
.verdict .x{color:var(--muted);font-weight:600}
.bars{display:grid;gap:12px}
.bar-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 14px;align-items:center}
@media (min-width:700px){.bar-row{grid-template-columns:260px minmax(0,1fr) 120px}}
.bar-l{display:flex;align-items:center;gap:10px;font-size:14px;font-weight:600;min-width:0}
.bar-l .letter{width:22px;height:22px;font-size:12px;border-radius:6px}
.bar{grid-column:1/-1;height:8px;border-radius:99px;background:var(--sunken);overflow:hidden;border:1px solid var(--line)}
@media (min-width:700px){.bar{grid-column:auto}}
.bar i{display:block;height:100%;border-radius:99px;background:var(--ok)}
.bar.partial i{background:var(--warn)}
.bar-n{grid-row:1;grid-column:2;text-align:right;font-size:14px;font-weight:650;white-space:nowrap}
@media (min-width:700px){.bar-n{grid-row:auto;grid-column:auto}}
.bar-n em{font-style:normal;color:var(--warn);font-weight:600;margin-left:6px}
.section-title{font-size:22px;margin:40px 0 12px}
.rec{background:var(--surface);border:1px solid var(--line);border-radius:16px;margin-top:10px;overflow:hidden}
.rec summary{list-style:none;display:flex;align-items:center;gap:10px;padding:15px 18px;cursor:pointer;font-weight:650}
.rec summary::-webkit-details-marker{display:none}
.rec summary:hover{background:var(--sunken)}
.rec-title{flex:1;min-width:0}
.rec-n{color:var(--muted);font-weight:600;font-size:14px}
.chev{color:var(--faint);transition:transform .15s ease;flex:none}
.rec[open] .chev{transform:rotate(180deg)}
.tscroll{overflow-x:auto;border-top:1px solid var(--line)}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th{font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--faint);font-weight:650;text-align:left;padding:10px 18px;background:var(--sunken);white-space:nowrap}
td{padding:10px 18px;border-top:1px solid var(--line);white-space:nowrap;vertical-align:middle}
td.num,th.num{text-align:right}
tbody tr:hover td{background:var(--sunken)}
.cause{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12.5px;font-weight:600;background:var(--leak-soft);color:var(--leak)}
.status{font-weight:650}
.status-bad{color:var(--leak)}
.none{padding:16px 18px;color:var(--muted);border-top:1px solid var(--line)}
.facts{display:grid;grid-template-columns:1fr;margin:14px 0 0}
.fact{display:grid;grid-template-columns:1fr;gap:4px 24px;padding:13px 0;border-top:1px solid var(--line);min-width:0}
.fact:first-child{border-top:0}
@media (min-width:700px){.fact{grid-template-columns:210px minmax(0,1fr)}}
.fact dt{color:var(--muted);font-size:14px}
.fact dd{margin:0;min-width:0;overflow-wrap:anywhere}
.fact dd small{color:var(--muted)}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{display:inline-block;padding:3px 10px;border-radius:8px;background:var(--cool-soft);color:var(--cool);font-size:12.5px;font-weight:600;overflow-wrap:anywhere}
.seal{display:inline-flex;align-items:center;gap:6px;font-weight:700;margin-right:8px}
.seal.ok{color:var(--ok)} .seal.bad{color:var(--bad)}
.term{margin:0;padding:12px 14px;border-radius:12px;background:#0b0e13;color:#d7dce4;font-size:13px;line-height:1.6;overflow-x:auto;white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid var(--line)}
.term .p{color:#7f8897}
.term .z{color:#3fd394;font-weight:700} .term .nz{color:#ff6b5e;font-weight:700}
.hit-ok{color:var(--ok);font-weight:650} .hit-bad{color:var(--bad);font-weight:650}
footer{margin-top:36px;padding-top:18px;border-top:1px solid var(--line);font-size:13px;color:var(--faint);display:flex;flex-wrap:wrap;gap:6px 18px;justify-content:space-between}
`;

const CAUSES: Record<string, string> = {
  never_paid: "never paid",
  cancelled_unsynced: "cancelled in Stripe, app not told",
};
const causeLabel = (c: string) => CAUSES[c] ?? (c.replace(/_/g, " ").trim() || "unknown");

function countBy<T>(items: T[], key: (t: T) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const it of items) m.set(key(it), (m.get(key(it)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
const cents = (rows: { monthly_cents: number }[]) => rows.reduce((n, r) => n + int(r.monthly_cents), 0);
const duration = (s: unknown) => {
  const t = Math.max(0, Math.round(Number(s) || 0));
  return t < 90 ? `${t} s` : `${Math.floor(t / 60)} min ${t % 60} s`;
};

type Tone = "leak" | "warn" | "cool";

function card(o: { letter: string; tone: Tone; title: string; count: number; unit: string; money: string; note: string }) {
  return `<article class="card c-${o.tone}">
<div class="card-head"><span class="letter tone-${o.tone}">${o.letter}</span>${esc(o.title)}</div>
<div class="card-count"><b>${num(o.count)}</b><span>${esc(o.unit)}</span></div>
<div class="card-money">${o.money}</div>
<p class="card-note">${o.note}</p>
</article>`;
}

function table(cols: { h: string; cell: (r: any) => string; num?: boolean }[], rows: any[]) {
  if (!rows.length) return `<div class="none">None found.</div>`;
  const th = cols.map((c) => `<th${c.num ? ' class="num"' : ""}>${esc(c.h)}</th>`).join("");
  const body = rows.map((r) => `<tr>${cols.map((c) => `<td${c.num ? ' class="num"' : ""}>${c.cell(r)}</td>`).join("")}</tr>`).join("");
  return `<div class="tscroll"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function records(letter: string, tone: Tone, title: string, rows: any[], cols: Parameters<typeof table>[0]) {
  return `<details class="rec"><summary><span class="letter tone-${tone}">${letter}</span><span class="rec-title">${esc(title)}</span><span class="rec-n">${pl(rows.length, "row")}</span>${icon.chevron}</summary>${table(cols, rows)}</details>`;
}

const mono = (v: unknown) => `<span class="mono">${esc(v)}</span>`;

function scorePanel(score: Score) {
  const t = scoreTotals(score);
  const clean = t.found === t.planted && t.extra === 0;
  const row = (letter: string, tone: Tone, label: string, p: { found: number; planted: number; extra: number }) => {
    const pct = p.planted ? Math.min(100, Math.round((p.found / p.planted) * 100)) : p.found ? 100 : 0;
    return `<div class="bar-row"><span class="bar-l"><span class="letter tone-${tone}">${letter}</span>${esc(label)}</span><span class="bar${p.found < p.planted ? " partial" : ""}"><i style="width:${pct}%"></i></span><span class="bar-n">${num(p.found)} / ${num(p.planted)}${p.extra ? `<em>+${num(p.extra)} extra</em>` : ""}</span></div>`;
  };
  const leakOk = score.leak_cents.found === score.leak_cents.planted;
  return `<section class="panel score" aria-labelledby="score-h">
<div class="panel-head"><h2 id="score-h">Checked against the answer key</h2><span class="muted">seed/expected.json lists every case the seed planted</span></div>
<div class="verdict ${clean ? "ok" : "miss"}"><span class="ic">${clean ? icon.check : icon.cross}</span><span>${num(t.found)} of ${num(t.planted)} planted found</span><span class="sep">·</span><span class="x">${pl(t.extra, "extra", "extra")}</span></div>
<div class="bars">
${row("A", "leak", "Pro access nobody pays for", score.pro_without_subscription)}
${row("B", "warn", "Paying with no account", score.payers_without_account)}
${row("C", "cool", "Rows out of sync", score.stale_subscription_rows)}
<div class="bar-row"><span class="bar-l">Monthly leak</span><span class="bar${leakOk ? "" : " partial"}"><i style="width:${leakOk ? 100 : Math.min(100, Math.round((score.leak_cents.found / Math.max(1, score.leak_cents.planted)) * 100))}%"></i></span><span class="bar-n">${money(score.leak_cents.found)} / ${money(score.leak_cents.planted)}</span></div>
</div>
</section>`;
}

function recoverPanel(opts: ReportOpts) {
  const s = opts.summary ?? null;
  const applied = s?.mode === "applied";
  const live = !!opts.live && !opts.fixError;
  const result = opts.fixError
    ? `<div class="fix-error">The agent could not produce a working fix script: ${esc(opts.fixError)}</div>`
    : s
      ? fmt.summaryHtml(s, applied ? opts.appliedAt : null)
      : `<div class="empty">No fix has run yet.<br>A dry run plans every change and touches nothing.</div>`;
  const controls = opts.fixError
    ? `<div class="cmds"><div class="cmd"><code>pnpm scan</code><span>run the audit again for a new fix script</span></div></div>`
    : live
      ? `<div class="actions">
<button type="button" class="btn" id="btn-dry"${applied ? " disabled" : ""}>Dry run</button>
<button type="button" class="btn btn-primary${applied ? " done" : ""}" id="btn-apply"${applied ? " disabled" : ""}>${applied ? "Applied" : "Apply in test mode"}</button>
</div>
<p class="recover-msg" id="recover-msg" aria-live="polite"></p>`
      : applied
        ? `<p class="recover-msg">Applied from the terminal with <code>pnpm apply --yes</code>.</p>`
        : `<div class="cmds">
<div class="cmd"><code>pnpm apply</code><span>dry run in a fork of the sandbox</span></div>
<div class="cmd"><code>pnpm apply --yes</code><span>apply in Stripe test mode</span></div>
</div>`;
  return `<section class="panel recover" id="recover" data-live="${live ? "1" : "0"}" data-applied="${applied ? "1" : "0"}" aria-labelledby="recover-h">
<div class="recover-copy">
<div class="panel-head"><h2 id="recover-h">Recover it</h2><span class="testmode">Stripe test mode</span></div>
<p>The agent wrote <code>fix.py</code> for this schema. It invoices the users who had Pro for free, refunds the payers who have no account, revokes the access nobody pays for and syncs the stale rows.</p>
<p>A dry run plans every change and touches nothing. Apply runs the same script against Stripe in test mode.</p>
${controls}
</div>
<div class="result">
<div id="result">${result}</div>
<details class="fixlog" id="fixlog" hidden><summary>fix.py output · emails redacted</summary><pre></pre></details>
</div>
</section>`;
}

function provenance(meta: RunMeta, canary: string | null) {
  const egress = (Array.isArray(meta.egress) ? meta.egress : []).map((h) => `<span class="chip mono">${esc(h)}</span>`).join("");
  const seal = meta.sealed
    ? `<span class="seal ok">${icon.check}Sealed</span>`
    : `<span class="seal bad">${icon.cross}Not sealed</span>`;
  const turns = int(meta.turns);
  const agent = meta.reusedSkill
    ? `${pl(turns, "model turn")} · reused the saved skill for this schema`
    : `${pl(turns, "turn")} · ${pl(meta.rewrites, "rewrite")} <small>(scripts that failed and were rewritten by the agent)</small>`;
  const hits = meta.canaryHits;
  const grep =
    canary != null && hits != null
      ? `<pre class="term"><span class="p">$</span> grep -c "${esc(canary)}" ${esc(meta.transcriptPath)}\n<span class="${hits === 0 ? "z" : "nz"}">${num(hits)}</span></pre>
<small class="${hits === 0 ? "hit-ok" : "hit-bad"}">${hits === 0 ? "The seeded email is in the findings above and nowhere in the transcript of what the model saw." : `${pl(hits, "line")} of the transcript contain the seeded email.`}</small>`
      : `<span class="mono">${esc(meta.transcriptPath)}</span><br><small>No seed answer key on this run, so there is no canary to grep for.</small>`;
  const fact = (k: string, v: string) => `<div class="fact"><dt>${esc(k)}</dt><dd>${v}</dd></div>`;
  return `<section class="panel how" aria-labelledby="how-h">
<div class="panel-head"><h2 id="how-h">How this was produced</h2><span class="muted">every value below was measured by this run</span></div>
<dl class="facts">
${fact("Sandbox", `${mono(meta.sandboxId)} <small>CreateOS micro-VM</small>`)}
${fact("Egress allowlist", `<div class="chips">${egress || '<span class="muted">none recorded</span>'}</div>`)}
${fact("Seal check", `${seal}<span class="mono">${esc(meta.sealDetail)}</span>`)}
${fact("Agent", agent)}
${fact("Model", mono(meta.model))}
${fact("Tokens", `${num(meta.inputTokens)} in · ${num(meta.outputTokens)} out`)}
${fact("Redacted", `${pl(meta.redacted, "email")} removed before reaching the model`)}
${fact("Privacy check", grep)}
${fact("Run time", `${duration(meta.seconds)}${when(meta.startedAt) ? ` <small>· started ${esc(when(meta.startedAt))}</small>` : ""}`)}
</dl>
</section>`;
}

export function renderReport(f: Findings, meta: RunMeta, opts: ReportOpts = {}): string {
  const a = f.pro_without_subscription;
  const b = f.payers_without_account;
  const c = f.stale_subscription_rows;
  const leak = int(f.monthly_leak_cents);
  const applied = opts.summary?.mode === "applied";
  const t = f.totals;

  const aCents = cents(a);
  const bCents = cents(b);
  const aUsers = new Map(a.map((r) => [r.user_id, int(r.monthly_cents)]));
  const cOverlap = c.filter((r) => aUsers.has(r.user_id));
  const cCents = cOverlap.reduce((n, r) => n + (aUsers.get(r.user_id) ?? 0), 0);

  const causes = countBy(a, (r) => r.cause).map(([k, n]) => `${num(n)} ${esc(causeLabel(k))}`).join(" · ");
  const pairGroups = countBy(c, (r) => `app says ${r.app_status || "?"}, Stripe says ${r.stripe_status || "?"}`);
  const pairs =
    pairGroups.length === 1
      ? `${esc(pairGroups[0][0][0].toUpperCase() + pairGroups[0][0].slice(1))}.`
      : pairGroups.map(([k, n]) => `${num(n)}: ${esc(k)}`).join(" · ");

  const scope = [
    t.app_users ? `<b>${num(t.app_users)}</b> app users` : "",
    t.stripe_active_subscriptions ? `<b>${num(t.stripe_active_subscriptions)}</b> paying Stripe subscriptions` : "",
  ].filter(Boolean);
  const sub =
    (leak > 0 ? `<b>${money(leak * 12)}</b> a year. ` : "No access is being given away. ") +
    (scope.length === 2 ? `${scope[0]} checked against ${scope[1]}.` : scope.length ? `${scope[0]} checked.` : "");

  const cards = [
    card({
      letter: "A",
      tone: "leak",
      title: "Pro access nobody pays for",
      count: a.length,
      unit: a.length === 1 ? "user" : "users",
      money: aCents || !a.length ? `${money(aCents)} <small>/ month given away</small>` : `<small>no monthly value reported</small>`,
      note: causes || "Every Pro user has a paying subscription.",
    }),
    card({
      letter: "B",
      tone: "warn",
      title: "Paying with no account",
      count: b.length,
      unit: b.length === 1 ? "payer" : "payers",
      money: bCents || !b.length ? `${money(bCents)} <small>/ month billed, nothing to log into</small>` : `<small>nobody billed without an account</small>`,
      note: b.length ? "Stripe charges them every month. The app has no user to give access to." : "Every paying customer maps to an app user.",
    }),
    card({
      letter: "C",
      tone: "cool",
      title: "Rows out of sync",
      count: c.length,
      unit: c.length === 1 ? "row" : "rows",
      money: cCents ? `${money(cCents)} <small>/ month of the leak</small>` : `<small>no direct charge</small>`,
      note: pairs || "The app's subscription rows match Stripe.",
    }),
  ].join("\n");

  const detail = [
    records("A", "leak", "Pro access nobody pays for", a, [
      { h: "User", cell: (r) => mono(r.user_id) },
      { h: "Email", cell: (r) => mono(r.email) },
      { h: "Plan", cell: (r) => esc(r.plan) },
      { h: "Monthly", cell: (r) => money(r.monthly_cents), num: true },
      { h: "Cause", cell: (r) => `<span class="cause">${esc(causeLabel(r.cause))}</span>` },
    ]),
    records("B", "warn", "Paying with no account", b, [
      { h: "Stripe customer", cell: (r) => mono(r.stripe_customer_id) },
      { h: "Subscription", cell: (r) => mono(r.subscription_id) },
      { h: "Monthly", cell: (r) => money(r.monthly_cents), num: true },
    ]),
    records("C", "cool", "Rows out of sync", c, [
      { h: "User", cell: (r) => mono(r.user_id) },
      { h: "Subscription", cell: (r) => mono(r.subscription_id) },
      { h: "App says", cell: (r) => `<span class="status">${esc(r.app_status)}</span>` },
      { h: "Stripe says", cell: (r) => `<span class="status status-bad">${esc(r.stripe_status)}</span>` },
    ]),
  ].join("\n");

  const live = !!opts.live && !opts.fixError;
  const canary = opts.canary ?? null;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>LeakFinder · ${money(leak)}/month leaking</title>
<link rel="icon" href="${FAVICON}">
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
<header class="top">
<div class="brand">${icon.drop}<span>LeakFinder</span></div>
<div class="top-meta"><span class="pill ${meta.sealed ? "pill-ok" : "pill-bad"}"><i></i>${meta.sealed ? "Sealed sandbox" : "Seal check failed"}</span>${when(meta.startedAt) ? `<span>Audit · ${esc(when(meta.startedAt))}</span>` : ""}</div>
</header>
<section class="hero${leak > 0 ? "" : " is-clean"}">
<div class="eyebrow"><i></i>${leak > 0 ? "Revenue leak found" : "No leak found"}</div>
<h1 class="leak"><span class="leak-amt">${money(leak)}</span><span class="leak-unit">/ month leaking</span></h1>
<p class="hero-sub">${sub}</p>
<div class="closed" id="closed-pill"${applied ? "" : " hidden"}><b>${money(opts.summary?.leak_closed_cents ?? 0)}</b> / month closed in Stripe test mode</div>
</section>
<section class="cards" aria-label="Findings">
${cards}
</section>
${recoverPanel(opts)}
${opts.score ? scorePanel(opts.score) : ""}
<h2 class="section-title">The records</h2>
${detail}
${provenance(meta, canary)}
<footer><span>LeakFinder · rendered from findings.json, written inside the sandbox by agent-authored Python</span><span>${esc(meta.sandboxId)}</span></footer>
</div>
<script>${FMT_JS}${THEME_JS}${live ? LIVE_JS : ""}</script>
</body>
</html>
`;
}

/** Render to <runDir>/report.html and return its path. */
export function writeReport(runDir: string, f: Findings, meta: RunMeta, opts: ReportOpts = {}): string {
  mkdirSync(runDir, { recursive: true });
  const path = join(runDir, "report.html");
  writeFileSync(path, renderReport(f, meta, opts));
  return path;
}
