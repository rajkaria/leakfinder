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
};

/** Hostname of the Postgres server, for the egress allowlist. */
export function databaseHost(url = env.databaseUrl()): string {
  return new URL(url).hostname;
}
