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
  DEEPSEEK_API_KEY: { names: ["DEEPSEEK_API_KEY"] },
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

export type Provider = "anthropic" | "deepseek";

/** Which model API writes the code: LEAKFINDER_PROVIDER, else whichever key is present (Anthropic first). */
export function provider(vars: NodeJS.ProcessEnv = process.env): Provider {
  const p = vars.LEAKFINDER_PROVIDER;
  if (p === "anthropic" || p === "deepseek") return p;
  if (p) throw new Error(`LEAKFINDER_PROVIDER must be anthropic or deepseek, not ${p}`);
  return vars.ANTHROPIC_API_KEY || !vars.DEEPSEEK_API_KEY ? "anthropic" : "deepseek";
}

const MODEL_KEY: Record<Provider, string> = { anthropic: "ANTHROPIC_API_KEY", deepseek: "DEEPSEEK_API_KEY" };
const DEFAULT_MODEL: Record<Provider, string> = { anthropic: "claude-sonnet-5-5", deepseek: "deepseek-v4-pro" };

/** The credentials this run needs: the three data and sandbox keys, plus the active provider's model key. */
export function requiredCredentials(): string[] {
  return ["CREATEOS_SANDBOX_API_KEY", "DATABASE_URL", "STRIPE_SECRET_KEY", MODEL_KEY[provider()]];
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
  deepseekKey: () => need("DEEPSEEK_API_KEY"),
  /** OpenAI-compatible endpoint; override for a proxy. */
  deepseekBaseUrl: () => (process.env.LEAKFINDER_DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, ""),
  provider: () => provider(),
  model: () => process.env.LEAKFINDER_MODEL || DEFAULT_MODEL[provider()],
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
