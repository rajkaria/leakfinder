/**
 * The seed's plan and pnpm verify's drift rules, offline. If these disagree,
 * the demo's headline numbers are wrong before the agent even runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import type Stripe from "stripe";
import { APP_USERS, COHORTS, PRO_CENTS, answerKey, appRowsFor, assertDemoDatabase, insertRows, materialize, plan, snapshotOf, stripeSubsOf, sweepPreviousSeed } from "../src/seed.js";
import type { Seeded } from "../src/seed.js";
import { countsOf, driftFrom, loadApp, loadStripe, monthlyCents, pgClient, pool, retry429 } from "../src/verify.js";
import type { AppSnapshot, StripeSub } from "../src/verify.js";
import { FakeStripe, withFakeStripe } from "./fake-stripe.js";

const PRICE = { id: "price_pro", unit_amount: PRO_CENTS, interval: "month" };

/** What the seed would create, with fake ids standing in for Stripe's. */
function fakeSeed(): Seeded[] {
  return plan().map((p) => {
    const spec = COHORTS[p.cohort];
    return {
      ...p,
      userId: spec.appUser ? `00000000-0000-4000-8000-${String(p.n).padStart(12, "0")}` : null,
      customerId: spec.customer ? `cus_${p.n}` : null,
      sub: spec.sub ? { id: `sub_${p.n}`, status: spec.sub.status, cancelAtPeriodEnd: !!spec.sub.cancelAtPeriodEnd, periodEnd: 1_800_000_000, monthlyCents: PRO_CENTS } : null,
    };
  });
}

function world(seeded = fakeSeed()) {
  const rows = appRowsFor(seeded, PRICE.id, Date.parse("2026-10-18T00:00:00Z"));
  return { seeded, rows, app: snapshotOf(rows, PRICE), stripe: stripeSubsOf(seeded) };
}

const ids = (xs: { user_id?: string; subscription_id?: string }[], k: "user_id" | "subscription_id") => new Set(xs.map((x) => x[k]));

test("the plan keeps the headline numbers", () => {
  const people = plan();
  const users = people.filter((p) => COHORTS[p.cohort].appUser);
  assert.equal(users.length, APP_USERS);
  assert.equal(new Set(people.map((p) => p.email)).size, people.length, "emails are unique");
  const count = (c: keyof typeof COHORTS) => people.filter((p) => p.cohort === c).length;
  assert.equal(count("never_paid") + count("cancelled_unsynced"), 12);
  assert.equal(count("never_paid"), 7);
  assert.equal(count("cancelled_unsynced"), 5);
  assert.equal(count("orphan_payer"), 3);
  assert.equal(count("trialing"), 2);
  assert.equal(count("cancelling"), 2);
  assert.equal(count("free_customer"), 3);
  assert.deepEqual(plan(), people, "same layout on every run");
  // Drift is spread through the table, not the first rows.
  assert.notDeepEqual(users.slice(0, 12).map((p) => p.cohort), Array(12).fill("paying"));
});

test("the drift rules find exactly what the seed planted, and $348/month", () => {
  const { seeded, app, stripe } = world();
  const f = driftFrom(app, stripe);
  const key = answerKey(seeded);
  assert.deepEqual(countsOf(f), { pro_without_subscription: 12, payers_without_account: 3, stale_subscription_rows: 5, monthly_leak_cents: 34_800 });
  assert.deepEqual(f.totals, { app_users: 252, app_pro_entitlements: 48, stripe_active_subscriptions: 39 });
  assert.deepEqual(f.totals, key.totals);

  assert.deepEqual(ids(f.pro_without_subscription, "user_id"), ids(key.pro_without_subscription, "user_id"));
  assert.deepEqual(ids(f.payers_without_account, "subscription_id"), ids(key.payers_without_account, "subscription_id"));
  assert.deepEqual(ids(f.stale_subscription_rows, "subscription_id"), ids(key.stale_subscription_rows, "subscription_id"));
  const causes = new Map(f.pro_without_subscription.map((r) => [r.user_id, r.cause]));
  for (const k of key.pro_without_subscription) assert.equal(causes.get(k.user_id), k.cause);
  for (const r of f.stale_subscription_rows) assert.deepEqual([r.app_status, r.stripe_status], ["active", "canceled"]);
  assert.ok(f.pro_without_subscription.every((r) => r.monthly_cents === PRO_CENTS && r.plan === "pro"));
});

