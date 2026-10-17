import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExpected, scoreAgainstExpected, scoreTotals } from "../src/score.js";
import { normalizeFindings } from "../src/types.js";

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

/** The seed's shape: 7 never paid + 5 cancelled-unsynced, 3 orphan payers, the same 5 out of sync. */
function answerKey() {
  const cancelled = Array.from({ length: 5 }, (_, i) => ({ user_id: uuid(i), subscription_id: `sub_c${i}` }));
  return {
    pro_without_subscription: [
      ...cancelled.map((c) => ({ user_id: c.user_id, cause: "cancelled_unsynced" })),
      ...Array.from({ length: 7 }, (_, i) => ({ user_id: uuid(100 + i), cause: "never_paid" })),
    ],
    payers_without_account: Array.from({ length: 3 }, (_, i) => ({ stripe_customer_id: `cus_o${i}`, subscription_id: `sub_o${i}` })),
    stale_subscription_rows: cancelled.map((c) => ({ ...c, app_status: "active", stripe_status: "canceled" })),
    monthly_leak_cents: 34800,
    grep_target_email: "priya.kapoor32@leakfinder.test",
  };
}

/** What a perfect agent would write to findings.json for that key. */
function perfectFindings(key = answerKey()) {
  return normalizeFindings({
    pro_without_subscription: key.pro_without_subscription.map((p) => ({ ...p, email: "x@leakfinder.test", plan: "pro", monthly_cents: 2900 })),
    payers_without_account: key.payers_without_account.map((p) => ({ ...p, monthly_cents: 2900 })),
    stale_subscription_rows: key.stale_subscription_rows,
    monthly_leak_cents: 34800,
    totals: { app_users: 252, app_pro_entitlements: 44, stripe_active_subscriptions: 35 },
  });
}

test("a perfect run scores 12/12, 3/3, 5/5 with no extras", () => {
  const s = scoreAgainstExpected(perfectFindings(), answerKey());
  assert.deepEqual(s.pro_without_subscription, { found: 12, planted: 12, extra: 0 });
  assert.deepEqual(s.payers_without_account, { found: 3, planted: 3, extra: 0 });
  assert.deepEqual(s.stale_subscription_rows, { found: 5, planted: 5, extra: 0 });
  assert.deepEqual(s.leak_cents, { found: 34800, planted: 34800 });
  assert.deepEqual(scoreTotals(s), { found: 20, planted: 20, extra: 0 });
});

test("extras are found-but-not-planted, and a case reported twice counts once", () => {
  const f = perfectFindings();
  const noise = { user_id: uuid(999), email: "trial@leakfinder.test", plan: "pro", monthly_cents: 2900, cause: "trialing" };
  f.pro_without_subscription.push(noise, { ...noise }, { ...f.pro_without_subscription[0] });
  f.payers_without_account.push({ stripe_customer_id: "cus_noise", subscription_id: "sub_noise", monthly_cents: 2900 });
  const s = scoreAgainstExpected(f, answerKey());
  assert.deepEqual(s.pro_without_subscription, { found: 12, planted: 12, extra: 1 });
  assert.deepEqual(s.payers_without_account, { found: 3, planted: 3, extra: 1 });
  assert.equal(scoreTotals(s).extra, 2);
});

test("misses are counted, and ids match across case and either key", () => {
  const f = perfectFindings();
  f.pro_without_subscription = f.pro_without_subscription.slice(2).map((r) => ({ ...r, user_id: r.user_id.toUpperCase() }));
  // An agent that only reported the customer id for one payer still found it.
  f.payers_without_account[0].subscription_id = "";
  f.stale_subscription_rows.pop();
  const s = scoreAgainstExpected(f, answerKey());
  assert.deepEqual(s.pro_without_subscription, { found: 10, planted: 12, extra: 0 });
  assert.deepEqual(s.payers_without_account, { found: 3, planted: 3, extra: 0 });
  assert.deepEqual(s.stale_subscription_rows, { found: 4, planted: 5, extra: 0 });
});

test("empty findings and a malformed key do not throw", () => {
  const s = scoreAgainstExpected(normalizeFindings({}), { pro_without_subscription: "nope" });
  assert.deepEqual(scoreTotals(s), { found: 0, planted: 0, extra: 0 });
  assert.deepEqual(s.leak_cents, { found: 0, planted: 0 });
});

test("loadExpected returns the key, or null when missing or broken", () => {
  const dir = mkdtempSync(join(tmpdir(), "lf-score-"));
  const good = join(dir, "expected.json");
  const bad = join(dir, "bad.json");
  writeFileSync(good, JSON.stringify(answerKey()));
  writeFileSync(bad, "{ not json");
  assert.equal(loadExpected(good).monthly_leak_cents, 34800);
  assert.equal(loadExpected(bad), null);
  assert.equal(loadExpected(join(dir, "missing.json")), null);
});
