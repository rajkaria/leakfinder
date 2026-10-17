import { config } from "dotenv";

// `stripe projects env --pull` rewrites .env, so keys you add by hand (the Stripe
// test key, the Anthropic key) live in .env.local. Whichever file sets a name first wins.
config({ path: [".env.local", ".env"], quiet: true });

/**
 * `stripe projects env --pull` names variables per provider (and prefixes them
 * with `--name`), so each credential is looked up under the names it is known
 * to come with before giving up. The canonical name always wins.
 */
const ALIASES: Record<string, { names: string[]; suffix?: RegExp }> = {
  CREATEOS_SANDBOX_API_KEY: { names: ["CREATEOS_SANDBOX_API_KEY", "CREATEOS_API_KEY", "CREATEOS_PROJECT_API_KEY"], suffix: /CREATEOS.*_API_KEY$/ },
  DATABASE_URL: { names: ["DATABASE_URL", "NEON_POSTGRES_CONNECTION_STRING", "POSTGRES_URL", "NEON_DATABASE_URL", "PGURL"], suffix: /(_DATABASE_URL|_POSTGRES_URL)$/ },
  STRIPE_SECRET_KEY: { names: ["STRIPE_SECRET_KEY", "STRIPE_API_KEY"] },
  ANTHROPIC_API_KEY: { names: ["ANTHROPIC_API_KEY"] },
};

/** Which variable supplies a credential, or null. A suffix match counts only when exactly one variable matches. */
export function sourceOf(canonical: keyof typeof ALIASES & string, vars: NodeJS.ProcessEnv = process.env): string | null {
  const a = ALIASES[canonical];
  const direct = a.names.find((n) => vars[n]);
  if (direct) return direct;
  if (!a.suffix) return null;
  const hits = Object.keys(vars).filter((k) => a.suffix!.test(k) && vars[k]);
  return hits.length === 1 ? hits[0] : null;
}

export const CREDENTIALS = Object.keys(ALIASES);

function need(canonical: string): string {
  const from = sourceOf(canonical);
  if (!from) throw new Error(`Missing ${canonical} in .env (also looked for ${ALIASES[canonical].names.slice(1).join(", ") || "no other names"}; see .env.example)`);
  return process.env[from]!;
}

export const env = {
  createosKey: () => need("CREATEOS_SANDBOX_API_KEY"),
  databaseUrl: () => need("DATABASE_URL"),
  stripeKey: () => need("STRIPE_SECRET_KEY"),
  anthropicKey: () => need("ANTHROPIC_API_KEY"),
  model: () => process.env.LEAKFINDER_MODEL || "claude-sonnet-5-5",
  /** Optional speed lever for live demos: low | medium | high | xhigh | max. Unset = the model's default. */
  effort: (): "low" | "medium" | "high" | "xhigh" | "max" | undefined => {
    const v = process.env.LEAKFINDER_EFFORT;
    if (!v) return undefined;
    if (!["low", "medium", "high", "xhigh", "max"].includes(v)) throw new Error(`LEAKFINDER_EFFORT must be low, medium, high, xhigh or max, not ${v}`);
    return v as "low" | "medium" | "high" | "xhigh" | "max";
  },
  /** Seconds of idle before the run's sandbox pauses itself (its report URL wakes it). 0 turns it off. */
  autoPauseSeconds: () => Number(process.env.LEAKFINDER_AUTOPAUSE ?? 600),
};

/** Hostname of the Postgres server, for the egress allowlist. */
export function databaseHost(url = env.databaseUrl()): string {
  return new URL(url).hostname;
}
