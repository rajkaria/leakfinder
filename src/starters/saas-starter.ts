/**
 * The demo on a real app's schema: Vercel's Next.js SaaS Starter
 * (github.com/nextjs/saas-starter, MIT), whose Drizzle migration is in
 * seed/saas-starter.sql byte for byte. Only the data and the drift are
 * LeakFinder's; the tables, columns and constraints are the starter's.
 *
 * How the starter grants paid access: a team is on a paid plan when
 * teams.plan_name is set and teams.subscription_status is `active` or
 * `trialing`. Its checkout route and its Stripe webhook write those two, plus
 * stripe_customer_id, stripe_subscription_id and stripe_product_id. A user
 * reaches a team through team_members. A cancellation, when the webhook hears
 * it, clears plan_name, stripe_subscription_id and stripe_product_id and sets
 * subscription_status to `canceled`.
 *
 *   252 users in 174 teams (50 with more than one member) · 48 teams on Pro ($29/month), 36 of them pay
 *   54 Stripe customers · 44 subscriptions, 39 active or trialing · one product (Pro) with one active price
 *   A. 12 teams on Pro with no paying subscription                    $348/month
 *        7 never paid: checkout started (a Stripe customer, mapped on the team), never
 *          paid; a webhook that was never verified wrote plan_name 'Pro' and `active`
 *        5 cancelled in Stripe; the cancellation webhook never arrived, the row still says `active`
 *   B.  3 Stripe customers pay for subscriptions that map to no team
 *   C.  5 team rows say `active` while Stripe says `canceled` (the same 5 as A's second group)
 *
 * Noise the audit must not flag: 2 Pro teams on a trial, 2 that cancel at
 * period end (still `active`), 3 free teams with a Stripe customer and no
 * subscription.
 *
 *   tsx src/starters/saas-starter.ts seed      reset the demo database to the starter's schema and plant the drift
 *   tsx src/starters/saas-starter.ts verify    recount the drift from Postgres and Stripe, no model involved
 *
 * The Stripe side reuses the main seed's tag and sweep: every object carries
 * metadata leakfinder_seed=1, and a re-run (of either seed) first removes
 * exactly those.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import type Stripe from "stripe";
import { env } from "../env.js";
import { SEED_KEY, assertDemoDatabase, insertRows, sweepPreviousSeed } from "../seed.js";
import type { Findings } from "../types.js";
import { countsOf, isPaying, loadStripe, monthlyCents, pgClient, pool, retry429, stripeClient } from "../verify.js";
import type { DriftCounts, StripeSub } from "../verify.js";

export const STARTER_REPO = "nextjs/saas-starter";
export const STARTER_SHA = "6e33e58b1e553a41fe22e6b941a7229a002de361";
export const STARTER_SCHEMA = `${STARTER_REPO}@${STARTER_SHA}`;
/** Git blob id of lib/db/migrations/0000_soft_the_anarchist.sql at STARTER_SHA, as GitHub reports it. */
export const STARTER_MIGRATION_BLOB = "b3dae05095f9108ce8bd5bfdb2fa5b7a67071fb2";
export const STARTER_SQL_PATH = fileURLToPath(new URL("../../seed/saas-starter.sql", import.meta.url));
export const STARTER_TABLES = ["users", "teams", "team_members", "activity_logs", "invitations"] as const;

export const APP_USERS = 252;
export const PRO_CENTS = 2900;
/** The starter writes plan_name from the Stripe product's name, so the product is called this. */
export const PLAN_NAME = "Pro";
/** Users get ids from here up, teams from 1: an audit that reports a user id where the key has a team id misses visibly instead of matching by accident. */
export const USER_ID_BASE = 1000;
const TAG = { [SEED_KEY]: "1" };
const IN_FLIGHT = 8;
const ADDRESS = { line1: "100 Demo Street", city: "San Francisco", state: "CA", postal_code: "94105", country: "US" };

// ---------------------------------------------------------------- the drift rules (pure)

export interface StarterTeam {
  id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_product_id: string | null;
  plan_name: string | null;
  subscription_status: string | null;
}

/** What the rules read from the starter's database, plus the active Stripe price of each product. */
export interface StarterSnapshot {
  users: { id: string; email: string; deleted: boolean }[];
  teams: StarterTeam[];
  team_members: { user_id: string; team_id: string; role: string }[];
  /** Monthly cents of the active recurring Stripe price per product (the starter stores no prices). */
  plan_prices: { product_id: string; monthly_cents: number }[];
}

/** Paid access, as the starter's dashboard reads it: a plan name, and Stripe last said active or trialing. */
export function isPaidTeam(t: Pick<StarterTeam, "plan_name" | "subscription_status">): boolean {
  const plan = (t.plan_name ?? "").trim().toLowerCase();
  return !!plan && plan !== "free" && isPaying((t.subscription_status ?? "").trim().toLowerCase());
}

const byId = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

