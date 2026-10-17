/**
 * Shapes shared by the agent, the CLI, the report and the in-VM server.
 * findings.json is written by agent-authored Python inside the sandbox, so
 * every reader treats it as untrusted and goes through `normalizeFindings`.
 */

export interface ProWithoutSubscription {
  user_id: string;
  email: string;
  plan: string;
  monthly_cents: number;
  cause: string;
}

export interface PayerWithoutAccount {
  stripe_customer_id: string;
  subscription_id: string;
  monthly_cents: number;
}

export interface StaleSubscriptionRow {
  user_id: string;
  subscription_id: string;
  app_status: string;
  stripe_status: string;
}

export interface Findings {
  pro_without_subscription: ProWithoutSubscription[];
  payers_without_account: PayerWithoutAccount[];
  stale_subscription_rows: StaleSubscriptionRow[];
  monthly_leak_cents: number;
  totals: { app_users: number; app_pro_entitlements: number; stripe_active_subscriptions: number };
}

/** The last line fix.py prints, after the marker. Same shape for dry run and apply. */
export const SUMMARY_MARKER = "LEAKFINDER_SUMMARY";

export interface FixSummary {
  mode: "dry_run" | "applied";
  /** Pro entitlements revoked (or that would be). */
  revoked: number;
  /** Invoices sent to users who had Pro without paying, and their total. */
  invoices: number;
  invoiced_cents: number;
  /** Refunds to people paying with no account, and their total. */
  refunds: number;
  refunded_cents: number;
  /** Subscriptions cancelled in Stripe (the orphan payers). */
  cancelled: number;
  /** App subscription rows set to Stripe's status. */
  rows_synced: number;
  /** Monthly leak closed by revoking access that nobody pays for. */
  leak_closed_cents: number;
}

export function parseSummary(stdout: string): FixSummary | null {
  const line = stdout
    .split("\n")
    .reverse()
    .find((l) => l.startsWith(SUMMARY_MARKER));
  if (!line) return null;
  try {
    const raw = JSON.parse(line.slice(SUMMARY_MARKER.length).trim());
    const n = (k: string) => (Number.isFinite(Number(raw[k])) ? Math.round(Number(raw[k])) : 0);
    return {
      mode: raw.mode === "applied" ? "applied" : "dry_run",
      revoked: n("revoked"),
      invoices: n("invoices"),
      invoiced_cents: n("invoiced_cents"),
      refunds: n("refunds"),
      refunded_cents: n("refunded_cents"),
      cancelled: n("cancelled"),
      rows_synced: n("rows_synced"),
      leak_closed_cents: n("leak_closed_cents"),
    };
  } catch {
    return null;
  }
}

const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const int = (v: unknown) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
const str = (v: unknown) => (v == null ? "" : String(v));

/** Coerce agent-written JSON into the Findings shape; missing parts become empty. */
export function normalizeFindings(raw: any): Findings {
  const t = raw?.totals ?? {};
  return {
    pro_without_subscription: arr(raw?.pro_without_subscription).map((r) => ({
      user_id: str(r?.user_id),
      email: str(r?.email),
      plan: str(r?.plan),
      monthly_cents: int(r?.monthly_cents),
      cause: str(r?.cause),
    })),
    payers_without_account: arr(raw?.payers_without_account).map((r) => ({
      stripe_customer_id: str(r?.stripe_customer_id),
      subscription_id: str(r?.subscription_id),
      monthly_cents: int(r?.monthly_cents),
    })),
    stale_subscription_rows: arr(raw?.stale_subscription_rows).map((r) => ({
      user_id: str(r?.user_id),
      subscription_id: str(r?.subscription_id),
      app_status: str(r?.app_status),
      stripe_status: str(r?.stripe_status),
    })),
    monthly_leak_cents: int(raw?.monthly_leak_cents),
    totals: {
      app_users: int(t.app_users),
      app_pro_entitlements: int(t.app_pro_entitlements),
      stripe_active_subscriptions: int(t.stripe_active_subscriptions),
    },
  };
}

/** What the report's "how this was produced" section states. Every field is measured, never typed in. */
export interface RunMeta {
  sandboxId: string;
  egress: string[];
  sealed: boolean;
  sealDetail: string;
  turns: number;
  /** Scripts that failed and were rewritten by the agent before the audit passed. */
  rewrites: number;
  /** True when a saved skill for this schema ran first and needed no model turn. */
  reusedSkill: boolean;
  inputTokens: number;
  outputTokens: number;
  redacted: number;
  transcriptPath: string;
  /** Hits of the seeded canary email in the transcript; null when no seed answer key exists. */
  canaryHits: number | null;
  model: string;
  startedAt: string;
  seconds: number;
}

/** Planted-vs-found, from seed/expected.json. Only meaningful on the seeded demo. */
export interface Score {
  pro_without_subscription: { found: number; planted: number; extra: number };
  payers_without_account: { found: number; planted: number; extra: number };
  stale_subscription_rows: { found: number; planted: number; extra: number };
  leak_cents: { found: number; planted: number };
}