test("noise is not drift: trials, cancel-at-period-end and free users with a Stripe customer", () => {
  const { seeded, app, stripe } = world();
  const f = driftFrom(app, stripe);
  const flagged = new Set([...f.pro_without_subscription.map((r) => r.user_id), ...f.stale_subscription_rows.map((r) => r.user_id)]);
  const flaggedSubs = new Set([...f.payers_without_account, ...f.stale_subscription_rows].map((r) => r.subscription_id));
  for (const c of ["trialing", "cancelling", "free_customer", "paying"] as const) {
    const people = seeded.filter((s) => s.cohort === c);
    assert.ok(people.length > 0);
    for (const s of people) {
      assert.ok(!flagged.has(s.userId!), `${c} user flagged`);
      if (s.sub) assert.ok(!flaggedSubs.has(s.sub.id), `${c} subscription flagged`);
    }
  }
  // The noise rows really are in the data, so the test above means something.
  assert.equal(app.subscriptions.filter((r) => r.status === "trialing").length, 2);
  assert.equal(seeded.filter((s) => s.sub?.cancelAtPeriodEnd).length, 2);
  assert.equal(app.customers.length, 32 + 2 + 2 + 5 + 7 + 3);
});

test("the answer key matches the contract and names a grep target that is in A", () => {
  const { seeded } = world();
  const key = answerKey(seeded);
  assert.equal(key.monthly_leak_cents, 34_800);
  assert.deepEqual(
    { a: key.planted_summary.pro_without_subscription, never: key.planted_summary.never_paid, unsynced: key.planted_summary.cancelled_unsynced, b: key.planted_summary.payers_without_account, c: key.planted_summary.stale_subscription_rows },
    { a: 12, never: 7, unsynced: 5, b: 3, c: 5 },
  );
  const target = seeded.find((s) => s.email === key.grep_target_email);
  assert.equal(target?.cohort, "cancelled_unsynced");
  assert.ok(key.pro_without_subscription.some((r) => r.user_id === target!.userId));
  for (const r of key.payers_without_account) assert.match(r.stripe_customer_id, /^cus_/);
  assert.equal(JSON.stringify(key).split("@leakfinder.test").length - 1, 1, "the grep target is the only email in the key");
});

test("after a full apply the rules read zeros", () => {
  const { app, stripe } = world();
  const before = driftFrom(app, stripe);
  const revoke = new Set(before.pro_without_subscription.map((r) => r.user_id));
  const cancel = new Set(before.payers_without_account.map((r) => r.subscription_id));
  const status = new Map(stripe.map((s) => [s.id, s.status]));
  const fixedApp: AppSnapshot = {
    ...app,
    entitlements: app.entitlements.map((e) => (revoke.has(e.user_id) ? { ...e, plan: "free" } : e)),
    subscriptions: app.subscriptions.map((r) => ({ ...r, status: status.get(r.id) ?? r.status })),
  };
  const fixedStripe: StripeSub[] = stripe.map((s) => (cancel.has(s.id) ? { ...s, status: "canceled" } : s));
  assert.deepEqual(countsOf(driftFrom(fixedApp, fixedStripe)), { pro_without_subscription: 0, payers_without_account: 0, stale_subscription_rows: 0, monthly_leak_cents: 0 });
});

test("a subscription the seed did not create counts as a payer with no account (why the seed warns)", () => {
  const { app, stripe } = world();
  const f = driftFrom(app, [...stripe, { id: "sub_someone_else", customer: "cus_someone_else", status: "active", monthly_cents: 900 }]);
  assert.equal(f.payers_without_account.length, 4);
  assert.equal(f.totals.stripe_active_subscriptions, 40);
});

// Small hand-built cases for the edges of each rule.
const base = (): AppSnapshot => ({
  users: [
    { id: "u1", email: "a@x.test" },
    { id: "u2", email: "b@x.test" },
  ],
  customers: [],
  subscriptions: [],
  entitlements: [],
  prices: [{ id: "p_m", unit_amount: 2900, interval: "month" }],
});

