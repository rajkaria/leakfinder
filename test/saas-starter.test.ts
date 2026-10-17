/**
 * The Next.js SaaS Starter demo, offline: the schema file is the starter's
 * migration byte for byte, the plan keeps the headline numbers, the drift
 * rules find exactly what was planted and nothing else, an apply reads zero,
 * and the seed's Stripe side, driven through the real SDK against the fake
 * Stripe, reads back the same.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type pg from "pg";
import type Stripe from "stripe";
import {
  APP_USERS,
  PAID_COHORTS,
  PLAN_NAME,
  PRO_CENTS,
  STARTER_MIGRATION_BLOB,
  STARTER_SCHEMA,
  STARTER_SHA,
  STARTER_SQL_PATH,
  STARTER_TABLES,
  TEAM_COHORTS,
  USER_ID_BASE,
  auditSaasStarterLive,
  driftSaasStarterFrom,
  dropMainDemoTables,
  isPaidTeam,
  loadPlanPrices,
  planStarter,
  seedStarterStripe,
  starterAnswerKey,
  starterRowsFor,
  starterSnapshotOf,
  starterStripeSubsOf,
  unusablePasswordHash,
  writeStarterRows,
} from "../src/starters/saas-starter.js";
import type { SeededTeam, StarterSeeded, StarterSnapshot, StarterTeam } from "../src/starters/saas-starter.js";
import { sweepPreviousSeed } from "../src/seed.js";
import { countsOf, loadStripe } from "../src/verify.js";
import type { StripeSub } from "../src/verify.js";
import { withFakeStripe } from "./fake-stripe.js";

const NOW = Date.parse("2026-10-18T00:00:00Z");
const PRODUCT = "prod_pro";
const PLAN_PRICES = [{ product_id: PRODUCT, monthly_cents: PRO_CENTS }];
const ZERO = { pro_without_subscription: 0, payers_without_account: 0, stale_subscription_rows: 0, monthly_leak_cents: 0 };

/** What the seed would create, with fake ids standing in for Stripe's. */
function fakeSeed(): StarterSeeded {
  const plan = planStarter();
  return {
    productId: PRODUCT,
    priceId: "price_pro",
    teams: plan.teams.map((t): SeededTeam => {
      const spec = TEAM_COHORTS[t.cohort];
      return {
        ...t,
        customerId: spec.customer ? `cus_t${t.id}` : null,
        sub: spec.sub ? { id: `sub_t${t.id}`, status: spec.sub.status, cancelAtPeriodEnd: !!spec.sub.cancelAtPeriodEnd, monthlyCents: PRO_CENTS } : null,
      };
    }),
    orphans: plan.orphans.map((o, i) => ({ email: o.email, customerId: `cus_o${i}`, sub: { id: `sub_o${i}`, status: "active", monthlyCents: PRO_CENTS } })),
  };
}

function world(seeded = fakeSeed()) {
  const rows = starterRowsFor(seeded, NOW);
  return { seeded, rows, app: starterSnapshotOf(rows, PLAN_PRICES), stripe: starterStripeSubsOf(seeded) };
}

const ids = (xs: { user_id?: string; subscription_id?: string }[], k: "user_id" | "subscription_id") => new Set(xs.map((x) => x[k]));
const teamsOf = (seeded: StarterSeeded, c: keyof typeof TEAM_COHORTS) => seeded.teams.filter((t) => t.cohort === c);

// ---------------------------------------------------------------- the schema file

const sql = readFileSync(STARTER_SQL_PATH, "utf8");
const MARKER = /^-- ---- verbatim from nextjs\/saas-starter@([0-9a-f]{40}) below this line ----\n/m;