/**
 * The drift between the starter's tables and Stripe, in the shape the agent
 * reports. user_id fields carry team ids, because the team is what pays.
 *
 *   paying = a Stripe subscription whose status is `active` or `trialing`
 *   a subscription maps to a team through teams.stripe_subscription_id or teams.stripe_customer_id
 *   A  a team on a paid plan (isPaidTeam) that no paying subscription maps to
 *   B  a paying subscription that maps to no team
 *   C  a team row whose subscription_status differs from Stripe's status for the
 *      subscription it names; one Stripe has no record of counts too, as `missing`
 *   leak = per A team: its own subscription's monthly price, else the active
 *      price of its stripe_product_id, else the price most paying subscriptions bill
 */
export function driftSaasStarterFrom(app: StarterSnapshot, stripeSubs: StripeSub[]): Findings {
  const subs = new Map(stripeSubs.map((s) => [s.id, s]));
  const teams = new Map(app.teams.map((t) => [t.id, t]));
  const teamBySub = new Map(app.teams.filter((t) => t.stripe_subscription_id).map((t) => [t.stripe_subscription_id!, t.id]));
  const teamByCustomer = new Map(app.teams.filter((t) => t.stripe_customer_id).map((t) => [t.stripe_customer_id!, t.id]));
  const mappedTeams = (s: StripeSub) => [teamBySub.get(s.id), teamByCustomer.get(s.customer)].filter((t): t is string => !!t && teams.has(t));

  const paying = [...subs.values()].filter((s) => isPaying(s.status));
  const paidUp = new Set(paying.flatMap(mappedTeams));

  const productPrice = new Map(app.plan_prices.map((p) => [p.product_id, p.monthly_cents]));
  const uses = new Map<number, number>();
  for (const s of paying) if (s.monthly_cents > 0) uses.set(s.monthly_cents, (uses.get(s.monthly_cents) ?? 0) + 1);
  const usual = [...uses].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 0;
  const priceOf = (t: StarterTeam) => {
    const own = t.stripe_subscription_id ? subs.get(t.stripe_subscription_id) : undefined;
    if (own && own.monthly_cents > 0) return own.monthly_cents;
    if (t.stripe_product_id && productPrice.has(t.stripe_product_id)) return productPrice.get(t.stripe_product_id)!;
    return usual;
  };

  const users = new Map(app.users.map((u) => [u.id, u]));
  const ownerEmail = new Map<string, string>();
  const live = app.team_members.filter((m) => users.has(m.user_id) && !users.get(m.user_id)!.deleted);
  for (const m of [...live.filter((m) => m.role === "owner"), ...live]) if (!ownerEmail.has(m.team_id)) ownerEmail.set(m.team_id, users.get(m.user_id)!.email);

  const paid = app.teams.filter(isPaidTeam);
  const pro_without_subscription = paid
    .filter((t) => !paidUp.has(t.id))
    .map((t) => {
      const status = t.stripe_subscription_id ? (subs.get(t.stripe_subscription_id)?.status ?? "missing") : null;
      const cause = status === null ? "never_paid" : status === "canceled" ? "cancelled_unsynced" : `stripe_${status}`;
      return { user_id: t.id, email: ownerEmail.get(t.id) ?? "", plan: t.plan_name ?? "", monthly_cents: priceOf(t), cause };
    })
    .sort((a, b) => byId(a.user_id, b.user_id));

  const payers_without_account = paying
    .filter((s) => !mappedTeams(s).length)
    .map((s) => ({ stripe_customer_id: s.customer, subscription_id: s.id, monthly_cents: s.monthly_cents }))
    .sort((a, b) => a.subscription_id.localeCompare(b.subscription_id));

  const stale_subscription_rows = app.teams
    .filter((t) => t.stripe_subscription_id)
    .map((t) => ({
      user_id: t.id,
      subscription_id: t.stripe_subscription_id!,
      app_status: t.subscription_status ?? "",
      stripe_status: subs.get(t.stripe_subscription_id!)?.status ?? "missing",
    }))
    .filter((r) => r.app_status !== r.stripe_status)
    .sort((a, b) => a.subscription_id.localeCompare(b.subscription_id));

  return {
    pro_without_subscription,
    payers_without_account,
    stale_subscription_rows,
    monthly_leak_cents: pro_without_subscription.reduce((n, r) => n + r.monthly_cents, 0),
    totals: { app_users: app.users.filter((u) => !u.deleted).length, app_pro_entitlements: paid.length, stripe_active_subscriptions: paying.length },
  };
}

// ---------------------------------------------------------------- the plan (pure)

export type TeamCohort = "paying" | "trialing" | "cancelling" | "cancelled_unsynced" | "never_paid" | "free_customer" | "free";