test("rules: past_due is not paying, and an app row Stripe never heard of is stale as `missing`", () => {
  const app = base();
  app.customers = [{ user_id: "u1", stripe_customer_id: "cus_1" }];
  app.subscriptions = [
    { id: "sub_1", user_id: "u1", status: "active", price_id: "p_m" },
    { id: "sub_ghost", user_id: "u2", status: "active", price_id: "p_m" },
  ];
  app.entitlements = [
    { user_id: "u1", plan: "pro" },
    { user_id: "u2", plan: "pro" },
  ];
  const f = driftFrom(app, [{ id: "sub_1", customer: "cus_1", status: "past_due", monthly_cents: 2900 }]);
  assert.deepEqual(
    f.pro_without_subscription.map((r) => [r.user_id, r.cause]),
    [
      ["u1", "stripe_past_due"],
      ["u2", "stripe_missing"],
    ],
  );
  assert.deepEqual(
    f.stale_subscription_rows.map((r) => [r.subscription_id, r.stripe_status]),
    [
      ["sub_1", "past_due"],
      ["sub_ghost", "missing"],
    ],
  );
  assert.equal(f.payers_without_account.length, 0, "past_due is not paying, so not a payer either");
});

test("rules: trialing pays; a subscription row maps a payer even without a customers row", () => {
  const app = base();
  app.subscriptions = [{ id: "sub_1", user_id: "u1", status: "trialing", price_id: "p_m" }];
  app.entitlements = [{ user_id: "u1", plan: "pro" }];
  const f = driftFrom(app, [{ id: "sub_1", customer: "cus_unknown", status: "trialing", monthly_cents: 2900 }]);
  assert.deepEqual(countsOf(f), { pro_without_subscription: 0, payers_without_account: 0, stale_subscription_rows: 0, monthly_leak_cents: 0 });
});

test("rules: plan names are case-insensitive, revoked is not paid, duplicate entitlements count once, yearly prices leak a twelfth", () => {
  const app = base();
  app.prices = [{ id: "p_y", unit_amount: 24_000, interval: "year" }];
  app.entitlements = [
    { user_id: "u1", plan: " PRO " },
    { user_id: "u1", plan: "pro" },
    { user_id: "u2", plan: "revoked" },
  ];
  const f = driftFrom(app, []);
  assert.equal(f.pro_without_subscription.length, 1);
  assert.equal(f.totals.app_pro_entitlements, 1);
  assert.equal(f.monthly_leak_cents, 2000);
  assert.equal(f.pro_without_subscription[0].cause, "never_paid");
});

test("monthlyCents sums every item's price per month", () => {
  const item = (unit_amount: number, interval: string, quantity = 1, interval_count = 1) => ({ price: { unit_amount, recurring: { interval, interval_count } }, quantity });
  const sub = (items: unknown[]) => ({ items: { data: items } }) as unknown as Stripe.Subscription;
  assert.equal(monthlyCents(sub([item(2900, "month")])), 2900);
  assert.equal(monthlyCents(sub([item(2900, "month", 3)])), 8700);
  assert.equal(monthlyCents(sub([item(24_000, "year")])), 2000);
  assert.equal(monthlyCents(sub([item(9000, "month", 1, 3)])), 3000);
  assert.equal(monthlyCents(sub([{ price: { unit_amount: 500, recurring: null }, quantity: 1 }])), 0, "one-off prices are not monthly");
});

test("pool keeps order and never exceeds its limit", async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await pool(Array.from({ length: 30 }, (_, i) => i), 8, async (i) => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, 1 + (i % 4)));
    inFlight--;
    return i * 2;
  });
  assert.deepEqual(out, Array.from({ length: 30 }, (_, i) => i * 2));
  assert.equal(peak, 8);
});