test("seed/saas-starter.sql is the starter's migration byte for byte, under a header naming its source and licence", () => {
  const m = MARKER.exec(sql);
  assert.ok(m, "marker line present");
  assert.equal(m![1], STARTER_SHA);
  const body = sql.slice(m!.index + m![0].length);
  const blob = createHash("sha1").update(`blob ${Buffer.byteLength(body)}\0`).update(body).digest("hex");
  assert.equal(blob, STARTER_MIGRATION_BLOB, "git blob id of lib/db/migrations/0000_soft_the_anarchist.sql at that commit");
  const header = sql.slice(0, m!.index);
  assert.match(header, new RegExp(`github\\.com/nextjs/saas-starter/blob/${STARTER_SHA}/lib/db/migrations/0000_soft_the_anarchist\\.sql`));
  assert.match(header, /MIT License, Copyright \(c\) 2025 Vercel/);
  // The only statements LeakFinder adds: drop the starter's five tables, and the other demo schema's, so the agent sees one schema.
  const statements = header.split("\n").filter((l) => l.trim() && !l.startsWith("--"));
  assert.deepEqual(statements, [
    "drop table if exists activity_logs, invitations, team_members, teams, users cascade;",
    "drop table if exists entitlements, subscriptions, prices, products, customers cascade;",
  ]);
  for (const t of STARTER_TABLES) assert.match(body, new RegExp(`CREATE TABLE IF NOT EXISTS "${t}" \\(`), `${t} is created`);
  assert.match(body, /CONSTRAINT "teams_stripe_customer_id_unique" UNIQUE\("stripe_customer_id"\)/);
  assert.match(body, /CONSTRAINT "teams_stripe_subscription_id_unique" UNIQUE\("stripe_subscription_id"\)/);
});

/** Columns per table, from the migration's CREATE TABLE statements. */
function schemaColumns() {
  const tables = new Map<string, { cols: Set<string>; notNull: Set<string> }>();
  for (const [, name, body] of sql.matchAll(/CREATE TABLE IF NOT EXISTS "(\w+)" \(([^;]+)\);/g)) {
    const lines = body.split("\n").map((l) => l.trim()).filter((l) => l.startsWith('"'));
    tables.set(name, {
      cols: new Set(lines.map((l) => l.split('"')[1])),
      notNull: new Set(lines.filter((l) => /NOT NULL/.test(l) && !/DEFAULT|serial/.test(l)).map((l) => l.split('"')[1])),
    });
  }
  return tables;
}

test("every column the seed writes exists in the starter's schema, and every required one is filled", () => {
  const tables = schemaColumns();
  assert.deepEqual([...tables.keys()].sort(), [...STARTER_TABLES].sort());
  const { rows } = world();
  for (const [table, list] of Object.entries(rows)) {
    assert.ok(list.length, `${table} has rows`);
    const t = tables.get(table)!;
    for (const row of list as Record<string, unknown>[]) {
      for (const col of Object.keys(row)) assert.ok(t.cols.has(col), `${table}.${col} is in the starter's schema`);
      for (const col of t.notNull) assert.ok(row[col] != null, `${table}.${col} is NOT NULL and filled`);
    }
  }
  // varchar limits the migration sets.
  for (const u of rows.users) assert.ok(u.email.length <= 255 && u.role.length <= 20 && (u.name ?? "").length <= 100);
  for (const t of rows.teams) assert.ok(t.name.length <= 100 && (t.plan_name ?? "").length <= 50 && (t.subscription_status ?? "").length <= 20);
  assert.equal(new Set(rows.teams.flatMap((t) => (t.stripe_customer_id ? [t.stripe_customer_id] : []))).size, rows.teams.filter((t) => t.stripe_customer_id).length, "stripe_customer_id unique");
});

// ---------------------------------------------------------------- the plan

