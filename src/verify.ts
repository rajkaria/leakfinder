/**
 * `pnpm verify`: the drift, recomputed straight from Postgres and Stripe in
 * plain TypeScript. No model, no sandbox, no agent code. If this and the
 * agent's report disagree, one of them is wrong; after a real apply it should
 * print zeros for A, B and C.
 *
 * The rules (shared with the seed's self-check, unit-tested in test/seed.test.ts):
 *   paying = a Stripe subscription whose status is `active` or `trialing`
 *   A  a user holds a `pro` entitlement and no paying subscription maps to them
 *      (a subscription maps to a user through the app's customers row or its
 *      subscriptions row)
 *   B  a paying subscription that maps to no app user
 *   C  an app subscriptions row whose status differs from Stripe's; a row Stripe
 *      has no record of counts too, as `missing`
 *   leak = what the A users' plan costs per month
 *
 * It reads the demo schema in seed/schema.sql; the agent, unlike this file,
 * has to discover the schema itself.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import Stripe from "stripe";
import { env } from "./env.js";
import type { Findings } from "./types.js";

// ---------------------------------------------------------------- pure rules

export interface AppSnapshot {
  users: { id: string; email: string }[];
  customers: { user_id: string; stripe_customer_id: string }[];
  subscriptions: { id: string; user_id: string; status: string; price_id: string | null }[];
  entitlements: { user_id: string; plan: string }[];
  prices: { id: string; unit_amount: number; interval: string }[];
}

/** One Stripe subscription, reduced to what the rules read. */
export interface StripeSub {
  id: string;
  customer: string;
  status: string;
  monthly_cents: number;
}

export const PAYING_STATUSES = ["active", "trialing"] as const;
export const isPaying = (status: string) => (PAYING_STATUSES as readonly string[]).includes(status);
/** Paid access in the app. Anything else (free, revoked, a deleted row) is not. */
export const isPaidPlan = (plan: string) => plan.trim().toLowerCase() === "pro";

const perMonth = (cents: number, interval: string) => (interval === "year" ? cents / 12 : cents);

/**
 * The price an A user's access is worth per month: the price on their own
 * subscription row when they have one, else the app's usual price (the one
 * most subscription rows point at, else the dearest monthly price).
 */
function planPricer(app: AppSnapshot) {
  const prices = new Map(app.prices.map((p) => [p.id, perMonth(p.unit_amount, p.interval)]));
  const uses = new Map<string, number>();
  for (const s of app.subscriptions) if (s.price_id && prices.has(s.price_id)) uses.set(s.price_id, (uses.get(s.price_id) ?? 0) + 1);
  const mostUsed = [...uses].sort((a, b) => b[1] - a[1])[0]?.[0];
  const fallback = mostUsed ? prices.get(mostUsed)! : Math.max(0, ...prices.values());
  const rowPrice = new Map<string, number>();
  for (const s of app.subscriptions) if (s.price_id && prices.has(s.price_id)) rowPrice.set(s.user_id, prices.get(s.price_id)!);
  return (userId: string) => Math.round(rowPrice.get(userId) ?? fallback);
}

/** The drift between one app snapshot and one Stripe snapshot, in the same shape the agent reports. */
export function driftFrom(app: AppSnapshot, stripeSubs: StripeSub[]): Findings {
  const subs = new Map(stripeSubs.map((s) => [s.id, s]));
  const users = new Map(app.users.map((u) => [u.id, u]));
  const userByCustomer = new Map(app.customers.map((c) => [c.stripe_customer_id, c.user_id]));
  const userByRow = new Map(app.subscriptions.map((r) => [r.id, r.user_id]));
  const mappedUsers = (s: StripeSub) =>
    [userByRow.get(s.id), userByCustomer.get(s.customer)].filter((u): u is string => !!u && users.has(u));

  const paying = [...subs.values()].filter((s) => isPaying(s.status));
  const paidUp = new Set(paying.flatMap(mappedUsers));
  const price = planPricer(app);
  const rowsByUser = new Map<string, AppSnapshot["subscriptions"]>();
  for (const r of app.subscriptions) rowsByUser.set(r.user_id, [...(rowsByUser.get(r.user_id) ?? []), r]);

  const pro = app.entitlements.filter((e) => isPaidPlan(e.plan));
  const proUsers = [...new Map(pro.map((e) => [e.user_id, e])).values()];

  const pro_without_subscription = proUsers
    .filter((e) => !paidUp.has(e.user_id))
    .map((e) => {
      const statuses = (rowsByUser.get(e.user_id) ?? []).map((r) => subs.get(r.id)?.status ?? "missing");
      const cause = !statuses.length ? "never_paid" : statuses.includes("canceled") ? "cancelled_unsynced" : `stripe_${statuses[0]}`;
      return { user_id: e.user_id, email: users.get(e.user_id)?.email ?? "", plan: e.plan, monthly_cents: price(e.user_id), cause };
    })
    .sort((a, b) => a.user_id.localeCompare(b.user_id));

  const payers_without_account = paying
    .filter((s) => !mappedUsers(s).length)
    .map((s) => ({ stripe_customer_id: s.customer, subscription_id: s.id, monthly_cents: s.monthly_cents }))
    .sort((a, b) => a.subscription_id.localeCompare(b.subscription_id));

  const stale_subscription_rows = app.subscriptions
    .map((r) => ({ user_id: r.user_id, subscription_id: r.id, app_status: r.status, stripe_status: subs.get(r.id)?.status ?? "missing" }))
    .filter((r) => r.app_status !== r.stripe_status)
    .sort((a, b) => a.subscription_id.localeCompare(b.subscription_id));

  return {
    pro_without_subscription,
    payers_without_account,
    stale_subscription_rows,
    monthly_leak_cents: pro_without_subscription.reduce((n, r) => n + r.monthly_cents, 0),
    totals: { app_users: app.users.length, app_pro_entitlements: proUsers.length, stripe_active_subscriptions: paying.length },
  };
}

