/**
 * The model writes code. Everything it is shown passes through `guard`, and
 * every byte it is shown is appended to the run's transcript so the privacy
 * claim can be checked with grep.
 */
import Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { env } from "./env.js";

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export interface GuardReport {
  emailsRedacted: number;
}

/** Strip anything that looks like a person before it can reach the model. */
export function guard(text: string): { text: string; report: GuardReport } {
  let emailsRedacted = 0;
  const out = text.replace(EMAIL, () => {
    emailsRedacted++;
    return "[email redacted by leakfinder]";
  });
  return { text: out, report: { emailsRedacted } };
}

export type Msg = { role: "user" | "assistant"; content: string };

export class Transcript {
  readonly path: string;
  inputTokens = 0;
  outputTokens = 0;

  constructor(runDir: string) {
    mkdirSync(runDir, { recursive: true });
    this.path = join(runDir, "transcript.jsonl");
  }

  log(entry: Record<string, unknown>) {
    appendFileSync(this.path, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
  }
}

export class Coder {
  private client = new Anthropic({ apiKey: env.anthropicKey() });
  private history: Msg[] = [];

  constructor(private system: string, private transcript: Transcript) {
    transcript.log({ kind: "system", text: system });
  }

  async ask(user: string): Promise<string> {
    this.history.push({ role: "user", content: user });
    this.transcript.log({ kind: "model_input", text: user });
    const res = await this.client.messages.create({
      model: env.model(),
      max_tokens: 6000,
      system: this.system,
      messages: this.history,
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    this.transcript.inputTokens += res.usage.input_tokens;
    this.transcript.outputTokens += res.usage.output_tokens;
    this.transcript.log({ kind: "model_output", text, usage: res.usage });
    this.history.push({ role: "assistant", content: text });
    return text;
  }
}

/** The first ```python block in a reply, or null. */
export function pythonBlock(reply: string): string | null {
  const m = reply.match(/```python\s*\n([\s\S]*?)```/);
  return m ? m[1] : null;
}