test("the plan keeps the headline numbers: 252 users in teams, 48 on Pro, one owner per team", () => {
  const plan = planStarter();
  const users = plan.teams.flatMap((t) => t.members);
  assert.equal(users.length, APP_USERS);
  assert.equal(new Set(users.map((u) => u.id)).size, APP_USERS, "every user in exactly one team");
  assert.equal(new Set([...users, ...plan.orphans].map((u) => u.email)).size, APP_USERS + 3, "emails unique");
  assert.ok(users.every((u) => u.email.endsWith("@leakfinder.test")));
  for (const t of plan.teams) {
    assert.equal(t.members.filter((m) => m.role === "owner").length, 1, "one owner");
    assert.equal(t.members[0].role, "owner");
    assert.ok(t.members.every((m) => m.joinedDaysAgo <= t.createdDaysAgo && m.joinedDaysAgo >= 0));
  }
  const count = (c: keyof typeof TEAM_COHORTS) => plan.teams.filter((t) => t.cohort === c).length;
  assert.deepEqual(
    { paying: count("paying"), trialing: count("trialing"), cancelling: count("cancelling"), unsynced: count("cancelled_unsynced"), never: count("never_paid"), freeCustomer: count("free_customer") },
    { paying: 32, trialing: 2, cancelling: 2, unsynced: 5, never: 7, freeCustomer: 3 },
  );
  assert.equal(plan.teams.filter((t) => PAID_COHORTS.includes(t.cohort)).length, 48);
  assert.equal(plan.orphans.length, 3);
  assert.ok(plan.teams.filter((t) => t.members.length > 1).length >= 20, "plenty of multi-member teams");
  assert.ok(plan.teams.filter((t) => PAID_COHORTS.includes(t.cohort) && t.members.length > 1).length >= 10, "paid teams with members too");
  // Ids: teams from 1 in creation order, users above USER_ID_BASE in signup order.
  assert.deepEqual(plan.teams.map((t) => t.id), plan.teams.map((_, i) => i + 1));
  assert.ok(users.every((u) => u.id > USER_ID_BASE && u.id <= USER_ID_BASE + APP_USERS));
  assert.ok(Math.max(...plan.teams.map((t) => t.id)) < USER_ID_BASE, "team ids and user ids never collide");
  assert.deepEqual(planStarter(), plan, "same layout on every run");
  assert.notDeepEqual(plan.teams.slice(0, 12).map((t) => t.cohort), Array(12).fill("free"), "drift spread through the table");
});

test("team rows are written the way the starter's checkout route and webhook write them", () => {
  const { seeded, rows } = world();
  const row = new Map(rows.teams.map((t) => [t.id, t]));
  const check = (c: keyof typeof TEAM_COHORTS, want: (t: SeededTeam) => Record<string, unknown>) => {
    for (const t of teamsOf(seeded, c)) {
      const r = row.get(t.id)!;
      assert.deepEqual(
        { stripe_customer_id: r.stripe_customer_id, stripe_subscription_id: r.stripe_subscription_id, stripe_product_id: r.stripe_product_id, plan_name: r.plan_name, subscription_status: r.subscription_status },
        want(t),
        c,
      );
    }
  };
  check("paying", (t) => ({ stripe_customer_id: t.customerId, stripe_subscription_id: t.sub!.id, stripe_product_id: PRODUCT, plan_name: PLAN_NAME, subscription_status: "active" }));
  check("trialing", (t) => ({ stripe_customer_id: t.customerId, stripe_subscription_id: t.sub!.id, stripe_product_id: PRODUCT, plan_name: PLAN_NAME, subscription_status: "trialing" }));
  check("cancelling", (t) => ({ stripe_customer_id: t.customerId, stripe_subscription_id: t.sub!.id, stripe_product_id: PRODUCT, plan_name: PLAN_NAME, subscription_status: "active" }));
  check("cancelled_unsynced", (t) => ({ stripe_customer_id: t.customerId, stripe_subscription_id: t.sub!.id, stripe_product_id: PRODUCT, plan_name: PLAN_NAME, subscription_status: "active" }));
  check("never_paid", (t) => ({ stripe_customer_id: t.customerId, stripe_subscription_id: null, stripe_product_id: PRODUCT, plan_name: PLAN_NAME, subscription_status: "active" }));
  check("free_customer", (t) => ({ stripe_customer_id: t.customerId, stripe_subscription_id: null, stripe_product_id: null, plan_name: null, subscription_status: null }));
  check("free", () => ({ stripe_customer_id: null, stripe_subscription_id: null, stripe_product_id: null, plan_name: null, subscription_status: null }));
  for (const t of teamsOf(seeded, "never_paid")) assert.match(t.customerId!, /^cus_/, "never-paid teams have a Stripe customer a fix can invoice");

  assert.equal(rows.team_members.length, APP_USERS);
  assert.equal(rows.activity_logs.length, APP_USERS * 2, "CREATE_TEAM or ACCEPT_INVITATION, then SIGN_UP, per user");
  assert.equal(rows.invitations.filter((i) => i.status === "accepted").length, APP_USERS - seeded.teams.length, "one accepted invitation per member");
  assert.equal(rows.invitations.filter((i) => i.status === "pending").length, 4);
  assert.ok(rows.users.every((u) => /^\$2a\$10\$[./A-Za-z0-9]{53}$/.test(u.password_hash)));
  assert.notEqual(unusablePasswordHash("a@leakfinder.test"), unusablePasswordHash("b@leakfinder.test"));
});

