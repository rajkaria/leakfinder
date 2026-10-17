/**
 * The model writes code. Everything it is shown passes through `guard`, and
 * every byte it is shown is appended to the run's transcript so the privacy
 * claim can be checked with grep. The transcript guards every string it
 * writes as well, so no caller can put raw data in it by accident.
 */
import Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { env } from "./env.js";

/** Also catches the URL-encoded form (`%40`) that shows up in request logs. */
const EMAIL = /[A-Z0-9._%+-]+(?:@|%40)[A-Z0-9.-]+\.[A-Z]{2,}/gi;
export const EMAIL_MARK = "[email redacted by leakfinder]";
/**
 * The room holds STRIPE_SECRET_KEY and a script that prints os.environ would
 * show it; the transcript is meant to be shared. (A DSN password already reads
 * as an email: `npg_x@ep-....neon.tech`.)
 */
const STRIPE_KEY = /\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{8,}/g;
export const KEY_MARK = "[stripe key redacted by leakfinder]";
/** Default cap on text going to the model: enough for a traceback, too small for a table dump. */
export const GUARD_MAX = 8_000;

export interface GuardReport {
  emailsRedacted: number;
  truncatedChars: number;
}

/**
 * Strip anything that looks like a person before it can reach the model, then
 * cap the length. Redaction runs first so a cut can never leave half an email
 * behind. The cap keeps the head and the tail, because errors print last.
 */
export function guard(text: string, max = GUARD_MAX): { text: string; report: GuardReport } {
  let emailsRedacted = 0;
  let out = String(text ?? "")
    .replace(STRIPE_KEY, KEY_MARK)
    .replace(EMAIL, () => {
      emailsRedacted++;
      return EMAIL_MARK;
    });
  let truncatedChars = 0;
  if (out.length > max) {
    truncatedChars = out.length - max;
    const head = Math.floor(max * 0.6);
    const tail = max - head;
    out = `${out.slice(0, head)}\n[truncated ${truncatedChars} chars]\n${out.slice(out.length - tail)}`;
  }
  return { text: out, report: { emailsRedacted, truncatedChars } };
}

/** Redact (no cap) every string inside a JSON-able value. */
function redactDeep(v: unknown): unknown {
  if (typeof v === "string") return guard(v, Number.MAX_SAFE_INTEGER).text;
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)]));
  return v;
}

export class Transcript {
  readonly path: string;
  /** All input tokens the model processed, cached or not. */
  inputTokens = 0;
  outputTokens = 0;
  cacheReadTokens = 0;
  cacheWriteTokens = 0;

  constructor(runDir: string) {
    mkdirSync(runDir, { recursive: true });
    this.path = join(runDir, "transcript.jsonl");
  }

  log(entry: Record<string, unknown>) {
    const safe = redactDeep({ t: new Date().toISOString(), ...entry });
    appendFileSync(this.path, JSON.stringify(safe) + "\n");
  }
}

/** What the agent needs from a coder; tests pass a scripted one. */
export interface CoderLike {
  ask(user: string): Promise<string>;
}

/** The one SDK call Coder makes, injectable so the loop can be tested offline. */
export type CreateMessage = (
  params: Anthropic.Beta.MessageCreateParamsNonStreaming,
) => Promise<Pick<Anthropic.Beta.BetaMessage, "content" | "usage" | "stop_reason" | "stop_details">>;

/** Models that accept server-side refusal fallbacks (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** 429, 529 and other 5xx retry with backoff instead of killing a live run; a stuck reply times out at 5 minutes and is retried. */
export const CLIENT_OPTIONS = { maxRetries: 4, timeout: 300_000 } as const;

let shared: Anthropic | null = null;
function client(): Anthropic {
  shared ??= new Anthropic({ apiKey: env.anthropicKey(), ...CLIENT_OPTIONS });
  return shared;
}

/**
 * DeepSeek speaks the OpenAI chat-completions protocol. This adapter takes the
 * Anthropic-shaped request Coder builds and returns an Anthropic-shaped reply,
 * so the loop, the guard and the transcript are the same for either provider.
 * Retries 429 and 5xx with backoff, like the Anthropic client does.
 */
export const deepseekCreate: CreateMessage = async (params) => {
  const text = (c: unknown): string =>
    typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => (b?.type === "text" ? b.text : "")).join("\n") : "";
  const body = {
    model: params.model,
    messages: [
      { role: "system", content: text(params.system) },
      ...params.messages.map((m) => ({ role: m.role, content: text(m.content) })),
    ],
    max_tokens: Math.min(params.max_tokens, 8_192),
    temperature: 0,
    stream: false,
    // Reasoning tokens count against max_tokens and never reach `content`; see env.deepseekThinking.
    thinking: { type: env.deepseekThinking() ? "enabled" : "disabled" },
  };
  let last: unknown = null;
  for (let attempt = 0; attempt <= CLIENT_OPTIONS.maxRetries; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, Math.min(16_000, 1_000 * 2 ** attempt)));
    let res: Response;
    try {
      res = await fetch(`${env.deepseekBaseUrl()}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.deepseekKey()}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CLIENT_OPTIONS.timeout),
      });
    } catch (e) {
      last = e;
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      last = new Error(`DeepSeek ${res.status}`);
      continue;
    }
    const json: any = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${String(json?.error?.message ?? "request failed").slice(0, 300)}`);
    const choice = json?.choices?.[0];
    const u = json?.usage ?? {};
    const hit = Number(u.prompt_cache_hit_tokens ?? 0);
    const finish = choice?.finish_reason;
    return {
      content: [{ type: "text", text: String(choice?.message?.content ?? ""), citations: null }],
      stop_reason: finish === "length" ? "max_tokens" : finish === "content_filter" ? "refusal" : "end_turn",
      stop_details: null,
      usage: {
        input_tokens: Math.max(0, Number(u.prompt_tokens ?? 0) - hit),
        cache_read_input_tokens: hit,
        cache_creation_input_tokens: 0,
        output_tokens: Number(u.completion_tokens ?? 0),
      },
    } as unknown as Awaited<ReturnType<CreateMessage>>;
  }
  throw last instanceof Error ? last : new Error("DeepSeek request failed");
};

