/**
 * The sealed room. One CreateOS micro-VM whose outbound traffic is limited to
 * api.stripe.com and the Postgres host. The model's code runs here; the model
 * itself never does.
 */
import { createClient, type Sandbox } from "@nodeops-createos/sandbox";
import { env, databaseHost } from "./env.js";

export const WORKDIR = "/workspace";
const DNS = "1.1.1.1:53";
const INSTALL_HOSTS = ["pypi.org", "files.pythonhosted.org"];

export function sealedEgress(): string[] {
  return ["api.stripe.com", databaseHost(), DNS];
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  ms: number;
}

export class SealedRoom {
  private constructor(public readonly box: Sandbox) {}

  static client() {
    return createClient({ apiKey: env.createosKey() });
  }

  /**
   * Create the sandbox with the data credentials declared as envs (the API
   * never returns their values), install the two Python libraries the agent
   * may use, then tighten egress to the two data hosts only.
   */
  static async open(opts: { name?: string; ingress?: boolean } = {}): Promise<SealedRoom> {
    const client = SealedRoom.client();
    const box = await client.createSandbox({
      shape: "s-1vcpu-1gb",
      rootfs: "devbox:1",
      name: opts.name ?? `leakfinder-${Date.now().toString(36)}`,
      envs: {
        STRIPE_SECRET_KEY: env.stripeKey(),
        DATABASE_URL: env.databaseUrl(),
      },
      egress: [...sealedEgress(), ...INSTALL_HOSTS],
      ingress_enabled: opts.ingress ?? false,
    });
    await box.waitUntilRunning();
    const room = new SealedRoom(box);
    await room.exec(`mkdir -p ${WORKDIR}`);
    await room.ensureLibraries();
    await room.box.setEgress(sealedEgress());
    return room;
  }

  static async attach(id: string): Promise<SealedRoom> {
    const box = await SealedRoom.client().getSandbox(id);
    return new SealedRoom(box);
  }

  get id() {
    return this.box.id;
  }

  async exec(shell: string, timeoutMs = 120_000): Promise<RunResult> {
    const r = await this.box.runCommand("bash", ["-lc", shell], { timeoutMs } as any);
    return {
      stdout: r.result.stdout ?? "",
      stderr: r.result.stderr ?? (r.result.error ? `agent error: ${r.result.error}` : ""),
      exit_code: r.result.exit_code,
      ms: r.exec_ms,
    };
  }

  async runPython(path: string, extraEnv: Record<string, string> = {}, timeoutMs = 180_000): Promise<RunResult> {
    const exports = Object.entries(extraEnv)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");
    return this.exec(`cd ${WORKDIR} && ${exports} python3 ${path}`, timeoutMs);
  }

  async upload(path: string, content: string) {
    await this.box.files.upload(path, content);
  }

  async download(path: string): Promise<string> {
    return new TextDecoder().decode(await this.box.files.download(path));
  }

  /** pip only runs while the install hosts are still allowed. */
  private async ensureLibraries() {
    const probe = await this.exec(`python3 -c "import stripe, psycopg; print('ok')"`);
    if (probe.stdout.includes("ok")) return;
    const r = await this.exec(`python3 -m pip install -q stripe "psycopg[binary]" 2>&1 | tail -2`, 240_000);
    if (r.exit_code !== 0) throw new Error(`pip install failed: ${r.stdout}\n${r.stderr}`);
  }

  /** Proof the room is sealed: a host outside the allowlist must fail fast. */
  async sealCheck(): Promise<{ sealed: boolean; detail: string }> {
    const r = await this.exec(`curl -sS -m 6 -o /dev/null -w '%{http_code}' https://example.com || echo " blocked"`, 20_000);
    const out = (r.stdout + r.stderr).trim();
    return { sealed: !/^200/.test(out), detail: out };
  }

  async pauseAndFork(): Promise<SealedRoom> {
    await this.box.pause();
    await this.box.waitUntilPaused();
    const copy = await this.box.fork({ egress: sealedEgress() });
    await copy.waitUntilRunning();
    await this.box.resume();
    await this.box.waitUntilRunning();
    return new SealedRoom(copy);
  }

  async destroy() {
    try {
      await this.box.destroy();
    } catch {
      /* already gone */
    }
  }
}