// ---------------------------------------------------------------- the drift rules

test("the drift rules find exactly what was planted: 12 · 3 · 5 · $348, on teams", () => {
  const { seeded, app, stripe } = world();
  const f = driftSaasStarterFrom(app, stripe);
  const key = starterAnswerKey(seeded);
  assert.deepEqual(countsOf(f), { pro_without_subscription: 12, payers_without_account: 3, stale_subscription_rows: 5, monthly_leak_cents: 34_800 });
  assert.deepEqual(f.totals, { app_users: 252, app_pro_entitlements: 48, stripe_active_subscriptions: 39 });
  assert.deepEqual(f.totals, key.totals);
  assert.deepEqual(ids(f.pro_without_subscription, "user_id"), ids(key.pro_without_subscription, "user_id"));
  assert.deepEqual(ids(f.payers_without_account, "subscription_id"), ids(key.payers_without_account, "subscription_id"));
  assert.deepEqual(ids(f.stale_subscription_rows, "subscription_id"), ids(key.stale_subscription_rows, "subscription_id"));
  const causes = new Map(f.pro_without_subscription.map((r) => [r.user_id, r.cause]));
  for (const k of key.pro_without_subscription) assert.equal(causes.get(k.user_id), k.cause);
  for (const r of f.stale_subscription_rows) assert.deepEqual([r.app_status, r.stripe_status], ["active", "canceled"]);
  assert.ok(f.pro_without_subscription.every((r) => r.monthly_cents === PRO_CENTS && r.plan === PLAN_NAME));
  // The email on an A row is the team owner's.
  const owners = new Map(seeded.teams.map((t) => [String(t.id), t.members[0].email]));
  for (const r of f.pro_without_subscription) assert.equal(r.email, owners.get(r.user_id));
});

test("noise is not drift: trials, cancel-at-period-end, free teams with a Stripe customer, members of paying teams", () => {
  const { seeded, app, stripe } = world();
  const f = driftSaasStarterFrom(app, stripe);
  const flagged = new Set([...f.pro_without_subscription, ...f.stale_subscription_rows].map((r) => r.user_id));
  const flaggedSubs = new Set([...f.payers_without_account, ...f.stale_subscription_rows].map((r) => r.subscription_id));
  for (const c of ["trialing", "cancelling", "free_customer", "paying", "free"] as const) {
    const teams = teamsOf(seeded, c);
    assert.ok(teams.length > 0);
    for (const t of teams) {
      assert.ok(!flagged.has(String(t.id)), `${c} team flagged`);
      if (t.sub) assert.ok(!flaggedSubs.has(t.sub.id), `${c} subscription flagged`);
    }
  }
  assert.equal(app.teams.filter((t) => t.subscription_status === "trialing").length, 2);
  assert.equal(seeded.teams.filter((t) => t.sub?.cancelAtPeriodEnd).length, 2);
  assert.equal(app.teams.filter((t) => t.stripe_customer_id && !t.plan_name).length, 3);
});