export interface TeamCohortSpec {
  count: number;
  /** Has a Stripe customer, named on the team row. */
  customer: boolean;
  /** The Stripe subscription to create, and the status Stripe reports once the seed is done. */
  sub: null | { status: "active" | "trialing" | "canceled"; trialDays?: number; cancelAtPeriodEnd?: boolean; cancelAfter?: boolean };
  /**
   * What the team row says. mirror: what the checkout route and webhook write. stuck_active: Pro and
   * `active` on a subscription Stripe cancelled. unverified_grant: Pro and `active`, no subscription.
   * customer_only: a customer id and nothing else. free: nothing.
   */
  row: "mirror" | "stuck_active" | "unverified_grant" | "customer_only" | "free";
}

const named: Record<Exclude<TeamCohort, "free">, TeamCohortSpec> = {
  paying: { count: 32, customer: true, sub: { status: "active" }, row: "mirror" },
  trialing: { count: 2, customer: true, sub: { status: "trialing", trialDays: 14 }, row: "mirror" },
  cancelling: { count: 2, customer: true, sub: { status: "active", cancelAtPeriodEnd: true }, row: "mirror" },
  cancelled_unsynced: { count: 5, customer: true, sub: { status: "canceled", cancelAfter: true }, row: "stuck_active" },
  never_paid: { count: 7, customer: true, sub: null, row: "unverified_grant" },
  free_customer: { count: 3, customer: true, sub: null, row: "customer_only" },
};

/** Every team cohort. Free teams take whoever is left of the 252 users, so their count comes from the plan. */
export const TEAM_COHORTS: Record<TeamCohort, TeamCohortSpec> = { ...named, free: { count: 0, customer: false, sub: null, row: "free" } };
/** Stripe customers paying for a subscription with no team in the app. */
export const ORPHAN_PAYERS = 3;
export const PAID_COHORTS: TeamCohort[] = ["paying", "trialing", "cancelling", "cancelled_unsynced", "never_paid"];

export interface PlannedUser {
  id: number;
  email: string;
  /** The starter signs people up with no name; some set one later. */
  name: string | null;
  joinedDaysAgo: number;
  role: "owner" | "member";
}

export interface PlannedTeam {
  id: number;
  cohort: TeamCohort;
  createdDaysAgo: number;
  /** When the checkout route or webhook last wrote the row. */
  updatedDaysAgo: number;
  /** Owner first. */
  members: PlannedUser[];
  /** Invitations still pending, to people who never signed up. */
  pendingInvites: string[];
}

export interface StarterPlan {
  teams: PlannedTeam[];
  orphans: { email: string; name: string }[];
}

const first = ["Priya", "Arjun", "Mei", "Tomas", "Fatima", "Lukas", "Aisha", "Noah", "Sofia", "Kenji", "Zara", "Diego", "Hana", "Omar", "Ivy", "Ravi"];
const last = ["Kapoor", "Nair", "Chen", "Silva", "Haddad", "Weber", "Okafor", "Brown", "Rossi", "Sato", "Ali", "Lopez", "Kim", "Farouk", "Clark", "Iyer"];
const nameFor = (k: number) => `${first[k % first.length]} ${last[Math.floor(k / first.length) % last.length]}`;
const emailFor = (k: number) => `${first[k % first.length].toLowerCase()}.${last[Math.floor(k / first.length) % last.length].toLowerCase()}${k}@leakfinder.test`;

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Paying teams tend to be bigger; most free teams are one person.
const PAID_SIZES = [1, 1, 1, 2, 2, 2, 3, 3, 4, 5];
const FREE_SIZES = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 3];

/**
 * Who exists, the same on every run: 252 users in teams, each signed up the
 * starter's way (an owner creates a team, invitees join it), the cohorts
 * shuffled through the table, ids in signup order.
 */
