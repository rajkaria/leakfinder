/**
 * Seeds a SaaS that has drifted. The schema is the public starter's; only the
 * drift is planted, and every planted case is listed in seed/expected.json so
 * the audit can be checked against it.
 *
 *   252 app users · 48 hold Pro ($29/month), 36 of them pay · 44 Stripe subscriptions, 39 active or trialing
 *   A. 12 users hold a `pro` entitlement with no paying subscription      $348/month
 *        7 never paid (entitlement granted by a webhook that was never verified)
 *        5 cancelled in Stripe, the cancellation webhook never arrived
 *   B.  3 Stripe customers pay for subscriptions that map to no app user
 *   C.  5 app subscription rows still say `active` while Stripe says `canceled`
 *        (the same 5 as A's second group)
 *
 * Noise the audit must not flag, because real accounts have it:
 *   2 Pro users on a trial (`trialing` in Stripe and in the app)
 *   2 Pro users who cancelled at period end (still `active`, the app row says so)
 *   3 free users who have a Stripe customer but never subscribed
 *
 * Every Stripe object it creates carries metadata leakfinder_seed=1, and a
 * re-run first removes exactly those, so rehearsals do not pile up. It never
 * touches a Stripe object without that tag, and refuses to reset a database
 * whose users table holds people it did not create.
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import Stripe from "stripe";
import { env } from "./env.js";
import { auditLive, countsOf, customerId, isPaying, monthlyCents, pgClient, pool, retry429, stripeClient } from "./verify.js";
import type { AppSnapshot, DriftCounts, StripeSub } from "./verify.js";

export const APP_USERS = 252;
export const PRO_CENTS = 2900;
export const SEED_KEY = "leakfinder_seed";
const TAG = { [SEED_KEY]: "1" };
const IN_FLIGHT = 8;

export const isSeedObject = (metadata: Stripe.Metadata | null | undefined) => metadata?.[SEED_KEY] === "1";

// ---------------------------------------------------------------- the plan (pure)

export type Cohort =
  | "paying"
  | "trialing"
  | "cancelling"
  | "cancelled_unsynced"
  | "never_paid"
  | "free_customer"
  | "free"
  | "orphan_payer";

export interface CohortSpec {
  count: number;
  /** Has a row in users. Orphan payers exist only in Stripe. */
  appUser: boolean;
  plan: "pro" | "free" | null;
  /** Has a Stripe customer (and, for app users, a customers row pointing at it). */
  customer: boolean;
  /** The Stripe subscription to create, and the status Stripe reports once the seed is done. */
  sub: null | { status: "active" | "trialing" | "canceled"; trialDays?: number; cancelAtPeriodEnd?: boolean; cancelAfter?: boolean };
  /** The app's subscriptions row mirrors Stripe, or is stuck at the `active` it last heard. */
  appRow: null | "mirror" | "stuck_active";
}

const planted: Record<Exclude<Cohort, "free">, CohortSpec> = {
  paying: { count: 32, appUser: true, plan: "pro", customer: true, sub: { status: "active" }, appRow: "mirror" },
  trialing: { count: 2, appUser: true, plan: "pro", customer: true, sub: { status: "trialing", trialDays: 14 }, appRow: "mirror" },
  cancelling: { count: 2, appUser: true, plan: "pro", customer: true, sub: { status: "active", cancelAtPeriodEnd: true }, appRow: "mirror" },
  cancelled_unsynced: { count: 5, appUser: true, plan: "pro", customer: true, sub: { status: "canceled", cancelAfter: true }, appRow: "stuck_active" },
  // Started checkout, never paid; a webhook that was never verified granted Pro anyway. Their Stripe customer exists, so a fix can invoice them.
  never_paid: { count: 7, appUser: true, plan: "pro", customer: true, sub: null, appRow: null },
  free_customer: { count: 3, appUser: true, plan: "free", customer: true, sub: null, appRow: null },
  orphan_payer: { count: 3, appUser: false, plan: null, customer: true, sub: { status: "active" }, appRow: null },
};

/** Every cohort; whoever is left of the 252 app users is plain free. */
export const COHORTS: Record<Cohort, CohortSpec> = {
  ...planted,
  free: {
    count: APP_USERS - Object.values(planted).reduce((n, c) => n + (c.appUser ? c.count : 0), 0),
    appUser: true,
    plan: "free",
    customer: false,
    sub: null,
    appRow: null,
  },
};