export interface DriftCounts {
  pro_without_subscription: number;
  payers_without_account: number;
  stale_subscription_rows: number;
  monthly_leak_cents: number;
}

export const countsOf = (f: Findings): DriftCounts => ({
  pro_without_subscription: f.pro_without_subscription.length,
  payers_without_account: f.payers_without_account.length,
  stale_subscription_rows: f.stale_subscription_rows.length,
  monthly_leak_cents: f.monthly_leak_cents,
});

// ---------------------------------------------------------------- helpers shared with the seed

/** Runs `fn` over `items` with at most `limit` calls in flight; Stripe test mode allows about 25 requests a second. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The SDK retries 409s, 5xx and dropped connections itself; a 429 it does not, so back off here. */
export async function retry429<T>(fn: () => Promise<T>, tries = 5, baseMs = 400): Promise<T> {
  for (let n = 0; ; n++) {
    try {
      return await fn();
    } catch (e) {
      const limited = e instanceof Stripe.errors.StripeRateLimitError || (e as { statusCode?: number })?.statusCode === 429;
      if (!limited || n >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, baseMs * 2 ** n + Math.random() * baseMs));
    }
  }
}

/** API version: whatever the SDK pins (stripe-node 23.0.0 pins 2026-09-30.endive); the types only describe that one. */
export function stripeClient(): Stripe {
  // Test-mode notices are for developers; on the demo terminal they are noise. Set it to false to see them.
  process.env.STRIPE_SUPPRESS_NOTICES ??= "true";
  return new Stripe(env.stripeKey(), { maxNetworkRetries: 3, timeout: 30_000 });
}

/**
 * pg already treats sslmode=require (what Neon URLs carry) as verify-full, and
 * prints a long security warning saying so on every run. Asking for
 * verify-full by name keeps the same check and a quiet demo terminal.
 */
export function pgClient(url = env.databaseUrl()): pg.Client {
  try {
    const u = new URL(url);
    const mode = u.searchParams.get("sslmode");
    if (mode && ["prefer", "require", "verify-ca"].includes(mode) && !u.searchParams.has("uselibpqcompat")) {
      u.searchParams.set("sslmode", "verify-full");
      return new pg.Client({ connectionString: u.toString() });
    }
  } catch {
    // Not a URL pg would parse differently; hand it over as is.
  }
  return new pg.Client({ connectionString: url });
}

export const customerId = (c: string | { id: string }) => (typeof c === "string" ? c : c.id);

/** What a subscription bills per month across its items (yearly prices count a twelfth). */
export function monthlyCents(sub: Stripe.Subscription): number {
  let cents = 0;
  for (const item of sub.items.data) {
    const r = item.price.recurring;
    if (!r) continue;
    const months = r.interval === "year" ? 12 * r.interval_count : r.interval === "month" ? r.interval_count : r.interval === "week" ? (r.interval_count * 12) / 52 : (r.interval_count * 12) / 365;
    cents += ((item.price.unit_amount ?? 0) * (item.quantity ?? 1)) / months;
  }
  return Math.round(cents);
}

const view = (s: Stripe.Subscription): StripeSub => ({ id: s.id, customer: customerId(s.customer), status: s.status, monthly_cents: monthlyCents(s) });

// ---------------------------------------------------------------- live reads