export function planStarter(): StarterPlan {
  const rand = mulberry32(29);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const shapes: { cohort: TeamCohort; size: number }[] = [];
  for (const c of Object.keys(named) as Exclude<TeamCohort, "free">[])
    for (let i = 0; i < named[c].count; i++) shapes.push({ cohort: c, size: PAID_COHORTS.includes(c) ? pick(PAID_SIZES) : 1 });
  let users = shapes.reduce((n, s) => n + s.size, 0);
  if (users > APP_USERS) throw new Error(`the named cohorts need ${users} users, more than ${APP_USERS}`);
  while (users < APP_USERS) {
    const size = Math.min(pick(FREE_SIZES), APP_USERS - users);
    shapes.push({ cohort: "free", size });
    users += size;
  }
  for (let i = shapes.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shapes[i], shapes[j]] = [shapes[j], shapes[i]];
  }

  let k = 0;
  const drafts = shapes.map((s) => {
    const createdDaysAgo = 30 + Math.floor(rand() * 510);
    const members = Array.from({ length: s.size }, (_, m) => {
      const joinedDaysAgo = m === 0 ? createdDaysAgo : createdDaysAgo - 1 - Math.floor(rand() * Math.min(createdDaysAgo - 1, 120));
      const n = k++;
      return { id: 0, email: emailFor(n), name: rand() < 0.6 ? nameFor(n) : null, joinedDaysAgo, role: m === 0 ? ("owner" as const) : ("member" as const) };
    });
    const sub = TEAM_COHORTS[s.cohort].sub || TEAM_COHORTS[s.cohort].row === "unverified_grant";
    const updatedDaysAgo = sub ? Math.min(createdDaysAgo, 1 + Math.floor(rand() * 28)) : createdDaysAgo;
    return { id: 0, cohort: s.cohort, createdDaysAgo, updatedDaysAgo, members, pendingInvites: [] as string[] };
  });

  // Ids in creation order, as serial columns hand them out.
  drafts.map((t, i) => ({ t, i })).sort((a, b) => b.t.createdDaysAgo - a.t.createdDaysAgo || a.i - b.i).forEach(({ t }, n) => (t.id = n + 1));
  drafts
    .flatMap((t) => t.members.map((u, m) => ({ u, team: t.id, m })))
    .sort((a, b) => b.u.joinedDaysAgo - a.u.joinedDaysAgo || a.team - b.team || a.m - b.m)
    .forEach(({ u }, n) => (u.id = USER_ID_BASE + n + 1));
  const teams = drafts.sort((a, b) => a.id - b.id);
  // A few invitations nobody accepted yet.
  for (let i = 0; i < 4; i++) pick(teams).pendingInvites.push(`invitee${i + 1}@leakfinder.test`);
  const orphans = Array.from({ length: ORPHAN_PAYERS }, (_, i) => ({ email: emailFor(900 + i), name: nameFor(900 + i) }));
  return { teams, orphans };
}

/** A team after its Stripe side exists. */
export interface SeededTeam extends PlannedTeam {
  customerId: string | null;
  sub: { id: string; status: string; cancelAtPeriodEnd: boolean; monthlyCents: number } | null;
}

export interface SeededOrphan {
  email: string;
  customerId: string;
  sub: { id: string; status: string; monthlyCents: number };
}

export interface StarterSeeded {
  productId: string;
  priceId: string;
  teams: SeededTeam[];
  orphans: SeededOrphan[];
}

/** The starter's rows, column for column; nothing here is a column the migration does not create. */
export interface StarterRows {
  users: { id: number; name: string | null; email: string; password_hash: string; role: string; created_at: Date; updated_at: Date }[];
  teams: {
    id: number;
    name: string;
    created_at: Date;
    updated_at: Date;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    stripe_product_id: string | null;
    plan_name: string | null;
    subscription_status: string | null;
  }[];
  team_members: { user_id: number; team_id: number; role: string; joined_at: Date }[];
  invitations: { team_id: number; email: string; role: string; invited_by: number; invited_at: Date; status: string }[];
  activity_logs: { team_id: number; user_id: number; action: string; timestamp: Date; ip_address: string }[];
}

/**
 * bcrypt-shaped, but not the output of bcrypt for any password: no seeded
 * user can sign in. Deterministic so a re-seed writes the same rows.
 */
export function unusablePasswordHash(email: string): string {
  const alphabet = "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = createHash("sha512").update(`leakfinder-unusable:${email}`).digest();
  return `$2a$10$${Array.from(bytes.subarray(0, 53), (b) => alphabet[b % 64]).join("")}`;
}

/** The app's rows for what was created in Stripe, written the way the starter's own code writes them. The drift lives in teams. */
export function starterRowsFor(seeded: StarterSeeded, now = Date.now()): StarterRows {
  const at = (daysAgo: number, minutes = 0) => new Date(now - daysAgo * 86_400_000 + minutes * 60_000);
  const rows: StarterRows = { users: [], teams: [], team_members: [], invitations: [], activity_logs: [] };
  for (const t of seeded.teams) {
    const spec = TEAM_COHORTS[t.cohort];
    const owner = t.members[0];
    const paid = spec.row === "mirror" || spec.row === "stuck_active" || spec.row === "unverified_grant";
    rows.teams.push({
      id: t.id,
      // signUp names a new team after its owner's email.
      name: `${owner.email}'s Team`,
      created_at: at(t.createdDaysAgo),
      updated_at: at(t.updatedDaysAgo),
      stripe_customer_id: spec.row === "free" ? null : t.customerId,
      stripe_subscription_id: spec.row === "mirror" || spec.row === "stuck_active" ? t.sub!.id : null,
      stripe_product_id: paid ? seeded.productId : null,
      plan_name: paid ? PLAN_NAME : null,
      subscription_status: spec.row === "mirror" ? t.sub!.status : paid ? "active" : null,
    });
    for (const u of t.members) {
      // signUp writes role 'owner' on every new user; the invitation's role goes on team_members only.
      rows.users.push({ id: u.id, name: u.name, email: u.email, password_hash: unusablePasswordHash(u.email), role: "owner", created_at: at(u.joinedDaysAgo), updated_at: at(u.joinedDaysAgo) });
      rows.team_members.push({ user_id: u.id, team_id: t.id, role: u.role, joined_at: at(u.joinedDaysAgo) });
      if (u.role === "member")
        rows.invitations.push({ team_id: t.id, email: u.email, role: "member", invited_by: owner.id, invited_at: at(u.joinedDaysAgo, -90), status: "accepted" });
      // logActivity as signUp calls it: no IP address is passed, so it stores ''.
      rows.activity_logs.push({ team_id: t.id, user_id: u.id, action: u.role === "owner" ? "CREATE_TEAM" : "ACCEPT_INVITATION", timestamp: at(u.joinedDaysAgo), ip_address: "" });
      rows.activity_logs.push({ team_id: t.id, user_id: u.id, action: "SIGN_UP", timestamp: at(u.joinedDaysAgo, 1), ip_address: "" });
    }
    for (const email of t.pendingInvites) rows.invitations.push({ team_id: t.id, email, role: "member", invited_by: owner.id, invited_at: at(3), status: "pending" });
  }
  rows.users.sort((a, b) => a.id - b.id);
  rows.team_members.sort((a, b) => a.user_id - b.user_id);
  rows.invitations.sort((a, b) => +a.invited_at - +b.invited_at || a.team_id - b.team_id);
  rows.activity_logs.sort((a, b) => +a.timestamp - +b.timestamp || a.user_id - b.user_id);
  return rows;
}