const first = ["Priya", "Arjun", "Mei", "Tomás", "Fatima", "Lukas", "Aisha", "Noah", "Sofia", "Kenji", "Zara", "Diego", "Hana", "Omar", "Ivy", "Ravi"];
const last = ["Kapoor", "Nair", "Chen", "Silva", "Haddad", "Weber", "Okafor", "Brown", "Rossi", "Sato", "Ali", "Lopez", "Kim", "Farouk", "Clark", "Iyer"];
const nameFor = (i: number) => `${first[i % first.length]} ${last[Math.floor(i / first.length) % last.length]}`;
const emailFor = (i: number) =>
  `${first[i % first.length].toLowerCase().normalize("NFD").replace(/[^a-z]/g, "")}.${last[Math.floor(i / first.length) % last.length].toLowerCase()}${i}@leakfinder.test`;

/** Small seeded PRNG so the cohort layout is the same on every run. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Person {
  n: number;
  cohort: Cohort;
  email: string;
  name: string;
  signedUpDaysAgo: number;
}

/** Who exists: the app's users with their cohorts spread through the table (not in blocks), then the orphan payers. */
export function plan(): Person[] {
  const rand = mulberry32(17);
  const cohorts = (Object.keys(COHORTS) as Cohort[]).filter((c) => COHORTS[c].appUser).flatMap((c) => Array<Cohort>(COHORTS[c].count).fill(c));
  for (let i = cohorts.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [cohorts[i], cohorts[j]] = [cohorts[j], cohorts[i]];
  }
  const person = (n: number, cohort: Cohort): Person => ({ n, cohort, email: emailFor(n), name: nameFor(n), signedUpDaysAgo: 1 + Math.floor(rand() * 540) });
  return [...cohorts.map((c, n) => person(n, c)), ...Array.from({ length: COHORTS.orphan_payer.count }, (_, k) => person(900 + k, "orphan_payer"))];
}

/** A person after the Stripe side exists. */
export interface Seeded extends Person {
  userId: string | null;
  customerId: string | null;
  sub: { id: string; status: string; cancelAtPeriodEnd: boolean; periodEnd: number; monthlyCents: number } | null;
}

export interface AppRows {
  users: { id: string; email: string; full_name: string; created_at: Date }[];
  customers: { id: string; stripe_customer_id: string }[];
  subscriptions: { id: string; user_id: string; status: string; price_id: string; current_period_end: Date; cancel_at_period_end: boolean }[];
  entitlements: { user_id: string; plan: string; source: string }[];
}

/** The app's rows for what was created in Stripe. The drift lives here: stuck rows and unearned entitlements. */
export function appRowsFor(seeded: Seeded[], priceId: string, now = Date.now()): AppRows {
  const rows: AppRows = { users: [], customers: [], subscriptions: [], entitlements: [] };
  for (const s of seeded) {
    const spec = COHORTS[s.cohort];
    if (!spec.appUser || !s.userId) continue;
    rows.users.push({ id: s.userId, email: s.email, full_name: s.name, created_at: new Date(now - s.signedUpDaysAgo * 86_400_000) });
    if (s.customerId) rows.customers.push({ id: s.userId, stripe_customer_id: s.customerId });
    if (s.sub && spec.appRow) {
      const stuck = spec.appRow === "stuck_active";
      rows.subscriptions.push({
        id: s.sub.id,
        user_id: s.userId,
        status: stuck ? "active" : s.sub.status,
        price_id: priceId,
        current_period_end: new Date(s.sub.periodEnd * 1000),
        cancel_at_period_end: stuck ? false : s.sub.cancelAtPeriodEnd,
      });
    }
    if (spec.plan) rows.entitlements.push({ user_id: s.userId, plan: spec.plan, source: spec.plan === "pro" ? "stripe_webhook" : "signup" });
  }
  return rows;
}

/** The same rows in the shape the drift rules read. */
export function snapshotOf(rows: AppRows, price: { id: string; unit_amount: number; interval: string }): AppSnapshot {
  return {
    users: rows.users.map((u) => ({ id: u.id, email: u.email })),
    customers: rows.customers.map((c) => ({ user_id: c.id, stripe_customer_id: c.stripe_customer_id })),
    subscriptions: rows.subscriptions.map((r) => ({ id: r.id, user_id: r.user_id, status: r.status, price_id: r.price_id })),
    entitlements: rows.entitlements.map((e) => ({ user_id: e.user_id, plan: e.plan })),
    prices: [price],
  };
}

export const stripeSubsOf = (seeded: Seeded[]): StripeSub[] =>
  seeded.flatMap((s) => (s.sub && s.customerId ? [{ id: s.sub.id, customer: s.customerId, status: s.sub.status, monthly_cents: s.sub.monthlyCents }] : []));