test("retry429 retries rate limits only", async () => {
  let calls = 0;
  const v = await retry429(
    async () => {
      if (++calls < 3) throw Object.assign(new Error("rate limited"), { statusCode: 429 });
      return "ok";
    },
    5,
    1,
  );
  assert.equal(v, "ok");
  assert.equal(calls, 3);
  let other = 0;
  await assert.rejects(
    retry429(
      async () => {
        other++;
        throw Object.assign(new Error("bad request"), { statusCode: 400 });
      },
      5,
      1,
    ),
  );
  assert.equal(other, 1);
});

// ---------------------------------------------------------------- against a fake Stripe, through the real SDK
//
// The fake in test/fake-stripe.ts, driven by the real stripe-node v23 client,
// so these tests check the requests the seed actually sends (paths,
// form-encoded params, pagination, expand) and, above all, that the sweep
// deletes only what carries the seed's tag.

/** An account with the previous seed in it, and objects that belong to someone else. */
function accountWithLeftovers(fake: FakeStripe) {
  const tag = { leakfinder_seed: "1" };
  const seedPrice = fake.price({ metadata: tag });
  const seedProduct = fake.product({ metadata: tag });
  const theirPrice = fake.price();
  const theirProduct = fake.product();
  const c1 = fake.customer({ metadata: tag });
  const s1 = fake.sub(c1.id, seedPrice, { metadata: tag });
  const c2 = fake.customer({ metadata: tag });
  fake.sub(c2.id, seedPrice, { metadata: tag, status: "canceled" });
  const c3 = fake.customer({ metadata: tag });
  const f1 = fake.customer({ metadata: { plan: "pro" } });
  const fs1 = fake.sub(f1.id, theirPrice);
  const f2 = fake.customer();
  const fs2 = fake.sub(f2.id, theirPrice, { status: "trialing" });
  const f3 = fake.customer();
  // A tagged subscription on an untagged customer: cancel the subscription, keep the customer.
  const f4 = fake.customer();
  const s4 = fake.sub(f4.id, seedPrice, { metadata: tag });
  return { seedPrice, seedProduct, theirPrice, theirProduct, seedCustomers: [c1, c2, c3], s1, foreign: [f1, f2, f3, f4], fs1, fs2, s4 };
}

function assertOnlySeedRemoved(fake: FakeStripe, a: ReturnType<typeof accountWithLeftovers>) {
  for (const c of a.seedCustomers) assert.ok(!fake.customers.has(c.id), "seed customer deleted");
  for (const c of a.foreign) assert.ok(fake.customers.has(c.id), "foreign customer kept");
  assert.equal(a.s1.status, "canceled");
  assert.equal(a.s4.status, "canceled");
  assert.equal(a.fs1.status, "active", "foreign subscription untouched");
  assert.equal(a.fs2.status, "trialing", "foreign subscription untouched");
  assert.equal(a.seedPrice.active, false);
  assert.equal(a.seedProduct.active, false);
  assert.equal(a.theirPrice.active, true);
  assert.equal(a.theirProduct.active, true);
  const foreignIds = new Set([...a.foreign.map((c) => c.id), a.fs1.id, a.fs2.id, a.theirPrice.id, a.theirProduct.id]);
  const touched = fake.calls.filter((c) => !c.startsWith("GET")).map((c) => c.split("/").pop()!);
  assert.deepEqual(touched.filter((id) => foreignIds.has(id)), [], "no write ever names a foreign object");
}

test("sweep: removes exactly the tagged objects, even ones search has not indexed yet", async () => {
  await withFakeStripe(async (fake, stripe) => {
    const a = accountWithLeftovers(fake);
    fake.searchLag.add(a.seedCustomers[0].id); // still found: its live subscription carries the tag
    const r = await sweepPreviousSeed(stripe);
    assert.equal(r.via, "search");
    assertOnlySeedRemoved(fake, a);
    assert.equal(r.foreign, 2);
    assert.equal(r.foreignPaying, 2, "the trial counts as paying, as in the audit");
    assert.equal(r.cancelled, 1, "only the subscription whose customer stays is cancelled one by one");
    assert.equal(r.failed, 0);
  });
});