export class Coder implements CoderLike {
  private history: Anthropic.Beta.BetaMessageParam[] = [];
  private readonly model: string;
  private readonly create: CreateMessage;
  private fallbacks: boolean;

  constructor(
    private readonly system: string,
    private readonly transcript: Transcript,
    opts: { create?: CreateMessage; model?: string } = {},
  ) {
    this.model = opts.model ?? env.model();
    const deepseek = !opts.create && env.provider() === "deepseek";
    this.create = opts.create ?? (deepseek ? deepseekCreate : (p) => client().beta.messages.create(p));
    this.fallbacks = !deepseek && FALLBACK_MODELS.has(this.model);
    transcript.log({ kind: "system", text: system });
  }

  async ask(user: string): Promise<string> {
    // Guard here too: whatever the caller built, the model and the transcript get the same guarded text.
    const shown = guard(user, GUARD_MAX * 3).text;
    this.history.push({ role: "user", content: shown });
    this.transcript.log({ kind: "model_input", text: shown });
    const res = await this.send();
    if (res.stop_reason === "refusal") {
      const why = res.stop_details?.category ?? "no category";
      this.transcript.log({ kind: "model_refusal", category: why });
      throw new Error(`the model declined this turn (refusal: ${why})`);
    }
    const raw = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const u = res.usage;
    this.transcript.inputTokens += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    this.transcript.outputTokens += u.output_tokens ?? 0;
    this.transcript.cacheReadTokens += u.cache_read_input_tokens ?? 0;
    this.transcript.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
    // The history holds what the transcript holds, so "every byte the model saw" stays literal.
    const kept = guard(raw, Number.MAX_SAFE_INTEGER).text;
    this.transcript.log({
      kind: "model_output",
      text: kept,
      stop_reason: res.stop_reason,
      usage: {
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        cache_read_input_tokens: u.cache_read_input_tokens,
        cache_creation_input_tokens: u.cache_creation_input_tokens,
      },
    });
    this.history.push({ role: "assistant", content: kept || "(empty reply)" });
    return raw;
  }

  /**
   * One explicit cache breakpoint on the frozen system prompt, plus automatic
   * caching that keeps the breakpoint on the newest user turn as history grows.
   */
  private async send() {
    const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: 16_000,
      system: [{ type: "text", text: this.system, cache_control: { type: "ephemeral" } }],
      cache_control: { type: "ephemeral" },
      messages: this.history,
    };
    const effort = env.effort();
    if (effort && env.provider() === "anthropic") params.output_config = { effort };
    if (!this.fallbacks) return this.create(params);
    try {
      return await this.create({ ...params, betas: [FALLBACK_BETA], fallbacks: "default" });
    } catch (e) {
      // If this account or model rejects the beta, run without it rather than stop the demo.
      if (e instanceof Anthropic.BadRequestError && /fallback/i.test(`${e.message} ${JSON.stringify(e.error ?? "")}`)) {
        this.fallbacks = false;
        return this.create(params);
      }
      throw e;
    }
  }
}

const FENCE = /```[ \t]*([A-Za-z0-9_+-]*)[^\n]*\n([\s\S]*?)```/g;
const PY_HINT = /^\s*(import |from \S+ import |def |class |print\(|with |for |if |try:|[A-Za-z_]\w*\s*=)/m;

/**
 * The first runnable Python block in a reply, or null. Accepts ```python,
 * ```py and bare fences; a bare block counts only if it looks like Python.
 * An unclosed fence (a reply cut off at max_tokens) never counts.
 */
export function pythonBlock(reply: string): string | null {
  for (const m of String(reply ?? "").matchAll(FENCE)) {
    const lang = m[1].toLowerCase();
    const body = m[2];
    if (!body.trim()) continue;
    if (lang === "python" || lang === "py" || lang === "python3") return body;
    if (lang === "" && PY_HINT.test(body)) return body;
  }
  return null;
}

/** The one-sentence intent the model wrote outside its code block, guarded and trimmed for the terminal. */
export function intentLine(reply: string, max = 140): string {
  const prose = String(reply ?? "")
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const first = prose.match(/^.*?[.!?](\s|$)/)?.[0]?.trim() ?? prose;
  const g = guard(first, Number.MAX_SAFE_INTEGER).text;
  return g.length > max ? `${g.slice(0, max - 1)}…` : g;
}
