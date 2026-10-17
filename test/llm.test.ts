/**
 * The guard, the code-block parser, the summary parser and the Coder's request
 * shape. All offline: the Anthropic call is a scripted function.
 */
process.env.DOTENV_CONFIG_PATH = "/nonexistent/leakfinder-test.env"; // tests never read a real .env

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

const { guard, pythonBlock, intentLine, Transcript, Coder, EMAIL_MARK, CLIENT_OPTIONS } = await import("../src/llm.js");
const { parseSummary } = await import("../src/types.js");

const tmp = () => mkdtempSync(join(tmpdir(), "leakfinder-llm-"));

test("guard redacts emails, counts them, and catches the %40 form", () => {
  const g = guard("a priya.kapoor3@leakfinder.test b MEI.CHEN@Example.COM c lukas%40weber.io");
  assert.equal(g.report.emailsRedacted, 3);
  assert.ok(!/leakfinder\.test|Example\.COM|weber\.io/.test(g.text));
  assert.equal(g.text.split(EMAIL_MARK).length - 1, 3);
  assert.equal(g.report.truncatedChars, 0);
});

test("guard caps output with a visible marker and keeps head and tail", () => {
  const text = "HEAD" + "x".repeat(20_000) + "Traceback tail: KeyError: 'plan'";
  const g = guard(text, 1000);
  assert.ok(g.text.length < 1100);
  assert.match(g.text, /\[truncated \d+ chars\]/);
  assert.equal(g.report.truncatedChars, text.length - 1000);
  assert.ok(g.text.startsWith("HEAD"));
  assert.ok(g.text.endsWith("KeyError: 'plan'"));
});

test("guard redacts before it cuts, so a cut cannot leave half an email", () => {
  const email = "zara.lopez99@leakfinder.test";
  for (let pad = 560; pad < 620; pad++) {
    const g = guard("y".repeat(pad) + email + "z".repeat(2000), 1000);
    assert.ok(!g.text.includes("@leakfinder"), `pad ${pad}`);
    assert.ok(!g.text.includes("zara.lopez99@"), `pad ${pad}`);
  }
});

test("pythonBlock accepts python, py and bare fences; first python block wins", () => {
  assert.equal(pythonBlock("Plan.\n```python\nprint(1)\n```"), "print(1)\n");
  assert.equal(pythonBlock("```py\nimport os\n```"), "import os\n");
  assert.equal(pythonBlock("```\nimport stripe\nprint(2)\n```"), "import stripe\nprint(2)\n");
  assert.equal(pythonBlock("```sql\nselect 1;\n```\nthen\n```python\nprint('a')\n```\n```python\nprint('b')\n```"), "print('a')\n");
  assert.equal(pythonBlock("```json\n{\"a\": 1}\n```"), null);
  assert.equal(pythonBlock("```\n{\"a\": 1}\n```"), null, "a bare block that is not Python does not count");
  assert.equal(pythonBlock("no code here"), null);
  assert.equal(pythonBlock("```python\nprint('cut off at max_tok"), null, "an unclosed fence never runs");
  assert.equal(pythonBlock("```python\n\n```"), null);
});

test("intentLine is the first sentence outside the code, guarded and short", () => {
  const reply = "Discover the schema for mei.chen1@leakfinder.test's tenant. Then more.\n```python\nprint(1)\n```";
  const line = intentLine(reply);
  assert.ok(line.startsWith("Discover the schema"));
  assert.ok(!line.includes("@"));
  assert.ok(!line.includes("Then more"));
  assert.ok(intentLine("x".repeat(500)).length <= 140);
});

test("parseSummary reads the last marker line and coerces every field", () => {
  const out = [
    "would revoke 12",
    'LEAKFINDER_SUMMARY {"mode": "dry_run", "revoked": 1}',
    'LEAKFINDER_SUMMARY {"mode": "applied", "revoked": "12", "invoices": 12, "invoiced_cents": 34800, "refunds": 3, "refunded_cents": 8700, "cancelled": 3, "rows_synced": 5, "leak_closed_cents": 34800}',
  ].join("\n");
  assert.deepEqual(parseSummary(out), {
    mode: "applied",
    revoked: 12,
    invoices: 12,
    invoiced_cents: 34800,
    refunds: 3,
    refunded_cents: 8700,
    cancelled: 3,
    rows_synced: 5,
    leak_closed_cents: 34800,
  });
  assert.equal(parseSummary("no summary"), null);
  assert.equal(parseSummary("LEAKFINDER_SUMMARY {not json"), null);
  assert.equal(parseSummary('LEAKFINDER_SUMMARY {"mode": "weird"}')?.mode, "dry_run");
});

