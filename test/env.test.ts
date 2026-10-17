import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceOf } from "../src/env.js";

test("credentials resolve under the names stripe projects may write", () => {
  assert.equal(sourceOf("DATABASE_URL", { DATABASE_URL: "postgres://a", NEON_DATABASE_URL: "postgres://b" }), "DATABASE_URL");
  assert.equal(sourceOf("DATABASE_URL", { LEAKFINDER_DB_DATABASE_URL: "postgres://b" }), "LEAKFINDER_DB_DATABASE_URL");
  assert.equal(sourceOf("DATABASE_URL", { A_DATABASE_URL: "x", B_DATABASE_URL: "y" }), null, "two prefixed candidates is ambiguous");
  assert.equal(sourceOf("CREATEOS_SANDBOX_API_KEY", { CREATEOS_API_KEY: "k" }), "CREATEOS_API_KEY");
  assert.equal(sourceOf("STRIPE_SECRET_KEY", {}), null);
  assert.equal(sourceOf("DATABASE_URL", { DATABASE_URL: "" }), null, "empty values do not count");
});
