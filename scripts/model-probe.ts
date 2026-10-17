/** One tiny model call through the same client the agent uses: proves the key, the model name and the reply format. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../src/env.js";
import { Coder, Transcript, pythonBlock } from "../src/llm.js";

const t0 = Date.now();
const transcript = new Transcript(mkdtempSync(join(tmpdir(), "lf-probe-")));
const coder = new Coder("Reply with one short sentence, then exactly one ```python block.", transcript);
try {
  const reply = await coder.ask("Write a script that prints the number 42.");
  const code = pythonBlock(reply);
  console.log(`${env.provider()} · ${env.model()} · ${((Date.now() - t0) / 1000).toFixed(1)}s · ${transcript.inputTokens} in / ${transcript.outputTokens} out`);
  console.log(code ? `python block found: ${code.trim().split("\n").length} line(s)` : `no python block in reply: ${reply.slice(0, 200)}`);
  process.exit(code ? 0 : 1);
} catch (e) {
  console.log(`model call failed: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
  process.exit(1);
}