test("Transcript redacts every string it writes, however deep", () => {
  const t = new Transcript(tmp());
  t.log({ kind: "x", text: "hi omar.farouk7@leakfinder.test", nested: { list: ["ivy.iyer8@leakfinder.test"] } });
  const raw = readFileSync(t.path, "utf8");
  assert.ok(!raw.includes("@leakfinder.test"));
  assert.equal(raw.split(EMAIL_MARK).length - 1, 2);
});

type Params = Anthropic.Beta.MessageCreateParamsNonStreaming;
const reply = (text: string, extra: Partial<Anthropic.Beta.BetaMessage> = {}) => ({
  content: [{ type: "text", text, citations: null } as Anthropic.Beta.BetaTextBlock],
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } as Anthropic.Beta.BetaUsage,
  stop_reason: "end_turn" as const,
  stop_details: null,
  ...extra,
});

test("Coder caches the system prompt and the newest turn, guards input, counts tokens", async () => {
  const seen: Params[] = [];
  const t = new Transcript(tmp());
  const c = new Coder("SYSTEM PROMPT", t, {
    model: "test-model",
    create: async (p) => {
      seen.push(structuredClone(p));
      return reply("Checking.\n```python\nprint(1)\n```");
    },
  });
  await c.ask("turn one, output has hana.kim5@leakfinder.test");
  await c.ask("turn two");
  const p = seen[1];
  assert.deepEqual(p.system, [{ type: "text", text: "SYSTEM PROMPT", cache_control: { type: "ephemeral" } }]);
  assert.deepEqual(p.cache_control, { type: "ephemeral" });
  assert.equal(p.betas, undefined, "no fallback beta for a model that does not take it");
  assert.equal(p.messages.length, 3);
  assert.ok(!JSON.stringify(seen).includes("@leakfinder.test"), "the model never receives a raw email");
  assert.equal(t.inputTokens, 2 * 130);
  assert.equal(t.outputTokens, 10);
  assert.equal(t.cacheReadTokens, 200);
  const lines = readFileSync(t.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.kind), ["system", "model_input", "model_output", "model_input", "model_output"]);
  assert.ok(!readFileSync(t.path, "utf8").includes("@leakfinder.test"));
});

test("Coder asks for server-side fallbacks on models that take them, and drops them if rejected", async () => {
  const seen: Params[] = [];
  const c = new Coder("S", new Transcript(tmp()), {
    model: "claude-sonnet-5-5",
    create: async (p) => {
      seen.push(p);
      if (p.fallbacks) {
        const body = { type: "error", error: { type: "invalid_request_error", message: "fallbacks: not enabled for this organization" } };
        throw new Anthropic.BadRequestError(400, body, undefined, new Headers());
      }
      return reply("ok");
    },
  });
  assert.equal(await c.ask("hi"), "ok");
  assert.equal(seen[0].fallbacks, "default");
  assert.deepEqual(seen[0].betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(seen[1].fallbacks, undefined);
  await c.ask("again");
  assert.equal(seen.length, 3, "once rejected, fallbacks stay off");
});

test("the client retries and times out instead of hanging the demo", () => {
  assert.ok(CLIENT_OPTIONS.maxRetries >= 3);
  assert.ok(CLIENT_OPTIONS.timeout > 60_000 && CLIENT_OPTIONS.timeout <= 600_000);
});

test("Coder turns a refusal into a clear error instead of an empty script", async () => {
  const c = new Coder("S", new Transcript(tmp()), {
    model: "test-model",
    create: async () =>
      reply("", { stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } as any }),
  });
  await assert.rejects(c.ask("hi"), /declined.*cyber/);
});
