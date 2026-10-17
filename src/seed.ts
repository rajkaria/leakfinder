/**
 * Seeds a SaaS that has drifted. The schema is the public starter's; only the
 * drift is planted, and every planted case is listed in seed/expected.json so
 * the audit can be checked against it.
 *
 *   252 app users · 40 Stripe subscriptions
 *   A. 12 users hold a `pro` entitlement with no paying subscription
 *        7 never paid (entitlement granted by a webhook that was never verified)
 *        5 cancelled in Stripe, the cancellation webhook never arrived
 *   B.  3 Stripe customers pay for subscriptions that map to no app user
 *   C.  5 app subscription rows still say `active` while Stripe says `canceled`
 *        (the same 5 as A's second group)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";
import Stripe from "stripe";
import { env } from "./env.js";

const stripe = new Stripe(env.stripeKey());
const APP_USERS = 252;
const PAYING = 32; // mapped, active, consistent
const CANCELLED_UNSYNCED = 5; // A2 + C
const NEVER_PAID_PRO = 7; // A1
const ORPHAN_PAYERS = 3; // B
const PRO_CENTS = 2900;

const first = ["Priya", "Arjun", "Mei", "Tomás", "Fatima", "Lukas", "Aisha", "Noah", "Sofia", "Kenji", "Zara", "Diego", "Hana", "Omar", "Ivy", "Ravi"];
const last = ["Kapoor", "Nair", "Chen", "Silva", "Haddad", "Weber", "Okafor", "Brown", "Rossi", "Sato", "Ali", "Lopez", "Kim", "Farouk", "Clark", "Iyer"];
const nameFor = (i: number) => `${first[i % first.length]} ${last[Math.floor(i / first.length) % last.length]}`;
const emailFor = (i: number) => `${first[i % first.length].toLowerCase().normalize("NFD").replace(/[^a-z]/g, "")}.${last[Math.floor(i / first.length) % last.length].toLowerCase()}${i}@leakfinder.test`;

async function main() {
  const db = new pg.Client({ connectionString: env.databaseUrl() });
  await db.connect();
  console.log("db: applying schema");
  await db.query(readFileSync(new URL("../seed/schema.sql", import.meta.url), "utf8"));

  console.log("stripe: product + price");
  const product = await stripe.products.create({ name: "LeakFinder Demo Pro" });
  const price = await stripe.prices.create({ product: product.id, unit_amount: PRO_CENTS, currency: "usd", recurring: { interval: "month" } });
  await db.query("insert into products(id,name) values($1,$2)", [product.id, product.name]);
  await db.query('insert into prices(id,product_id,unit_amount,currency,"interval") values($1,$2,$3,$4,$5)', [price.id, product.id, PRO_CENTS, "usd", "month"]);

  const users = Array.from({ length: APP_USERS }, (_, i) => ({ id: randomUUID(), email: emailFor(i), name: nameFor(i) }));
  for (const u of users) await db.query("insert into users(id,email,full_name) values($1,$2,$3)", [u.id, u.email, u.name]);
  console.log(`db: ${APP_USERS} users`);

  const expected: any = { pro_without_subscription: [], payers_without_account: [], stale_subscription_rows: [], monthly_leak_cents: 0 };

  async function subscribe(email: string, name: string) {
    const customer = await stripe.customers.create({
      email,
      name,
      payment_method: "pm_card_visa",
      invoice_settings: { default_payment_method: "pm_card_visa" },
    });
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: price.id }] });
    return { customer, sub };
  }

  let cursor = 0;
  // Consistent paying users
  for (let k = 0; k < PAYING; k++, cursor++) {
    const u = users[cursor];
    const { customer, sub } = await subscribe(u.email, u.name);
    await db.query("insert into customers(id,stripe_customer_id) values($1,$2)", [u.id, customer.id]);
    await db.query("insert into subscriptions(id,user_id,status,price_id,current_period_end) values($1,$2,$3,$4,to_timestamp($5))", [sub.id, u.id, sub.status, price.id, (sub as any).current_period_end ?? Math.floor(Date.now() / 1000) + 30 * 86400]);
    await db.query("insert into entitlements(user_id,plan,source) values($1,'pro','stripe_webhook')", [u.id]);
    process.stdout.write(`\rstripe: ${k + 1}/${PAYING} consistent subscriptions`);
  }
  console.log();

  // A2 + C: cancelled in Stripe, app never heard
  for (let k = 0; k < CANCELLED_UNSYNCED; k++, cursor++) {
    const u = users[cursor];
    const { customer, sub } = await subscribe(u.email, u.name);
    await stripe.subscriptions.cancel(sub.id);
    await db.query("insert into customers(id,stripe_customer_id) values($1,$2)", [u.id, customer.id]);
    await db.query("insert into subscriptions(id,user_id,status,price_id,current_period_end) values($1,$2,'active',$3,now() + interval '20 days')", [sub.id, u.id, price.id]);
    await db.query("insert into entitlements(user_id,plan,source) values($1,'pro','stripe_webhook')", [u.id]);
    expected.pro_without_subscription.push({ user_id: u.id, cause: "cancelled_unsynced" });
    expected.stale_subscription_rows.push({ user_id: u.id, subscription_id: sub.id, app_status: "active", stripe_status: "canceled" });
  }
  console.log(`stripe: ${CANCELLED_UNSYNCED} cancelled, app not told`);

  // A1: pro entitlement, never paid
  for (let k = 0; k < NEVER_PAID_PRO; k++, cursor++) {
    const u = users[cursor];
    await db.query("insert into entitlements(user_id,plan,source) values($1,'pro','stripe_webhook')", [u.id]);
    expected.pro_without_subscription.push({ user_id: u.id, cause: "never_paid" });
  }
  console.log(`db: ${NEVER_PAID_PRO} pro entitlements with no payment`);

  // B: paying customers with no account
  for (let k = 0; k < ORPHAN_PAYERS; k++) {
    const i = 900 + k;
    const { customer, sub } = await subscribe(emailFor(i), nameFor(i));
    expected.payers_without_account.push({ stripe_customer_id: customer.id, subscription_id: sub.id });
  }
  console.log(`stripe: ${ORPHAN_PAYERS} payers with no app account`);

  // Everyone else is free
  for (; cursor < APP_USERS; cursor++) await db.query("insert into entitlements(user_id,plan,source) values($1,'free','signup')", [users[cursor].id]);

  expected.monthly_leak_cents = (CANCELLED_UNSYNCED + NEVER_PAID_PRO) * PRO_CENTS;
  expected.grep_target_email = users[PAYING].email; // a cancelled-unsynced user: appears in findings, must never appear in the transcript
  writeFileSync(new URL("../seed/expected.json", import.meta.url), JSON.stringify(expected, null, 2));
  console.log(`expected leak: $${expected.monthly_leak_cents / 100}/month · grep target written to seed/expected.json`);
  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