/** Apply, in the starter's own terms: A revoked, B cancelled in Stripe, C synced. */
function applied(app: StarterSnapshot, stripe: StripeSub[], revoke: (t: StarterTeam) => StarterTeam, syncC = true) {
  const before = driftSaasStarterFrom(app, stripe);
  const a = new Set(before.pro_without_subscription.map((r) => r.user_id));
  const b = new Set(before.payers_without_account.map((r) => r.subscription_id));
  const c = new Map(before.stale_subscription_rows.map((r) => [r.user_id, r.stripe_status]));
  const teams = app.teams.map((t) => {
    let out = t;
    if (syncC && c.has(t.id)) out = { ...out, subscription_status: c.get(t.id)! };
    if (a.has(t.id)) out = revoke(out);
    return out;
  });
  return driftSaasStarterFrom({ ...app, teams }, stripe.map((s) => (b.has(s.id) ? { ...s, status: "canceled" } : s)));
}

test("after a full apply the rules read zero, whichever way the fix revokes", () => {
  const { app, stripe } = world();
  // As the starter's webhook handles a cancellation: plan, subscription and product cleared, status `canceled`.
  const webhook = (t: StarterTeam): StarterTeam => ({ ...t, stripe_subscription_id: null, stripe_product_id: null, plan_name: null, subscription_status: "canceled" });
  assert.deepEqual(countsOf(applied(app, stripe, webhook)), ZERO);
  // Plan set to a free plan by name.
  assert.deepEqual(countsOf(applied(app, stripe, (t) => ({ ...t, plan_name: "Free" }))), ZERO);
  // Only the paid fields cleared, status left as it was.
  assert.deepEqual(countsOf(applied(app, stripe, (t) => ({ ...t, plan_name: null, stripe_product_id: null }))), ZERO);
  assert.equal(applied(app, stripe, webhook).totals.app_pro_entitlements, 36, "the 36 paying teams keep Pro");
  // A fix that revokes A by clearing plan_name but never syncs C still leaves the 5 stale rows.
  assert.deepEqual(countsOf(applied(app, stripe, (t) => ({ ...t, plan_name: null }), false)), { ...ZERO, stale_subscription_rows: 5 });
});

test("in the starter, syncing a stale status is itself a revoke: C alone leaves only the 7 never-paid teams in A", () => {
  const { app, stripe } = world();
  const f = applied(app, stripe, (t) => t, true);
  assert.deepEqual(countsOf(f), { pro_without_subscription: 7, payers_without_account: 0, stale_subscription_rows: 0, monthly_leak_cents: 7 * PRO_CENTS });
  assert.ok(f.pro_without_subscription.every((r) => r.cause === "never_paid"));
});

const team = (id: string, fields: Partial<StarterTeam> = {}): StarterTeam => ({
  id,
  stripe_customer_id: null,
  stripe_subscription_id: null,
  stripe_product_id: null,
  plan_name: null,
  subscription_status: null,
  ...fields,
});
const base = (teams: StarterTeam[]): StarterSnapshot => ({
  users: [
    { id: "1001", email: "a@x.test", deleted: false },
    { id: "1002", email: "b@x.test", deleted: false },
    { id: "1003", email: "gone@x.test-1003-deleted", deleted: true },
  ],
  teams,
  team_members: [
    { user_id: "1003", team_id: "1", role: "owner" },
    { user_id: "1001", team_id: "1", role: "member" },
    { user_id: "1002", team_id: "2", role: "owner" },
  ],
  plan_prices: [{ product_id: "prod_y", monthly_cents: 2000 }],
});