test("sweep: falls back to a paginated list when search is unavailable (Stripe accounts in India)", async () => {
  await withFakeStripe(async (fake, stripe) => {
    const a = accountWithLeftovers(fake);
    for (let i = 0; i < 230; i++) fake.customer({ metadata: i % 2 ? {} : { leakfinder_seed: "0" } });
    const late = fake.customer({ metadata: { leakfinder_seed: "1" } }); // on the first page
    fake.searchWorks = false;
    const r = await sweepPreviousSeed(stripe);
    assert.equal(r.via, "list");
    assertOnlySeedRemoved(fake, a);
    assert.ok(!fake.customers.has(late.id));
    assert.equal(fake.customers.size, 230 + a.foreign.length, "the 230 untagged or differently tagged customers survive");
    assert.ok(fake.calls.filter((c) => c === "GET /v1/customers").length >= 3, "walked every page");
  });
});

test("seed against fake Stripe: what the SDK creates reads back through verify's loader as 12 · 3 · 5 · $348", async () => {
  await withFakeStripe(async (fake, stripe) => {
    const foreign = fake.customer();
    const theirs = fake.sub(foreign.id, fake.price());
    const price = fake.price({ metadata: { leakfinder_seed: "1" } });
    const seeded = await pool(plan(), 8, (p) => materialize(stripe, p, price.id));

    for (const s of seeded) {
      const spec = COHORTS[s.cohort];
      if (s.sub) assert.equal(s.sub.status, spec.sub!.status, `${s.cohort} ends ${spec.sub!.status}`);
      if (!s.customerId) continue;
      const c = fake.customers.get(s.customerId)!;
      assert.equal(c.metadata.leakfinder_seed, "1", "customer tagged");
      assert.equal(!!c.invoice_settings.default_payment_method, !!spec.sub, "a card only for people who subscribe");
      if (s.sub) {
        assert.equal(fake.subs.get(s.sub.id)!.metadata.leakfinder_seed, "1", "subscription tagged");
        assert.equal(s.sub.periodEnd, fake.subs.get(s.sub.id)!.items.data[0].current_period_end, "period end read from the item");
        assert.equal(s.sub.monthlyCents, PRO_CENTS);
      }
    }
    assert.equal(seeded.filter((s) => s.cohort === "cancelling" && s.sub?.cancelAtPeriodEnd).length, 2);

    const rows = appRowsFor(seeded, price.id);
    const app = snapshotOf(rows, { id: price.id, unit_amount: PRO_CENTS, interval: "month" });
    const live = await loadStripe(stripe, [...app.subscriptions.map((r) => r.id), "sub_gone"]);
    assert.ok(!live.some((s) => s.id === "sub_gone"), "a 404 is absent, not an error");
    assert.ok(live.filter((s) => s.status === "canceled").length === 5, "the cancelled five fetched one by one");
    const counts = countsOf(driftFrom(app, live.filter((s) => s.id !== theirs.id)));
    assert.deepEqual(counts, { pro_without_subscription: 12, payers_without_account: 3, stale_subscription_rows: 5, monthly_leak_cents: 34_800 });
    assert.equal(countsOf(driftFrom(app, live)).payers_without_account, 4, "someone else's subscription shows up as B");

    // A second seed run starts by removing all of it, and nothing else.
    const r = await sweepPreviousSeed(stripe);
    assert.equal(r.customers, seeded.filter((s) => s.customerId).length);
    assert.deepEqual([...fake.customers.keys()], [foreign.id]);
    assert.equal(theirs.status, "active");
    assert.equal(r.foreignPaying, 1);
  });
});

test("pgClient keeps TLS verification on Neon URLs without pg's sslmode warning", async () => {
  const warnings: string[] = [];
  const onWarning = (w: Error) => warnings.push(w.message);
  process.on("warning", onWarning);
  const params = (c: pg.Client) => (c as unknown as { connectionParameters: { ssl: unknown; password: string; host: string } }).connectionParameters;
  try {
    const neon = "postgresql://app:p%40ss@ep-x-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
    const quiet = params(pgClient(neon));
    assert.ok(quiet.ssl, "TLS on and verified, as pg does for sslmode=require today");
    assert.equal(quiet.password, "p@ss");
    assert.equal(quiet.host, "ep-x-pooler.us-east-2.aws.neon.tech");
    assert.equal(params(pgClient("postgresql://u:p@localhost/db")).ssl, false, "no sslmode, no TLS, as before");
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(warnings.filter((w) => w.includes("SECURITY WARNING")), []);
    // The check above can see the warning: a plain client with the same URL prints it.
    new pg.Client({ connectionString: neon });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(warnings.filter((w) => w.includes("SECURITY WARNING")).length, 1);
  } finally {
    process.off("warning", onWarning);
  }
});