/** The same rows in the shape the drift rules read. */
export function starterSnapshotOf(rows: StarterRows, planPrices: StarterSnapshot["plan_prices"]): StarterSnapshot {
  return {
    users: rows.users.map((u) => ({ id: String(u.id), email: u.email, deleted: false })),
    teams: rows.teams.map((t) => ({
      id: String(t.id),
      stripe_customer_id: t.stripe_customer_id,
      stripe_subscription_id: t.stripe_subscription_id,
      stripe_product_id: t.stripe_product_id,
      plan_name: t.plan_name,
      subscription_status: t.subscription_status,
    })),
    team_members: rows.team_members.map((m) => ({ user_id: String(m.user_id), team_id: String(m.team_id), role: m.role })),
    plan_prices: planPrices,
  };
}

export const starterStripeSubsOf = (seeded: StarterSeeded): StripeSub[] => [
  ...seeded.teams.flatMap((t) => (t.sub && t.customerId ? [{ id: t.sub.id, customer: t.customerId, status: t.sub.status, monthly_cents: t.sub.monthlyCents }] : [])),
  ...seeded.orphans.map((o) => ({ id: o.sub.id, customer: o.customerId, status: o.sub.status, monthly_cents: o.sub.monthlyCents })),
];

/**
 * seed/expected.json, in the main seed's shape: what was planted, by id, from
 * the plan alone (not from the drift rules, so the two check each other).
 * user_id is the team id; owner_user_id is there for a scorer that also
 * accepts the owner.
 */
export function starterAnswerKey(seeded: StarterSeeded, proCents = PRO_CENTS) {
  const of = (c: TeamCohort) => seeded.teams.filter((t) => t.cohort === c);
  const neverPaid = of("never_paid");
  const unsynced = of("cancelled_unsynced");
  const a = (t: SeededTeam, cause: string) => ({ user_id: String(t.id), team_id: String(t.id), owner_user_id: String(t.members[0].id), cause });
  const leak = (neverPaid.length + unsynced.length) * proCents;
  const paidTeams = seeded.teams.filter((t) => PAID_COHORTS.includes(t.cohort));
  return {
    schema: STARTER_SCHEMA,
    entity: "team",
    pro_without_subscription: [...unsynced.map((t) => a(t, "cancelled_unsynced")), ...neverPaid.map((t) => a(t, "never_paid"))],
    payers_without_account: seeded.orphans.map((o) => ({ stripe_customer_id: o.customerId, subscription_id: o.sub.id })),
    stale_subscription_rows: unsynced.map((t) => ({ user_id: String(t.id), team_id: String(t.id), subscription_id: t.sub!.id, app_status: "active", stripe_status: t.sub!.status })),
    monthly_leak_cents: leak,
    // The owner of a cancelled-unsynced team: in findings.json inside the VM, never in the transcript.
    grep_target_email: unsynced[0]?.members[0].email ?? "",
    planted_summary: {
      pro_without_subscription: neverPaid.length + unsynced.length,
      never_paid: neverPaid.length,
      cancelled_unsynced: unsynced.length,
      payers_without_account: seeded.orphans.length,
      stale_subscription_rows: unsynced.length,
      monthly_leak_cents: leak,
      pro_cents: proCents,
      teams: seeded.teams.length,
      paid_teams: paidTeams.length,
      multi_member_teams: seeded.teams.filter((t) => t.members.length > 1).length,
      noise_not_drift: { trialing_pro: of("trialing").length, cancel_at_period_end: of("cancelling").length, free_with_stripe_customer: of("free_customer").length },
    },
    totals: {
      app_users: seeded.teams.reduce((n, t) => n + t.members.length, 0),
      app_pro_entitlements: paidTeams.length,
      stripe_active_subscriptions: starterStripeSubsOf(seeded).filter((s) => isPaying(s.status)).length,
    },
  };
}

