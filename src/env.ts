import "dotenv/config";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env (see .env.example)`);
  return v;
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