/** seed/expected.json: what was planted, by id, from the plan alone (not from the drift rules, so the two check each other). */
export function answerKey(seeded: Seeded[], proCents = PRO_CENTS) {
  const of = (c: Cohort) => seeded.filter((s) => s.cohort === c);
  const neverPaid = of("never_paid");
  const unsynced = of("cancelled_unsynced");
  const orphans = of("orphan_payer");
  const appUsers = seeded.filter((s) => COHORTS[s.cohort].appUser);
  return {
    pro_without_subscription: [
      ...unsynced.map((s) => ({ user_id: s.userId!, cause: "cancelled_unsynced" })),
      ...neverPaid.map((s) => ({ user_id: s.userId!, cause: "never_paid" })),
    ],
    payers_without_account: orphans.map((s) => ({ stripe_customer_id: s.customerId!, subscription_id: s.sub!.id })),
    stale_subscription_rows: unsynced.map((s) => ({ user_id: s.userId!, subscription_id: s.sub!.id, app_status: "active", stripe_status: s.sub!.status })),
    monthly_leak_cents: (neverPaid.length + unsynced.length) * proCents,
    // A cancelled-unsynced user: appears in findings.json inside the VM, must never appear in the transcript.
    grep_target_email: unsynced[0]?.email ?? "",
    planted_summary: {
      pro_without_subscription: neverPaid.length + unsynced.length,
      never_paid: neverPaid.length,
      cancelled_unsynced: unsynced.length,
      payers_without_account: orphans.length,
      stale_subscription_rows: unsynced.length,
      monthly_leak_cents: (neverPaid.length + unsynced.length) * proCents,
      pro_cents: proCents,
      noise_not_drift: { trialing_pro: of("trialing").length, cancel_at_period_end: of("cancelling").length, free_with_stripe_customer: of("free_customer").length },
    },
    totals: {
      app_users: appUsers.length,
      app_pro_entitlements: appUsers.filter((s) => COHORTS[s.cohort].plan === "pro").length,
      stripe_active_subscriptions: seeded.filter((s) => s.sub && isPaying(s.sub.status)).length,
    },
  };
}

// ---------------------------------------------------------------- Stripe

/** Seed customers: search when the account has it (not in India, and up to a minute behind), else the full list. */
export async function findSeedCustomers(stripe: Stripe): Promise<{ ids: string[]; via: string }> {
  try {
    const found = await stripe.customers.search({ query: `metadata['${SEED_KEY}']:'1'`, limit: 100 }).autoPagingToArray({ limit: 10_000 });
    return { ids: found.filter((c) => isSeedObject(c.metadata)).map((c) => c.id), via: "search" };
  } catch {
    const ids: string[] = [];
    for await (const c of stripe.customers.list({ limit: 100 })) if (isSeedObject(c.metadata)) ids.push(c.id);
    return { ids, via: "list" };
  }
}

const notFound = (e: unknown) => (e as { statusCode?: number })?.statusCode === 404;

/**
 * Removes the previous seed: deletes tagged customers (Stripe cancels their
 * subscriptions with them), cancels any tagged subscription whose customer is
 * not being deleted, and archives tagged prices and products (Stripe does not
 * delete a price). Returns how many paying subscriptions in the account are
 * not the seed's, because the audit will count those.
 */