// ---------------------------------------------------------------- Stripe

/** One team's Stripe side, in order: customer (as Checkout leaves it), subscription, cancellation. */
export async function materializeTeam(stripe: Stripe, t: PlannedTeam, priceId: string): Promise<SeededTeam> {
  const spec = TEAM_COHORTS[t.cohort];
  if (!spec.customer) return { ...t, customerId: null, sub: null };
  const owner = t.members[0];
  const card = spec.sub ? { payment_method: "pm_card_visa", invoice_settings: { default_payment_method: "pm_card_visa" } } : {};
  // A billing address on every customer: Stripe accounts in India reject USD payments and invoices without one.
  const customer = await retry429(() => stripe.customers.create({ email: owner.email, ...(owner.name ? { name: owner.name } : {}), address: ADDRESS, metadata: TAG, ...card }));
  if (!spec.sub) return { ...t, customerId: customer.id, sub: null };
  const want = spec.sub;
  let sub = await retry429(() =>
    stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      metadata: TAG,
      payment_behavior: "error_if_incomplete",
      ...(want.trialDays ? { trial_period_days: want.trialDays } : {}),
      ...(want.cancelAtPeriodEnd ? { cancel_at_period_end: true } : {}),
    }),
  );
  const cents = monthlyCents(sub);
  if (want.cancelAfter) {
    const created = sub;
    sub = await retry429(() => stripe.subscriptions.cancel(created.id));
  }
  return { ...t, customerId: customer.id, sub: { id: sub.id, status: sub.status, cancelAtPeriodEnd: sub.cancel_at_period_end, monthlyCents: cents } };
}

async function materializeOrphan(stripe: Stripe, o: StarterPlan["orphans"][number], priceId: string): Promise<SeededOrphan> {
  const customer = await retry429(() =>
    stripe.customers.create({ email: o.email, name: o.name, address: ADDRESS, metadata: TAG, payment_method: "pm_card_visa", invoice_settings: { default_payment_method: "pm_card_visa" } }),
  );
  const sub = await retry429(() => stripe.subscriptions.create({ customer: customer.id, items: [{ price: priceId }], metadata: TAG, payment_behavior: "error_if_incomplete" }));
  return { email: o.email, customerId: customer.id, sub: { id: sub.id, status: sub.status, monthlyCents: monthlyCents(sub) } };
}

/**
 * Sweeps the previous seed (either seed's), then creates the Pro product, its
 * one active $29/month price, and every team's and orphan's Stripe side.
 */
export async function seedStarterStripe(stripe: Stripe, log: (line: string) => void = () => {}) {
  const swept = await sweepPreviousSeed(stripe);
  const product = await retry429(() => stripe.products.create({ name: PLAN_NAME, description: "LeakFinder demo plan for the Next.js SaaS Starter", metadata: TAG }));
  const price = await retry429(() =>
    stripe.prices.create({ product: product.id, unit_amount: PRO_CENTS, currency: "usd", recurring: { interval: "month" }, metadata: TAG }),
  );
  const plan = planStarter();
  const total = plan.teams.filter((t) => TEAM_COHORTS[t.cohort].customer).length + plan.orphans.length;
  let done = 0;
  const tick = () => log(`\rstripe: ${++done}/${total} customers with their subscriptions`);
  const teams = await pool(plan.teams, IN_FLIGHT, async (t) => {
    const s = await materializeTeam(stripe, t, price.id);
    if (s.customerId) tick();
    return s;
  });
  const orphans = await pool(plan.orphans, IN_FLIGHT, async (o) => {
    const s = await materializeOrphan(stripe, o, price.id);
    tick();
    return s;
  });
  const seeded: StarterSeeded = { productId: product.id, priceId: price.id, teams, orphans };
  return { swept, seeded };
}

/** Monthly cents of every active recurring price, per product: what a Pro team with no subscription is worth. */
export async function loadPlanPrices(stripe: Stripe): Promise<StarterSnapshot["plan_prices"]> {
  const out = new Map<string, number>();
  for await (const p of stripe.prices.list({ active: true, limit: 100 })) {
    const product = typeof p.product === "string" ? p.product : p.product?.id;
    if (!p.recurring || !product) continue;
    // Newest first; the first active price of a product is the one Checkout would sell today.
    if (!out.has(product)) out.set(product, monthlyCents({ items: { data: [{ price: p, quantity: 1 }] } } as unknown as Stripe.Subscription));
  }
  return [...out].map(([product_id, monthly_cents]) => ({ product_id, monthly_cents }));
}

// ---------------------------------------------------------------- Postgres

export const readStarterSql = () => readFileSync(STARTER_SQL_PATH, "utf8");

/**
 * The main demo's tables (seed/schema.sql). Dropped when switching a database
 * the main seed filled, so the audit sees only the starter's schema.
 */