export async function loadApp(db: pg.ClientBase): Promise<AppSnapshot> {
  // One query at a time: pg 8.2x prints a DeprecationWarning on the demo terminal (and pg 9 throws) when a client gets a query while one is running.
  const users = await db.query("select id::text, email from users");
  const customers = await db.query("select id::text as user_id, stripe_customer_id from customers");
  const subscriptions = await db.query("select id, user_id::text, status, price_id from subscriptions");
  const entitlements = await db.query("select user_id::text, plan from entitlements");
  const prices = await db.query('select id, unit_amount, "interval" from prices');
  return {
    users: users.rows,
    customers: customers.rows,
    subscriptions: subscriptions.rows,
    entitlements: entitlements.rows,
    prices: prices.rows.map((p) => ({ ...p, unit_amount: Number(p.unit_amount) })),
  };
}

/**
 * Every subscription Stripe has not cancelled (Stripe's default list), plus the
 * ones the app's rows point at that the list left out, fetched one by one so a
 * cancelled subscription is compared on its real status. A row Stripe does not
 * know stays absent and the rules call it `missing`.
 */
export async function loadStripe(stripe: Stripe, appSubscriptionIds: string[]): Promise<StripeSub[]> {
  const seen = new Map<string, StripeSub>();
  for await (const s of stripe.subscriptions.list({ limit: 100 })) seen.set(s.id, view(s));
  const absent = [...new Set(appSubscriptionIds)].filter((id) => !seen.has(id));
  await pool(absent, 8, async (id) => {
    try {
      const s = await retry429(() => stripe.subscriptions.retrieve(id));
      seen.set(s.id, view(s));
    } catch (e) {
      if ((e as { statusCode?: number })?.statusCode !== 404) throw e;
    }
  });
  return [...seen.values()];
}

/** The full drift, live. */
export async function auditLive(): Promise<Findings> {
  const db = pgClient();
  await db.connect();
  try {
    const app = await loadApp(db);
    const subs = await loadStripe(stripeClient(), app.subscriptions.map((r) => r.id));
    return driftFrom(app, subs);
  } finally {
    await db.end();
  }
}

/** The three counts and the monthly leak, live from Postgres and Stripe. */
export async function computeDrift(): Promise<DriftCounts> {
  return countsOf(await auditLive());
}

// ---------------------------------------------------------------- pnpm verify

const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export function printDrift(f: Findings, log: (line: string) => void = console.log) {
  const c = countsOf(f);
  const a = f.pro_without_subscription;
  const never = a.filter((r) => r.cause === "never_paid").length;
  log(`read  ${f.totals.app_users} app users · ${f.totals.app_pro_entitlements} pro entitlements · ${f.totals.stripe_active_subscriptions} active or trialing Stripe subscriptions`);
  log(`A  pro access nobody pays for    ${String(c.pro_without_subscription).padStart(3)}   (${never} never paid · ${a.length - never} cancelled in Stripe)`);
  log(`B  paying with no app account    ${String(c.payers_without_account).padStart(3)}   (${dollars(f.payers_without_account.reduce((n, r) => n + r.monthly_cents, 0))}/month billed)`);
  log(`C  app rows out of sync          ${String(c.stale_subscription_rows).padStart(3)}`);
  log(`leak  ${dollars(c.monthly_leak_cents)} / month`);
}

async function main() {
  const t0 = Date.now();
  const f = await auditLive();
  printDrift(f);
  try {
    if (existsSync("seed/expected.json")) {
      const key = JSON.parse(readFileSync("seed/expected.json", "utf8"));
      const want: DriftCounts = {
        pro_without_subscription: key.pro_without_subscription?.length ?? 0,
        payers_without_account: key.payers_without_account?.length ?? 0,
        stale_subscription_rows: key.stale_subscription_rows?.length ?? 0,
        monthly_leak_cents: Number(key.monthly_leak_cents) || 0,
      };
      const got = countsOf(f);
      const off = (Object.keys(want) as (keyof DriftCounts)[]).filter((k) => want[k] !== got[k]);
      console.log(
        off.length
          ? `seed answer key: planted ${want.pro_without_subscription} · ${want.payers_without_account} · ${want.stale_subscription_rows} · ${dollars(want.monthly_leak_cents)}; live differs on ${off.join(", ")} (expected after an apply, or if the account has other subscriptions)`
          : "seed answer key: matches (seed/expected.json)",
      );
    }
  } catch {
    // The answer key is optional; a broken one is not a verify failure.
  }
  console.log(`verified in ${((Date.now() - t0) / 1000).toFixed(1)}s, straight from Postgres and Stripe, no agent involved`);
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
    console.error(`verify failed: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