export async function sweepPreviousSeed(stripe: Stripe) {
  const [subs, customers, prices, products] = await Promise.all([
    // Stripe's default list: every subscription not yet cancelled. The customer is expanded to read its tag.
    (async () => {
      const all: Stripe.Subscription[] = [];
      for await (const s of stripe.subscriptions.list({ limit: 100, expand: ["data.customer"] })) all.push(s);
      return all;
    })(),
    findSeedCustomers(stripe),
    (async () => {
      const ids: string[] = [];
      for await (const p of stripe.prices.list({ active: true, limit: 100 })) if (isSeedObject(p.metadata)) ids.push(p.id);
      return ids;
    })(),
    (async () => {
      const ids: string[] = [];
      for await (const p of stripe.products.list({ active: true, limit: 100 })) if (isSeedObject(p.metadata)) ids.push(p.id);
      return ids;
    })(),
  ]);

  const doomed = new Set(customers.ids);
  for (const s of subs) {
    const c = s.customer;
    if (typeof c !== "string" && !("deleted" in c && c.deleted) && isSeedObject((c as Stripe.Customer).metadata)) doomed.add(c.id);
  }
  const seedSubs = subs.filter((s) => isSeedObject(s.metadata));
  const toCancel = seedSubs.filter((s) => !doomed.has(customerId(s.customer))).map((s) => s.id);
  const foreign = subs.filter((s) => !isSeedObject(s.metadata));
  const foreignPaying = foreign.filter((s) => isPaying(s.status)).length;

  let failed = 0;
  const jobs: (() => Promise<unknown>)[] = [
    ...[...doomed].map((id) => () => stripe.customers.del(id)),
    ...toCancel.map((id) => () => stripe.subscriptions.cancel(id)),
    ...prices.map((id) => () => stripe.prices.update(id, { active: false })),
  ];
  await pool(jobs, IN_FLIGHT, async (job) => {
    try {
      await retry429(job);
    } catch (e) {
      if (!notFound(e)) failed++;
    }
  });
  // Products after their prices, so nothing is left active under an archived product.
  await pool(products, IN_FLIGHT, async (id) => {
    try {
      await retry429(() => stripe.products.update(id, { active: false }));
    } catch (e) {
      if (!notFound(e)) failed++;
    }
  });
  return { customers: doomed.size, via: customers.via, cancelled: toCancel.length, prices: prices.length, products: products.length, failed, foreign: foreign.length, foreignPaying };
}

/** Creates one person's Stripe side, in order: customer, subscription, cancellation. */
export async function materialize(stripe: Stripe, p: Person, priceId: string): Promise<Seeded> {
  const spec = COHORTS[p.cohort];
  const userId = spec.appUser ? randomUUID() : null;
  if (!spec.customer) return { ...p, userId, customerId: null, sub: null };
  const card = spec.sub ? { payment_method: "pm_card_visa", invoice_settings: { default_payment_method: "pm_card_visa" } } : {};
  // A billing address on every customer: Stripe accounts in India reject USD (export) payments and invoices without one.
  const address = { line1: "100 Demo Street", city: "San Francisco", state: "CA", postal_code: "94105", country: "US" };
  const customer = await retry429(() => stripe.customers.create({ email: p.email, name: p.name, address, metadata: TAG, ...card }));
  if (!spec.sub) return { ...p, userId, customerId: customer.id, sub: null };

  const want = spec.sub;
  let sub = await retry429(() =>
    stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      metadata: TAG,
      // Fail loudly if the test card cannot pay, rather than seed an `incomplete` subscription that skews every count.
      payment_behavior: "error_if_incomplete",
      ...(want.trialDays ? { trial_period_days: want.trialDays } : {}),
      ...(want.cancelAtPeriodEnd ? { cancel_at_period_end: true } : {}),
    }),
  );
  // Since 2025-03-31.basil the billing period lives on each item, not on the subscription.
  const periodEnd = sub.items.data[0]?.current_period_end ?? Math.floor(Date.now() / 1000) + 30 * 86_400;
  const cents = monthlyCents(sub);
  if (want.cancelAfter) {
    const created = sub;
    sub = await retry429(() => stripe.subscriptions.cancel(created.id));
  }
  return { ...p, userId, customerId: customer.id, sub: { id: sub.id, status: sub.status, cancelAtPeriodEnd: sub.cancel_at_period_end, periodEnd, monthlyCents: cents } };
}

// ---------------------------------------------------------------- Postgres

/** One multi-row insert per 500 rows. Table and column names are constants from this file. */
export async function insertRows<T extends Record<string, unknown>>(db: pg.ClientBase, table: string, rows: T[]) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  for (let at = 0; at < rows.length; at += 500) {
    const chunk = rows.slice(at, at + 500);
    const params: unknown[] = [];
    const values = chunk.map((r) => `(${cols.map((c) => (params.push(r[c]), `$${params.length}`)).join(",")})`);
    await db.query(`insert into ${table} (${cols.map((c) => `"${c}"`).join(",")}) values ${values.join(",")}`, params);
  }
}

/** The schema drops and recreates six tables. Only do that to a database this seed filled. */
export async function assertDemoDatabase(db: pg.ClientBase) {
  if (process.env.LEAKFINDER_SEED_FORCE === "1") return;
  const { rows } = await db.query("select to_regclass('public.users') is not null as present");
  if (!rows[0].present) return;
  let foreign: number;
  try {
    foreign = (await db.query("select count(*)::int as n from users where email not like '%@leakfinder.test'")).rows[0].n;
  } catch {
    throw new Error("refusing to reset: this database has a users table the seed did not create. Point DATABASE_URL at the demo database, or set LEAKFINDER_SEED_FORCE=1.");
  }
  if (foreign > 0) throw new Error(`refusing to reset: users holds ${foreign} rows the seed did not create. Point DATABASE_URL at the demo database, or set LEAKFINDER_SEED_FORCE=1.`);
}