const MAIN_DEMO_TABLES = ["entitlements", "subscriptions", "prices", "products", "customers"];

/** Resets the schema and writes every row in one transaction; serial sequences continue after the seeded ids. */
export async function writeStarterRows(db: pg.ClientBase, rows: StarterRows, sql = readStarterSql()) {
  await db.query("begin");
  try {
    await db.query(sql);
    await insertRows(db, "users", rows.users);
    await insertRows(db, "teams", rows.teams);
    await insertRows(db, "team_members", rows.team_members);
    await insertRows(db, "invitations", rows.invitations);
    await insertRows(db, "activity_logs", rows.activity_logs);
    for (const t of ["users", "teams"]) await db.query(`select setval(pg_get_serial_sequence('${t}', 'id'), coalesce((select max(id) from ${t}), 0) + 1, false)`);
    await db.query("commit");
  } catch (e) {
    await db.query("rollback");
    throw e;
  }
}

/** Drops the main demo's leftover tables, only when its LeakFinder-specific `entitlements` table is there too. */
export async function dropMainDemoTables(db: pg.ClientBase): Promise<boolean> {
  const { rows } = await db.query("select to_regclass('public.entitlements') is not null as present");
  if (!rows[0]?.present) return false;
  await db.query(`drop table if exists ${MAIN_DEMO_TABLES.join(", ")} cascade`);
  return true;
}

export async function loadStarterApp(db: pg.ClientBase, stripe: Stripe): Promise<StarterSnapshot> {
  // One query at a time: pg prints a DeprecationWarning when a client gets a query while one is running.
  const users = await db.query("select id::text as id, email, deleted_at is not null as deleted from users");
  const teams = await db.query("select id::text as id, stripe_customer_id, stripe_subscription_id, stripe_product_id, plan_name, subscription_status from teams");
  const members = await db.query("select user_id::text as user_id, team_id::text as team_id, role from team_members order by id");
  return { users: users.rows, teams: teams.rows, team_members: members.rows, plan_prices: await loadPlanPrices(stripe) };
}

// ---------------------------------------------------------------- live

export interface LiveDeps {
  db?: pg.ClientBase;
  stripe?: Stripe;
}

/** The full drift, live, with the snapshot it was computed from. */
export async function auditSaasStarterLive(deps: LiveDeps = {}): Promise<{ findings: Findings; app: StarterSnapshot }> {
  const stripe = deps.stripe ?? stripeClient();
  const own = deps.db ? null : pgClient();
  const db = deps.db ?? own!;
  if (own) await own.connect();
  try {
    const app = await loadStarterApp(db, stripe);
    const subs = await loadStripe(stripe, app.teams.flatMap((t) => (t.stripe_subscription_id ? [t.stripe_subscription_id] : [])));
    return { findings: driftSaasStarterFrom(app, subs), app };
  } finally {
    if (own) await own.end();
  }
}

/** The three counts and the monthly leak, live from Postgres and Stripe; same shape as verify's computeDrift. */
export async function driftSaasStarter(deps: LiveDeps = {}): Promise<DriftCounts> {
  return countsOf((await auditSaasStarterLive(deps)).findings);
}

const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const fmt = (c: DriftCounts) => `A ${c.pro_without_subscription} · B ${c.payers_without_account} · C ${c.stale_subscription_rows} · ${dollars(c.monthly_leak_cents)}/month`;

export function printStarterDrift(f: Findings, app: StarterSnapshot, log: (line: string) => void = console.log) {
  const c = countsOf(f);
  const never = f.pro_without_subscription.filter((r) => r.cause === "never_paid").length;
  log(`schema  ${STARTER_SCHEMA} (paid access on teams.plan_name + teams.subscription_status)`);
  log(`read  ${f.totals.app_users} app users · ${app.teams.length} teams · ${f.totals.app_pro_entitlements} on a paid plan · ${f.totals.stripe_active_subscriptions} active or trialing Stripe subscriptions`);
  log(`A  paid plan nobody pays for     ${String(c.pro_without_subscription).padStart(3)}   (${never} never paid · ${c.pro_without_subscription - never} cancelled in Stripe)`);
  log(`B  paying with no team           ${String(c.payers_without_account).padStart(3)}   (${dollars(f.payers_without_account.reduce((n, r) => n + r.monthly_cents, 0))}/month billed)`);
  log(`C  team rows out of sync         ${String(c.stale_subscription_rows).padStart(3)}`);
  log(`leak  ${dollars(c.monthly_leak_cents)} / month`);
}

const KEY_PATH = fileURLToPath(new URL("../../seed/expected.json", import.meta.url));

export interface SeedOptions extends LiveDeps {
  now?: number;
  /** Where to write the answer key; false skips it. Default seed/expected.json. */
  keyPath?: string | false;
  log?: (line: string) => void;
}