test("rules: past_due is not paying; a subscription Stripe never heard of is stale as `missing`", () => {
  const app = base([
    team("1", { stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", plan_name: "Pro", subscription_status: "active" }),
    team("2", { stripe_subscription_id: "sub_ghost", plan_name: "Pro", subscription_status: "active" }),
  ]);
  const f = driftSaasStarterFrom(app, [{ id: "sub_1", customer: "cus_1", status: "past_due", monthly_cents: 2900 }]);
  assert.deepEqual(f.pro_without_subscription.map((r) => [r.user_id, r.cause]), [["1", "stripe_past_due"], ["2", "stripe_missing"]]);
  assert.deepEqual(f.stale_subscription_rows.map((r) => [r.subscription_id, r.stripe_status]), [["sub_1", "past_due"], ["sub_ghost", "missing"]]);
  assert.equal(f.payers_without_account.length, 0);
  assert.equal(f.pro_without_subscription[0].email, "a@x.test", "a deleted owner is skipped for the contact email");
  assert.equal(f.totals.app_users, 2, "soft-deleted users are not counted");
});

test("rules: a paying subscription maps through the customer id even when the row lost its subscription id", () => {
  const app = base([team("1", { stripe_customer_id: "cus_1", plan_name: "Pro", subscription_status: "active" })]);
  const f = driftSaasStarterFrom(app, [{ id: "sub_new", customer: "cus_1", status: "active", monthly_cents: 2900 }]);
  assert.deepEqual(countsOf(f), ZERO);
});

test("rules: plan name and status are both needed; `free`, empty and canceled are not paid", () => {
  assert.equal(isPaidTeam({ plan_name: "Pro", subscription_status: "active" }), true);
  assert.equal(isPaidTeam({ plan_name: " Plus ", subscription_status: "TRIALING" }), true);
  assert.equal(isPaidTeam({ plan_name: "Pro", subscription_status: "canceled" }), false);
  assert.equal(isPaidTeam({ plan_name: "Pro", subscription_status: null }), false);
  assert.equal(isPaidTeam({ plan_name: null, subscription_status: "active" }), false);
  assert.equal(isPaidTeam({ plan_name: "  ", subscription_status: "active" }), false);
  assert.equal(isPaidTeam({ plan_name: "free", subscription_status: "active" }), false);
});

test("rules: an unpaid team is worth its own subscription's price, else its product's active price, else the usual one", () => {
  const app = base([
    team("1", { stripe_product_id: "prod_y", plan_name: "Yearly", subscription_status: "active" }),
    team("2", { stripe_product_id: "prod_unknown", plan_name: "Pro", subscription_status: "active" }),
    team("3", { stripe_subscription_id: "sub_c", plan_name: "Pro", subscription_status: "active" }),
  ]);
  const subs: StripeSub[] = [
    { id: "sub_c", customer: "cus_c", status: "canceled", monthly_cents: 4900 },
    { id: "sub_p1", customer: "cus_p1", status: "active", monthly_cents: 2900 },
    { id: "sub_p2", customer: "cus_p2", status: "active", monthly_cents: 2900 },
    { id: "sub_p3", customer: "cus_p3", status: "active", monthly_cents: 9900 },
  ];
  const price = new Map(driftSaasStarterFrom(app, subs).pro_without_subscription.map((r) => [r.user_id, r.monthly_cents]));
  assert.deepEqual(Object.fromEntries(price), { "1": 2000, "2": 2900, "3": 4900 });
});

test("the answer key: team ids in user_id, the starter named, one email (an owner of a cancelled-unsynced team)", () => {
  const { seeded } = world();
  const key = starterAnswerKey(seeded);
  assert.equal(key.schema, `nextjs/saas-starter@${STARTER_SHA}`);
  assert.equal(key.schema, STARTER_SCHEMA);
  assert.equal(key.monthly_leak_cents, 34_800);
  assert.deepEqual(
    { a: key.planted_summary.pro_without_subscription, never: key.planted_summary.never_paid, unsynced: key.planted_summary.cancelled_unsynced, b: key.planted_summary.payers_without_account, c: key.planted_summary.stale_subscription_rows },
    { a: 12, never: 7, unsynced: 5, b: 3, c: 5 },
  );
  const teamIds = new Set(seeded.teams.map((t) => String(t.id)));
  for (const r of [...key.pro_without_subscription, ...key.stale_subscription_rows]) assert.ok(teamIds.has(r.user_id) && r.team_id === r.user_id);
  for (const r of key.pro_without_subscription) assert.ok(Number(r.owner_user_id) > USER_ID_BASE);
  const target = teamsOf(seeded, "cancelled_unsynced").find((t) => t.members[0].email === key.grep_target_email);
  assert.ok(target, "grep target owns a cancelled-unsynced team");
  assert.ok(key.pro_without_subscription.some((r) => r.user_id === String(target!.id)));
  assert.equal(JSON.stringify(key).split("@leakfinder.test").length - 1, 1, "the grep target is the only email in the key");
});

// ---------------------------------------------------------------- Stripe, through the real SDK, against the fake

test("seed against fake Stripe: one Pro price, tagged customers with addresses, and the recount reads 12 · 3 · 5 · $348", async () => {
  await withFakeStripe(async (fake, stripe) => {
    const foreign = fake.customer();
    const theirs = fake.sub(foreign.id, fake.price());
    // What the seed asks Stripe for, as the SDK is called (the fake does not keep addresses).
    const asked: Stripe.CustomerCreateParams[] = [];
    const create = stripe.customers.create.bind(stripe.customers);
    stripe.customers.create = ((params: Stripe.CustomerCreateParams, options?: Stripe.RequestOptions) => (asked.push(params), create(params, options))) as typeof stripe.customers.create;
    const { seeded } = await seedStarterStripe(stripe);
    assert.equal(asked.length, 54);
    for (const p of asked) {
      assert.deepEqual(p.address, { line1: "100 Demo Street", city: "San Francisco", state: "CA", postal_code: "94105", country: "US" }, "a billing address on every customer");
      assert.deepEqual(p.metadata, { leakfinder_seed: "1" }, "tagged, and nothing else: no team id the audit could shortcut on");
    }

    for (const t of seeded.teams) {
      const spec = TEAM_COHORTS[t.cohort];
      assert.equal(!!t.customerId, spec.customer);
      if (t.sub) assert.equal(t.sub.status, spec.sub!.status, `${t.cohort} ends ${spec.sub!.status}`);
      if (!t.customerId) continue;
      const c = fake.customers.get(t.customerId)!;
      assert.equal(c.metadata.leakfinder_seed, "1");
      assert.equal(c.email, t.members[0].email, "the customer is the owner's, as Checkout leaves it");
      assert.equal(!!c.invoice_settings.default_payment_method, !!spec.sub, "a card only for teams that subscribed");
      if (t.sub) assert.equal(fake.subs.get(t.sub.id)!.metadata.leakfinder_seed, "1");
    }
    const created = fake.calls.filter((c) => c === "POST /v1/customers").length;
    assert.equal(created, 51 + 3, "every team with a customer, plus the three orphan payers");
    const proPrices = [...fake.prices.values()].filter((p) => p.product === seeded.productId && p.active);
    assert.deepEqual(proPrices.map((p) => [p.id, p.unit_amount, p.recurring.interval]), [[seeded.priceId, PRO_CENTS, "month"]], "the Pro product has exactly one active price");
    assert.equal(fake.products.get(seeded.productId)!.name, PLAN_NAME);

    const rows = starterRowsFor(seeded, NOW);
    const planPrices = await loadPlanPrices(stripe);
    assert.deepEqual(planPrices.find((p) => p.product_id === seeded.productId), { product_id: seeded.productId, monthly_cents: PRO_CENTS });
    const app = starterSnapshotOf(rows, planPrices);
    const live = await loadStripe(stripe, app.teams.flatMap((t) => (t.stripe_subscription_id ? [t.stripe_subscription_id] : [])));
    assert.equal(live.filter((s) => s.status === "canceled").length, 5, "the cancelled five fetched one by one");
    assert.deepEqual(countsOf(driftSaasStarterFrom(app, live.filter((s) => s.id !== theirs.id))), { pro_without_subscription: 12, payers_without_account: 3, stale_subscription_rows: 5, monthly_leak_cents: 34_800 });
    assert.equal(countsOf(driftSaasStarterFrom(app, live)).payers_without_account, 4, "someone else's subscription shows up as B");
    assert.deepEqual(starterAnswerKey(seeded).totals, { app_users: 252, app_pro_entitlements: 48, stripe_active_subscriptions: 39 });

    // A second seed (of either kind) starts by removing all of it, and nothing else.
    const r = await sweepPreviousSeed(stripe);
    assert.equal(r.customers, 54);
    assert.deepEqual([...fake.customers.keys()], [foreign.id]);
    assert.equal(theirs.status, "active");
    assert.ok(![...fake.prices.values()].some((p) => p.metadata?.leakfinder_seed === "1" && p.active), "seed prices archived");
  });
});

// ---------------------------------------------------------------- Postgres side, without a server

function fakeDb(answer: (sql: string) => unknown[] | Error = () => []) {
  const queries: { sql: string; params?: unknown[] }[] = [];
  const db = {
    query: async (text: string, params?: unknown[]) => {
      queries.push({ sql: text, params });
      const a = answer(text);
      if (a instanceof Error) throw a;
      return { rows: a };
    },
  } as unknown as pg.ClientBase;
  return { db, queries };
}

test("writeStarterRows: one transaction, the schema file first, values as parameters, sequences moved past the seeded ids", async () => {
  const { db, queries } = fakeDb();
  const { rows } = world();
  await writeStarterRows(db, rows, "-- schema");
  const head = (q: { sql: string }) => q.sql.split(" (")[0];
  assert.deepEqual(queries.map(head), [
    "begin",
    "-- schema",
    "insert into users",
    "insert into teams",
    "insert into team_members",
    "insert into invitations",
    "insert into activity_logs",
    "insert into activity_logs",
    "select setval(pg_get_serial_sequence('users', 'id'), coalesce((select max(id) from users), 0) + 1, false)",
    "select setval(pg_get_serial_sequence('teams', 'id'), coalesce((select max(id) from teams), 0) + 1, false)",
    "commit",
  ]);
  assert.ok(!queries.some((q) => q.sql.includes("@leakfinder.test")), "no value is spliced into the SQL");

  const failing = fakeDb((text) => (text.startsWith("insert into teams") ? new Error("boom") : []));
  await assert.rejects(writeStarterRows(failing.db, rows, "-- schema"), /boom/);
  assert.equal(failing.queries.at(-1)!.sql, "rollback");
});

test("the main demo's tables are dropped only when its entitlements table is there", async () => {
  const theirs = fakeDb((text) => (text.includes("to_regclass") ? [{ present: false }] : []));
  assert.equal(await dropMainDemoTables(theirs.db), false);
  assert.equal(theirs.queries.length, 1, "nothing dropped");
  const ours = fakeDb((text) => (text.includes("to_regclass") ? [{ present: true }] : []));
  assert.equal(await dropMainDemoTables(ours.db), true);
  assert.equal(ours.queries[1].sql, "drop table if exists entitlements, subscriptions, prices, products, customers cascade");
});

test("the live recount reads the starter's tables and Stripe, and agrees with the in-memory rules", async () => {
  await withFakeStripe(async (_fake, stripe) => {
    const { seeded } = await seedStarterStripe(stripe);
    const rows = starterRowsFor(seeded, NOW);
    const answer = (text: string): unknown[] => {
      if (text.startsWith("select id::text as id, email")) return rows.users.map((u) => ({ id: String(u.id), email: u.email, deleted: false }));
      if (text.startsWith("select id::text as id, stripe_customer_id"))
        return rows.teams.map((t) => ({ id: String(t.id), stripe_customer_id: t.stripe_customer_id, stripe_subscription_id: t.stripe_subscription_id, stripe_product_id: t.stripe_product_id, plan_name: t.plan_name, subscription_status: t.subscription_status }));
      if (text.startsWith("select user_id::text")) return rows.team_members.map((m) => ({ user_id: String(m.user_id), team_id: String(m.team_id), role: m.role }));
      throw new Error(`unexpected query: ${text}`);
    };
    const { db, queries } = fakeDb(answer);
    const { findings, app } = await auditSaasStarterLive({ db, stripe });
    assert.equal(queries.length, 3, "three reads, one at a time");
    assert.ok(queries.every((q) => /^select /.test(q.sql)), "the recount never writes");
    assert.equal(app.teams.length, seeded.teams.length);
    assert.deepEqual(countsOf(findings), { pro_without_subscription: 12, payers_without_account: 3, stale_subscription_rows: 5, monthly_leak_cents: 34_800 });
    assert.deepEqual(findings, driftSaasStarterFrom(starterSnapshotOf(rows, await loadPlanPrices(stripe)), await loadStripe(stripe, rows.teams.flatMap((t) => (t.stripe_subscription_id ? [t.stripe_subscription_id] : [])))));
  });
});