// ---------------------------------------------------------------- Postgres side, without a server

/** Records queries and answers from a script, enough to drive the seed's SQL helpers. */
function fakeDb(answer: (sql: string) => unknown[] | Error = () => []) {
  const queries: { sql: string; params?: unknown[] }[] = [];
  const db = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      const a = answer(sql);
      if (a instanceof Error) throw a;
      return { rows: a };
    },
  } as unknown as pg.ClientBase;
  return { db, queries };
}

test("every column the seed inserts exists in seed/schema.sql", async () => {
  const { readFileSync } = await import("node:fs");
  const sql = readFileSync(new URL("../seed/schema.sql", import.meta.url), "utf8");
  const tables = new Map<string, Set<string>>();
  for (const [, name, body] of sql.matchAll(/create table (\w+) \(([^;]+)\);/g)) {
    tables.set(name, new Set(body.split("\n").map((l) => l.trim().split(/\s+/)[0]?.replace(/"/g, "")).filter(Boolean)));
  }
  const rows = appRowsFor(fakeSeed(), PRICE.id);
  for (const [table, list] of Object.entries(rows)) {
    assert.ok(list.length, `${table} has rows`);
    for (const col of Object.keys(list[0])) assert.ok(tables.get(table)?.has(col), `${table}.${col} is in schema.sql`);
  }
});

test("insertRows writes one multi-row insert per 500 rows, values as parameters", async () => {
  const { db, queries } = fakeDb();
  const rows = appRowsFor(fakeSeed(), PRICE.id);
  await insertRows(db, "users", rows.users);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /^insert into users \("id","email","full_name","created_at"\) values \(\$1,\$2,\$3,\$4\),\(\$5,/);
  assert.equal(queries[0].params!.length, 252 * 4);
  assert.ok(!queries[0].sql.includes("@leakfinder.test"), "no value is spliced into the SQL");
  const many = Array.from({ length: 1201 }, (_, i) => ({ user_id: `u${i}`, plan: "free", source: "signup" }));
  const second = fakeDb();
  await insertRows(second.db, "entitlements", many);
  assert.deepEqual(second.queries.map((q) => q.params!.length), [1500, 1500, 603]);
});

test("the seed only resets a database it filled", async () => {
  const fresh = fakeDb((sql) => (sql.includes("to_regclass") ? [{ present: false }] : []));
  await assertDemoDatabase(fresh.db);
  const ours = fakeDb((sql) => (sql.includes("to_regclass") ? [{ present: true }] : [{ n: 0 }]));
  await assertDemoDatabase(ours.db);
  const theirs = fakeDb((sql) => (sql.includes("to_regclass") ? [{ present: true }] : [{ n: 3 }]));
  await assert.rejects(assertDemoDatabase(theirs.db), /3 rows the seed did not create/);
  const otherShape = fakeDb((sql) => (sql.includes("to_regclass") ? [{ present: true }] : new Error('column "email" does not exist')));
  await assert.rejects(assertDemoDatabase(otherShape.db), /users table the seed did not create/);
});

test("loadApp sends one query at a time (pg 8.2x prints a DeprecationWarning on a busy client, pg 9 throws)", async () => {
  let inFlight = 0;
  let peak = 0;
  const db = {
    query: async (sql: string) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return { rows: sql.includes("from prices") ? [{ id: "p_m", unit_amount: "2900", interval: "month" }] : [] };
    },
  } as unknown as pg.ClientBase;
  const app = await loadApp(db);
  assert.equal(peak, 1);
  assert.deepEqual(app.prices, [{ id: "p_m", unit_amount: 2900, interval: "month" }], "unit_amount read as a number");
});