/** Resets the database to the starter's schema, plants the drift in it and in Stripe, writes the answer key, and reads it back. */
export async function seedSaasStarter(opts: SeedOptions = {}) {
  const t0 = Date.now();
  const log = opts.log ?? ((line: string) => console.log(line));
  const stripe = opts.stripe ?? stripeClient();
  if (!opts.stripe && !/^(sk|rk)_test_/.test(env.stripeKey())) throw new Error("the seed creates customers and charges: use a test-mode key (sk_test_ or rk_test_)");
  const own = opts.db ? null : pgClient();
  const db = opts.db ?? own!;
  if (own) await own.connect();
  try {
    await assertDemoDatabase(db);
    const { swept, seeded } = await seedStarterStripe(stripe, (l) => (opts.log ? undefined : process.stdout.write(l)));
    if (!opts.log) process.stdout.write("\n");
    log(`stripe: previous seed cleared · ${swept.customers} customers deleted (found by ${swept.via}) · ${swept.cancelled} subscriptions cancelled · ${swept.products} products, ${swept.prices} prices archived`);
    if (swept.failed) log(`warning: ${swept.failed} seed objects could not be removed; the next run retries them`);
    if (swept.foreignPaying) log(`warning: ${swept.foreignPaying} active or trialing subscriptions in this account are not the seed's; the recount will show them as payers with no team`);
    for (const t of seeded.teams) {
      const want = TEAM_COHORTS[t.cohort].sub?.status;
      if (t.sub && want && t.sub.status !== want) log(`warning: a ${t.cohort} subscription is ${t.sub.status}, expected ${want}`);
    }

    const rows = starterRowsFor(seeded, opts.now);
    if (await dropMainDemoTables(db)) log("db: dropped the main demo's tables (seed/schema.sql) so only the starter's schema is left");
    await writeStarterRows(db, rows);
    const paid = rows.teams.filter(isPaidTeam).length;
    log(`db: ${STARTER_SCHEMA} · ${rows.users.length} users · ${rows.teams.length} teams (${rows.teams.filter((t) => rows.team_members.filter((m) => m.team_id === t.id).length > 1).length} with several members) · ${paid} on ${PLAN_NAME} · ${rows.activity_logs.length} activity logs · ${rows.invitations.length} invitations`);

    const key = starterAnswerKey(seeded);
    if (opts.keyPath !== false) writeFileSync(opts.keyPath ?? KEY_PATH, JSON.stringify(key, null, 2) + "\n");
    const planted: DriftCounts = {
      pro_without_subscription: key.pro_without_subscription.length,
      payers_without_account: key.payers_without_account.length,
      stale_subscription_rows: key.stale_subscription_rows.length,
      monthly_leak_cents: key.monthly_leak_cents,
    };
    log(`planted: ${fmt(planted)} · answer key and grep target in seed/expected.json`);
    const live = countsOf((await auditSaasStarterLive({ db, stripe })).findings);
    const same = (Object.keys(planted) as (keyof DriftCounts)[]).every((k) => planted[k] === live[k]);
    log(same ? `self-check: the recount reads the same back (${fmt(live)})` : `warning: the recount reads ${fmt(live)}, planted ${fmt(planted)}`);
    log(`seeded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return { key, planted, live, same, seeded, rows };
  } finally {
    if (own) await own.end();
  }
}

async function verifyMain() {
  const t0 = Date.now();
  const { findings, app } = await auditSaasStarterLive();
  printStarterDrift(findings, app);
  try {
    if (existsSync(KEY_PATH)) {
      const key = JSON.parse(readFileSync(KEY_PATH, "utf8"));
      if (key.schema !== STARTER_SCHEMA) console.log(`seed answer key: written for ${key.schema ?? "the main demo schema"}, not compared`);
      else {
        const want: DriftCounts = {
          pro_without_subscription: key.pro_without_subscription?.length ?? 0,
          payers_without_account: key.payers_without_account?.length ?? 0,
          stale_subscription_rows: key.stale_subscription_rows?.length ?? 0,
          monthly_leak_cents: Number(key.monthly_leak_cents) || 0,
        };
        const got = countsOf(findings);
        const off = (Object.keys(want) as (keyof DriftCounts)[]).filter((k) => want[k] !== got[k]);
        console.log(
          off.length
            ? `seed answer key: planted ${fmt(want)}; live differs on ${off.join(", ")} (expected after an apply, or if the account has other subscriptions)`
            : "seed answer key: matches (seed/expected.json)",
        );
      }
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
  const cmd = process.argv[2];
  const run = cmd === "seed" ? () => seedSaasStarter().then(() => undefined) : cmd === "verify" ? verifyMain : null;
  if (!run) {
    console.error("usage: tsx src/starters/saas-starter.ts seed|verify");
    process.exit(2);
  }
  run().then(
    // The Stripe SDK keeps an HTTP agent alive; exit once the work is done.
    () => process.exit(0),
    (e) => {
      console.error(`${cmd} failed: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    },
  );
}