// ---------------------------------------------------------------- main

const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US")}`;
const fmt = (c: DriftCounts) => `A ${c.pro_without_subscription} · B ${c.payers_without_account} · C ${c.stale_subscription_rows} · ${dollars(c.monthly_leak_cents)}/month`;

async function main() {
  const t0 = Date.now();
  if (!/^(sk|rk)_test_/.test(env.stripeKey())) throw new Error("the seed creates customers and charges: use a test-mode key (sk_test_ or rk_test_)");
  const stripe = stripeClient();
  const db = pgClient();
  await db.connect();
  try {
    await assertDemoDatabase(db);

    const swept = await sweepPreviousSeed(stripe);
    console.log(
      `stripe: previous seed cleared · ${swept.customers} customers deleted (found by ${swept.via}) · ${swept.cancelled} subscriptions cancelled · ${swept.products} products, ${swept.prices} prices archived`,
    );
    if (swept.failed) console.log(`warning: ${swept.failed} seed objects could not be removed; the next run retries them`);
    console.log(`stripe: ${swept.foreign} subscriptions in this account are not the seed's (${swept.foreignPaying} active or trialing); left alone`);
    if (swept.foreignPaying)
      console.log(`warning: the audit and pnpm verify will count those ${swept.foreignPaying} as payers with no account. Use a fresh test account for clean numbers.`);

    const product = await retry429(() => stripe.products.create({ name: "LeakFinder Demo Pro", metadata: TAG }));
    const price = await retry429(() =>
      stripe.prices.create({ product: product.id, unit_amount: PRO_CENTS, currency: "usd", recurring: { interval: "month" }, metadata: TAG }),
    );

    const people = plan();
    const inStripe = people.filter((p) => COHORTS[p.cohort].customer).length;
    let done = 0;
    const seeded = await pool(people, IN_FLIGHT, async (p) => {
      const s = await materialize(stripe, p, price.id);
      if (s.customerId) process.stdout.write(`\rstripe: ${++done}/${inStripe} customers with their subscriptions`);
      return s;
    });
    console.log();
    for (const s of seeded) {
      const want = COHORTS[s.cohort].sub?.status;
      if (s.sub && want && s.sub.status !== want) console.log(`warning: a ${s.cohort} subscription is ${s.sub.status}, expected ${want}`);
    }

    const rows = appRowsFor(seeded, price.id);
    await db.query("begin");
    try {
      await db.query(readFileSync(new URL("../seed/schema.sql", import.meta.url), "utf8"));
      await insertRows(db, "products", [{ id: product.id, name: product.name, active: true }]);
      await insertRows(db, "prices", [{ id: price.id, product_id: product.id, unit_amount: PRO_CENTS, currency: "usd", interval: "month" }]);
      await insertRows(db, "users", rows.users);
      await insertRows(db, "customers", rows.customers);
      await insertRows(db, "subscriptions", rows.subscriptions);
      await insertRows(db, "entitlements", rows.entitlements);
      await db.query("commit");
    } catch (e) {
      await db.query("rollback");
      throw e;
    }
    console.log(`db: ${rows.users.length} users · ${rows.entitlements.filter((e) => e.plan === "pro").length} pro entitlements · ${rows.subscriptions.length} subscription rows`);

    const key = answerKey(seeded);
    writeFileSync(new URL("../seed/expected.json", import.meta.url), JSON.stringify(key, null, 2) + "\n");
    const planted: DriftCounts = {
      pro_without_subscription: key.pro_without_subscription.length,
      payers_without_account: key.payers_without_account.length,
      stale_subscription_rows: key.stale_subscription_rows.length,
      monthly_leak_cents: key.monthly_leak_cents,
    };
    console.log(`planted: ${fmt(planted)} · answer key and grep target in seed/expected.json`);

    // The same rules pnpm verify uses, read back live from Postgres and Stripe.
    const live = countsOf(await auditLive());
    const same = (Object.keys(planted) as (keyof DriftCounts)[]).every((k) => planted[k] === live[k]);
    console.log(same ? `self-check: pnpm verify reads the same back (${fmt(live)})` : `warning: pnpm verify reads ${fmt(live)}, planted ${fmt(planted)}`);
    console.log(`seeded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } finally {
    await db.end();
  }
}

const isEntry = () => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isEntry()) {
  main().catch((e) => {
    console.error(`seed failed: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
