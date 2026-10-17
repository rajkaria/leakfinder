/**
 * Planted-vs-found against the seed's answer key (seed/expected.json). Only
 * meaningful on the seeded demo; on a real account there is no key and the
 * report simply leaves the panel out.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Findings, Score } from "./types.js";

const PACKAGE_KEY = fileURLToPath(new URL("../seed/expected.json", import.meta.url));

/**
 * The answer key the seed wrote, or null when there is none or it does not
 * parse. Without a path: ./seed/expected.json, else the package's own copy.
 */
export function loadExpected(path?: string): any | null {
  if (!path) path = existsSync("seed/expected.json") ? "seed/expected.json" : PACKAGE_KEY;
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

const id = (v: unknown) => (v == null ? "" : String(v).trim());
// Postgres prints UUIDs lowercase; an agent might not.
const uid = (v: unknown) => id(v).toLowerCase();

/** Every identity a row can be matched on. Two rows are the same case when they share one. */
type Keys = (row: any) => string[];
const keys = (...parts: [string, (r: any) => string][]): Keys => (row) =>
  parts.map(([tag, get]) => [tag, get(row)] as const).filter(([, v]) => v).map(([tag, v]) => `${tag}:${v}`);

const byUser = keys(["user", (r) => uid(r?.user_id)]);
const byPayer = keys(["sub", (r) => id(r?.subscription_id)], ["cus", (r) => id(r?.stripe_customer_id)]);
const byRow = keys(["sub", (r) => id(r?.subscription_id)], ["user", (r) => uid(r?.user_id)]);

const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);

/**
 * found = planted cases the agent reported; extra = cases it reported that
 * were not planted. A case reported twice counts once.
 */
function tally(found: any[], planted: any[], keyOf: Keys) {
  const foundKeys = new Set(found.flatMap(keyOf));
  const plantedKeys = new Set(planted.flatMap(keyOf));
  const hit = planted.filter((p) => keyOf(p).some((k) => foundKeys.has(k))).length;
  const seen = new Set<string>();
  let extra = 0;
  for (const row of found) {
    const ks = keyOf(row);
    if (!ks.length || ks.some((k) => plantedKeys.has(k) || seen.has(k))) continue;
    ks.forEach((k) => seen.add(k));
    extra++;
  }
  return { found: hit, planted: planted.length, extra };
}

export function scoreAgainstExpected(f: Findings, expected: any): Score {
  return {
    pro_without_subscription: tally(f.pro_without_subscription, list(expected?.pro_without_subscription), byUser),
    payers_without_account: tally(f.payers_without_account, list(expected?.payers_without_account), byPayer),
    stale_subscription_rows: tally(f.stale_subscription_rows, list(expected?.stale_subscription_rows), byRow),
    leak_cents: {
      found: f.monthly_leak_cents,
      planted: Number.isFinite(Number(expected?.monthly_leak_cents)) ? Math.round(Number(expected.monthly_leak_cents)) : 0,
    },
  };
}

/** Totals across the three categories, for the one-line verdict. */
export function scoreTotals(s: Score) {
  const parts = [s.pro_without_subscription, s.payers_without_account, s.stale_subscription_rows];
  return {
    found: parts.reduce((n, p) => n + p.found, 0),
    planted: parts.reduce((n, p) => n + p.planted, 0),
    extra: parts.reduce((n, p) => n + p.extra, 0),
  };
}
