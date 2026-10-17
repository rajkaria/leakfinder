/**
 * The sealed room. One CreateOS micro-VM whose outbound traffic is limited to
 * api.stripe.com and the Postgres server. The model's code runs here; the
 * model itself never does.
 *
 * Egress facts this file is built on (CreateOS docs, Sandbox > Egress):
 * - a non-empty allowlist is deny-by-default, enforced on the host outside the VM;
 * - a hostname rule only opens TCP 80 and 443, so Postgres on 5432 needs an
 *   `ip:port` rule: we resolve the DB host and allow each address on its port;
 * - IP rules apply at once, hostname rules take about 30 s to propagate, so
 *   the Stripe side of `sealCheck` polls instead of trusting one probe.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import {
  createClient,
  CreateosSandboxApiError,
  CreateosSandboxNotFoundError,
  CreateosSandboxPaymentRequiredError,
  CreateosSandboxPermissionError,
  CreateosSandboxRateLimitError,
  type CreateosSandboxClient,
  type Sandbox,
} from "@nodeops-createos/sandbox";
import { env, databaseHost } from "./env.js";

export const WORKDIR = "/workspace";
/** In-guest port of vm/server.py. Ingress routes any port as <id>-<port>.<domain>. */
export const REPORT_PORT = 8080;
export const FORK_NEEDS_PLAN =
  "fork needs the Beginner plan (5 concurrent sandboxes): stripe projects add createos/beginner-monthly";

const STRIPE_HOST = "api.stripe.com";
const STRIPE_PROBE = "https://api.stripe.com/v1/charges";
const BLOCKED_PROBE = "https://example.com";
/** PyPI must be shut too: the libraries come in as wheels from this machine, never over the VM's network. */
const PYPI_PROBE = "https://pypi.org/simple/";
const FALLBACK_DNS = "1.1.1.1";
/** Hostname rules take ~30 s to propagate; leave headroom over that. */
const SEAL_BUDGET_MS = 40_000;
const HOME = `${WORKDIR}/.leakfinder`;
const SERVER_SRC = new URL("../vm/server.py", import.meta.url);

export interface RunResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  ms: number;
}

export interface SealCheck {
  /** A host outside the allowlist got no HTTP answer. */
  sealed: boolean;
  /** One line for the demo, e.g. `example.com → blocked in 3.0s · api.stripe.com → 401`. */
  detail: string;
  /** api.stripe.com answered with any HTTP status (401 without a key counts). */
  stripeReachable: boolean;
}

let lastRules: string[] | null = null;

/**
 * The allowlist in force on the most recently opened or attached room. Before
 * any room exists it describes the plan (the DB as host:port), since the DB
 * addresses are only resolved when a room opens. Prefer `room.egress` for the report.
 */
export function sealedEgress(): string[] {
  if (lastRules) return [...lastRules];
  const db = dbTarget();
  return [STRIPE_HOST, `${db.host}:${db.port}`];
}

function dbTarget(): { host: string; port: number } {
  return { host: databaseHost(), port: Number(new URL(env.databaseUrl()).port) || 5432 };
}

const uniq = (xs: string[]) => [...new Set(xs)];
/** The API may echo a hostname rule back with a port. */
const isStripeRule = (r: string) => r === STRIPE_HOST || r.startsWith(`${STRIPE_HOST}:`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Single-quote for bash, so `$` and backticks in values stay literal. */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

async function resolveV4(host: string): Promise<string[]> {
  if (isIP(host) === 4) return [host];
  const found: string[] = [];
  try {
    found.push(...(await dns.resolve4(host)));
  } catch {
    /* fall through to the OS resolver */
  }
  try {
    found.push(...(await dns.lookup(host, { all: true, family: 4 })).map((a) => a.address));
  } catch {
    /* unresolvable here; the VM may still resolve it */
  }
  return uniq(found).sort();
}

function buildRules(p: { dbIps: string[]; dbPort: number; dnsIps: string[]; stripeIps?: string[] }): string[] {
  const stripe = p.stripeIps?.length ? p.stripeIps.map((ip) => `${ip}:443`) : [STRIPE_HOST];
  return uniq([...stripe, ...p.dbIps.map((ip) => `${ip}:${p.dbPort}`), ...p.dnsIps.map((ip) => `${ip}:53`)]);
}

/** Resolver addresses, the DB host's IPv4s as the VM sees them, whether the two libraries import, and the wheel target. */
const PROBE_PY = `
import json, platform, re, socket, sys
def ns(p):
    try:
        with open(p) as f:
            return [s for s in re.findall(r"^\\s*nameserver\\s+([0-9.]+)\\s*$", f.read(), re.M) if not s.startswith("127.")]
    except OSError:
        return []
servers = ns("/etc/resolv.conf") or ns("/run/systemd/resolve/resolv.conf")
try:
    ips = sorted({a[4][0] for a in socket.getaddrinfo(sys.argv[1], None, socket.AF_INET)})
except OSError:
    ips = []
try:
    import stripe, psycopg
    # The prompts use InvoicePayment (stripe-python 12+, API 2025-03-31.basil); an older preinstalled stripe pins an
    # API where current_period_end and refunds work differently, so it counts as missing and gets upgraded.
    libs = hasattr(stripe, "InvoicePayment")
except Exception:
    libs = False
print(json.dumps({"resolvers": servers, "db_ips": ips, "libs": libs, "python": sys.version.split()[0], "machine": platform.machine()}))
`;

/** One HTTPS GET from inside the VM. Python, not curl: python3 is the one tool we know is there. */
const HTTP_PROBE_PY = `
import sys, time, urllib.request, urllib.error
url, t = sys.argv[1], float(sys.argv[2])
t0 = time.time()
try:
    code = urllib.request.urlopen(url, timeout=t).status
except urllib.error.HTTPError as e:
    code = e.code
except Exception:
    code = 0
print("PROBE %d %.2f" % (code, time.time() - t0))
`;

const RESOLVE_PY = `
import socket, sys
ips = set()
for h in sys.argv[1:]:
    try:
        ips.update(a[4][0] for a in socket.getaddrinfo(h, 443, socket.AF_INET))
    except OSError:
        pass
print(" ".join(sorted(ips)))
`;

interface Probe {
  /** HTTP status, 0 when no HTTP answer came back. */
  code: number;
  secs: number;
  /** False when the probe itself did not run, so its 0 proves nothing. */
  ran: boolean;
}

export class SealedRoom {
  private static cached: CreateosSandboxClient | null = null;
  private stripePinned = false;

  private constructor(
    public readonly box: Sandbox,
    private rules: string[],
  ) {
    lastRules = rules;
  }

  static client(): CreateosSandboxClient {
    SealedRoom.cached ??= createClient({ apiKey: env.createosKey() });
    return SealedRoom.cached;
  }

  /**
   * Create the sandbox with the data credentials declared as envs (the API
   * never returns their values) and an allowlist in force before the first
   * command. PyPI is allowed only until the libraries are confirmed present,
   * then egress is tightened to Stripe, the DB addresses and DNS.
   */
  static async open(opts: { name?: string; ingress?: boolean } = {}): Promise<SealedRoom> {
    const db = dbTarget();
    const localDbIps = await resolveV4(db.host);
    const initial = buildRules({ dbIps: localDbIps, dbPort: db.port, dnsIps: [FALLBACK_DNS] });
    let box: Sandbox;
    try {
      box = await SealedRoom.client().createSandbox(
        {
          shape: "s-1vcpu-1gb",
          rootfs: "devbox:1",
          // The API caps names at 22 characters.
          name: (opts.name ?? `leakfinder-${Date.now().toString(36)}`).slice(0, 22),
          envs: {
            STRIPE_SECRET_KEY: env.stripeKey(),
            DATABASE_URL: env.databaseUrl(),
            // libpq and psycopg default to a ~2 minute connect wait per address; a blocked address should fail a turn fast.
            PGCONNECT_TIMEOUT: "15",
          },
          // The final shape from the first packet. A host the VM has already talked to stays reachable after
          // setEgress tightens the list (seen live with PyPI), so nothing is allowed now that is cut later.
          egress: initial,
          ingress_enabled: opts.ingress ?? false,
        },
        { timeoutMs: 180_000 },
      );
    } catch (e) {
      throw await explainCreate(e);
    }
    const room = new SealedRoom(box, initial);
    try {
      await room.exec(`mkdir -p ${HOME}`);
      const probe = await room.probeEnv(db.host);
      const dbIps = uniq([...localDbIps, ...probe.db_ips]).sort();
      if (!dbIps.length) throw new Error(`cannot resolve ${db.host} to an IPv4 address; the Postgres rule needs one`);
      const sealed = buildRules({
        dbIps,
        dbPort: db.port,
        dnsIps: probe.resolvers.length ? probe.resolvers : [FALLBACK_DNS],
      });
      if (!probe.libs) await room.installLibraries(probe.python, probe.machine);
      await room.applyRules(sealed);
      return room;
    } catch (e) {
      const gone = await room.destroy().then(
        () => true,
        () => false,
      );
      // Free allows one sandbox: if it could not be destroyed, the next run needs its id.
      if (!gone && e instanceof Error) e.message += ` (sandbox ${room.id} may still be running: destroy it before the next run)`;
      throw e;
    }
  }

  /**
   * Destroy a sandbox from an earlier command by id and wait until it stops
   * counting against the plan's cap. False when it was already gone.
   */
  static async retire(id: string): Promise<boolean> {
    try {
      const box = await SealedRoom.client().getSandbox(id);
      if (box.status === "destroyed" || box.status === "failed") return false;
      // A second destroy on a `destroying` row can be refused; it still holds the slot until it reaches destroyed.
      if (box.status !== "destroying") await box.destroy();
      await box.waitUntilDestroyed({ timeoutMs: 30_000 }).catch(() => {});
      return true;
    } catch (e) {
      if (e instanceof CreateosSandboxNotFoundError) return false;
      throw e;
    }
  }

  /** Reconnect to a room from an earlier command; wakes it if it auto-paused. */
  static async attach(id: string): Promise<SealedRoom> {
    let box: Sandbox;
    try {
      box = await SealedRoom.client().getSandbox(id);
    } catch (e) {
      if (e instanceof CreateosSandboxNotFoundError) throw new Error(`sandbox ${id} no longer exists: run pnpm scan again`);
      throw e;
    }
    if (["destroying", "destroyed", "failed"].includes(box.status)) {
      throw new Error(`sandbox ${id} is ${box.status}: run pnpm scan again`);
    }
    if (box.status === "pausing") await box.waitUntilPaused({ timeoutMs: 180_000 });
    if (box.status === "paused") {
      // Opening the report link can wake it between our GET and this POST; that resume is as good as ours.
      await box.resume().catch(async (e) => {
        await box.refresh();
        if (box.status !== "resuming" && box.status !== "running") throw e;
      });
    }
    if (box.status !== "running") await box.waitUntilRunning({ timeoutMs: 180_000 });
    const { egress } = await box.getEgress();
    if (!egress.length) throw new Error(`sandbox ${id} has open egress; refusing to treat it as a sealed room`);
    const room = new SealedRoom(box, egress);
    room.stripePinned = !egress.some(isStripeRule);
    // Always, not only when this call resumed it: auto-pause plus a wake from the report link (or any resume) can land
    // on a fresh host where the Stripe hostname rule propagates again, and fix.py must not start into that window.
    // One probe (~1 s) when Stripe already answers.
    await room.waitForStripe();
    return room;
  }

  get id(): string {
    return this.box.id;
  }

  /** The allowlist as the API echoed it back. */
  get egress(): string[] {
    return [...this.rules];
  }

  /**
   * Run a bash script in the VM. GNU timeout kills it in the guest when the
   * budget runs out, so a runaway agent script cannot outlive its turn.
   */
  async exec(shell: string, timeoutMs = 120_000): Promise<RunResult> {
    const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
    const r = await this.box.runCommand("timeout", ["-k", "5", String(secs), "bash", "-lc", shell], {
      timeoutMs: timeoutMs + 15_000,
    });
    const stderr = [
      r.result.stderr ?? "",
      r.result.error ? `sandbox agent error: ${r.result.error}` : "",
      r.result.exit_code === 124 ? `timed out after ${secs}s` : "",
    ].filter(Boolean);
    return {
      stdout: r.result.stdout ?? "",
      stderr: stderr.join("\n"),
      exit_code: r.result.exit_code,
      ms: r.exec_ms,
    };
  }

  /** Run a Python file from WORKDIR. extraEnv is set for this process only (e.g. APPLY=1). */
  async runPython(path: string, extraEnv: Record<string, string> = {}, timeoutMs = 180_000): Promise<RunResult> {
    const assigns = Object.entries(extraEnv).map(([k, v]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`bad env name: ${k}`);
      return `${k}=${shq(v)}`;
    });
    const prefix = assigns.length ? `env ${assigns.join(" ")} ` : "";
    return this.exec(`cd ${WORKDIR} && ${prefix}python3 ${shq(path)}`, timeoutMs);
  }

  async upload(path: string, content: string): Promise<void> {
    await this.box.files.upload(path, content);
  }

  async download(path: string): Promise<string> {
    return new TextDecoder().decode(await this.box.files.download(path));
  }

  /**
   * Prove both sides of the seal: example.com gets no HTTP answer and
   * api.stripe.com answers (401 without a key). Polls the Stripe side while
   * hostname rules propagate. If Stripe never answers, or example.com does,
   * pins Stripe by IP (IP rules apply at once and do not depend on hostname
   * matching) and checks again.
   */
  async sealCheck(): Promise<SealCheck> {
    let check = await this.probeSeal(SEAL_BUDGET_MS);
    if ((check.sealed && check.stripeReachable) || this.stripePinned) return check;
    if (await this.pinStripe()) {
      check = await this.probeSeal(15_000);
      check.detail += " · Stripe pinned by IP";
    }
    return check;
  }

  /**
   * Snapshot this room and clone it, so a fix can dry-run against the exact
   * state the audit saw. Fork needs the source paused, and the paused source
   * still counts against the concurrent cap, so it fails on Free (1 concurrent).
   * The original is always resumed before this returns or throws.
   */
  async pauseAndFork(): Promise<SealedRoom> {
    let copy: Sandbox | undefined;
    try {
      await this.box.refresh();
      if (this.box.status === "running") await this.box.pause();
      await this.box.waitUntilPaused({ timeoutMs: 180_000 });
      // No retries: the SDK retries 429 by default, which only delays the inevitable on Free.
      copy = await this.box.fork({ egress: this.rules, ingress_enabled: false }, { retry: false, timeoutMs: 120_000 });
      await copy.waitUntilRunning({ timeoutMs: 180_000 });
    } catch (e) {
      if (copy) await copy.destroy().catch(() => {});
      await this.resumeOriginal();
      // The caller falls back to this room at once; a resume can land on a fresh host where the Stripe rule propagates again.
      await this.waitForStripe();
      if (isCapError(e)) throw new Error(FORK_NEEDS_PLAN);
      throw e;
    }
    await this.resumeOriginal();
    const fork = new SealedRoom(copy, this.rules);
    fork.stripePinned = this.stripePinned;
    lastRules = this.rules;
    // Resume and fork can land on a fresh host, where hostname rules propagate again.
    await Promise.all([fork.waitForStripe(), this.waitForStripe()]);
    return fork;
  }

  /**
   * Put report.html and vm/server.py in the VM, start the server detached and
   * return its public URL (without the ?k= token). The server checks the token
   * itself; ingress only routes.
   */
  async serveReport(opts: { html: string; token: string }): Promise<{ url: string }> {
    if (!/^[A-Za-z0-9_-]{16,}$/.test(opts.token)) throw new Error("serveReport: token must be 16+ base64url chars");
    await this.ensureIngress();
    await this.exec(`mkdir -p ${HOME}`);
    await this.upload(`${WORKDIR}/report.html`, opts.html);
    await this.upload(`${HOME}/server.py`, readFileSync(SERVER_SRC, "utf8"));
    await this.upload(`${HOME}/token`, opts.token);
    // nohup + setsid + redirected stdio is the docs' recipe for a server that outlives the exec.
    const start = `
set -u
chmod 600 ${HOME}/token
if [ -f ${HOME}/server.pid ]; then
  old=$(cat ${HOME}/server.pid); kill "$old" 2>/dev/null
  for i in $(seq 1 30); do kill -0 "$old" 2>/dev/null || break; sleep 0.1; done
fi
cd ${WORKDIR}
LEAKFINDER_TOKEN="$(cat ${HOME}/token)" LEAKFINDER_WORKDIR=${WORKDIR} LEAKFINDER_PORT=${REPORT_PORT} \\
  nohup setsid python3 ${HOME}/server.py >${HOME}/server.log 2>&1 </dev/null &
echo $! > ${HOME}/server.pid
python3 - <<'PY' && exit 0
import sys, time, urllib.request as u
tok = open("${HOME}/token").read().strip()
req = u.Request("http://127.0.0.1:${REPORT_PORT}/status.json", headers={"X-LeakFinder-Token": tok})
for _ in range(75):
    try:
        if u.urlopen(req, timeout=2).status == 200:
            print("ready")
            sys.exit(0)
    except Exception:
        pass
    time.sleep(0.2)
sys.exit(1)
PY
echo "report server did not answer on 127.0.0.1:${REPORT_PORT}"; tail -n 20 ${HOME}/server.log; exit 1
`;
    const r = await this.exec(start, 45_000);
    if (r.exit_code !== 0) throw new Error(`report server did not start: ${(r.stdout + r.stderr).trim().slice(-600)}`);
    return { url: await this.publicUrl(opts.token) };
  }

  /**
   * Pause after `seconds` idle (60 to 86400). A paused room's ingress URL
   * wakes it on the next request, and pause is a full memory snapshot, so the
   * detached report server comes back with it.
   */
  async enableAutoPause(seconds: number): Promise<void> {
    if (!Number.isInteger(seconds) || seconds < 60 || seconds > 86_400) {
      throw new Error("auto-pause must be 60 to 86400 seconds");
    }
    await this.box.setAutoPause(seconds);
  }

  async destroy(): Promise<void> {
    try {
      await this.box.destroy();
    } catch (e) {
      if (e instanceof CreateosSandboxNotFoundError) return; // already gone
      throw e;
    }
    // Destroy is async and a `destroying` sandbox still counts against the cap: on Free the next create would 429.
    await this.box.waitUntilDestroyed({ timeoutMs: 30_000 }).catch(() => {});
  }

  // ---------------------------------------------------------------------------

  private async applyRules(rules: string[]): Promise<void> {
    const view = await this.box.setEgress(rules);
    // An empty list means allow-all. Never accept that as the result of sealing.
    if (!view.egress?.length) throw new Error("egress update came back empty (allow-all); refusing to continue");
    this.rules = view.egress;
    lastRules = this.rules;
  }

  private async probeEnv(dbHost: string): Promise<{ resolvers: string[]; db_ips: string[]; libs: boolean; python: string; machine: string }> {
    const r = await this.exec(`python3 -c ${shq(PROBE_PY)} ${shq(dbHost)}`, 60_000);
    try {
      const p = JSON.parse(r.stdout.trim().split("\n").pop() ?? "");
      return {
        resolvers: Array.isArray(p.resolvers) ? p.resolvers.filter((s: unknown) => isIP(String(s)) === 4) : [],
        db_ips: Array.isArray(p.db_ips) ? p.db_ips.filter((s: unknown) => isIP(String(s)) === 4) : [],
        libs: p.libs === true,
        python: String(p.python ?? ""),
        machine: String(p.machine ?? ""),
      };
    } catch {
      throw new Error(`environment probe failed (exit ${r.exit_code}): ${(r.stdout + r.stderr).trim().slice(-400)}`);
    }
  }

  /**
   * The VM never reaches PyPI. Wheels for its Python are downloaded on this
   * machine once (cached in ~/.cache/leakfinder), uploaded as one tarball and
   * installed with --no-index.
   */
  private async installLibraries(python: string, machine = ""): Promise<void> {
    const tgz = hostWheels(python, machine);
    // ~8 MB from a laptop uplink: the SDK's 60 s default is too tight on a slow connection.
    await this.box.files.upload("/tmp/lf-wheels.tgz", new Blob([readFileSync(tgz)]), { timeoutMs: 180_000 });
    // -U: an old preinstalled stripe satisfies a bare install and would stay.
    const pip = `python3 -m pip install -q -U --disable-pip-version-check --no-index --find-links /tmp/lf-wheels stripe "psycopg[binary]"`;
    // A tarball packed by macOS tar carries AppleDouble `._<name>.whl` twins that GNU tar extracts as files; drop them
    // so pip's --find-links only ever sees real wheels.
    const unpack = `mkdir -p /tmp/lf-wheels && tar xzf /tmp/lf-wheels.tgz -C /tmp/lf-wheels && rm -f /tmp/lf-wheels/._*`;
    const r = await this.exec(`${unpack} && (${pip} || ${pip} --break-system-packages) 2>&1 | tail -n 5; exit \${PIPESTATUS[0]}`, 300_000);
    const check = await this.exec(`python3 -c "import stripe, psycopg; stripe.InvoicePayment; print('ok')"`, 60_000);
    if (!check.stdout.includes("ok")) {
      throw new Error(`pip install of stripe and psycopg failed (exit ${r.exit_code}): ${(r.stdout + r.stderr).trim()}`);
    }
  }

  private async httpProbe(url: string, timeoutSecs: number): Promise<Probe> {
    const r = await this.exec(`python3 -c ${shq(HTTP_PROBE_PY)} ${shq(url)} ${timeoutSecs}`, (timeoutSecs + 10) * 1000);
    const m = r.stdout.match(/PROBE (\d+) ([\d.]+)/);
    if (m) return { code: Number(m[1]), secs: Number(m[2]), ran: true };
    // Killed by the exec timeout (a hung connect) still means no answer came back.
    return { code: 0, secs: r.ms / 1000, ran: r.exit_code === 124 };
  }

  private async probeSeal(budgetMs: number): Promise<SealCheck> {
    const started = Date.now();
    const outside = await this.httpProbe(BLOCKED_PROBE, 3);
    const pypi = await this.httpProbe(PYPI_PROBE, 3);
    // Only "no HTTP answer at all" counts as blocked.
    const sealed = outside.ran && outside.code === 0 && pypi.ran && pypi.code === 0;
    let stripe = await this.httpProbe(STRIPE_PROBE, 4);
    // Waiting only helps the Stripe side; a host that answered the outside probe is not going to stop.
    while (sealed && stripe.code === 0 && Date.now() - started < budgetMs) {
      await sleep(1_500);
      stripe = await this.httpProbe(STRIPE_PROBE, 4);
    }
    const left = !outside.ran
      ? "example.com → probe did not run"
      : sealed
        ? `example.com → blocked in ${outside.secs.toFixed(1)}s`
        : `example.com → ${outside.code} (NOT sealed)`;
    const mid = !pypi.ran ? "pypi.org → probe did not run" : pypi.code === 0 ? "pypi.org → blocked" : `pypi.org → ${pypi.code} (NOT sealed)`;
    const right = stripe.code
      ? `api.stripe.com → ${stripe.code}`
      : `api.stripe.com → unreachable after ${Math.round((Date.now() - started) / 1000)}s`;
    return { sealed, stripeReachable: stripe.code > 0, detail: `${left} · ${mid} · ${right}` };
  }

  /** Lenient: true once Stripe answers, false when the budget runs out. */
  private async waitForStripe(budgetMs = SEAL_BUDGET_MS): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      if ((await this.httpProbe(STRIPE_PROBE, 4)).code > 0) return true;
      if (Date.now() > deadline) return false;
      await sleep(1_500);
    }
  }

  /** IPv4 addresses of `hosts` as the VM's own resolver answers. Empty when DNS fails there. */
  private async resolveInVm(hosts: string[]): Promise<string[]> {
    const r = await this.exec(`python3 -c ${shq(RESOLVE_PY)} ${hosts.map(shq).join(" ")}`, 30_000).catch(() => null);
    return uniq((r?.stdout ?? "").trim().split(/\s+/).filter((ip) => isIP(ip) === 4)).sort();
  }

  /** Replace the Stripe hostname rule with its current addresses on 443, and make sure DNS is open. */
  private async pinStripe(): Promise<boolean> {
    // The VM may sit in another region than this machine and get other Stripe addresses; allow both views.
    const ips = uniq([...(await resolveV4(STRIPE_HOST)), ...(await this.resolveInVm([STRIPE_HOST]))]).sort();
    if (!ips.length) return false;
    const rest = this.rules.filter((r) => !isStripeRule(r));
    await this.applyRules(uniq([...ips.map((ip) => `${ip}:443`), ...rest, `${FALLBACK_DNS}:53`]));
    this.stripePinned = true;
    return true;
  }

  private async resumeOriginal(): Promise<void> {
    await this.box.refresh();
    if (this.box.status === "pausing") await this.box.waitUntilPaused({ timeoutMs: 180_000 });
    if (this.box.status === "paused" || this.box.status === "error") await this.box.resume();
    await this.box.waitUntilRunning({ timeoutMs: 180_000 });
  }

  private async ensureIngress(): Promise<void> {
    // GET may omit ingress_url_template (docs flag it as wire drift); the PATCH response carries it.
    if (!this.box.data.ingress_enabled || !this.box.data.ingress_url_template) await this.box.setIngress(true);
    if (!this.box.data.ingress_url_template) throw new Error("ingress is on but the API returned no URL template");
  }

  /** Prefer https; fall back to http if the ingress certificate is not there yet. */
  private async publicUrl(token: string): Promise<string> {
    const root = (u: string) => u.replace(/\/+$/, "") + "/";
    const https = root(this.box.previewUrl(REPORT_PORT));
    const http = root(this.box.previewUrl(REPORT_PORT, { scheme: "http" }));
    const deadline = Date.now() + 30_000;
    for (let i = 0; Date.now() < deadline; i++) {
      if (await answers(https, token)) return https;
      if (i >= 3 && (await answers(http, token))) return http;
      await sleep(1_500);
    }
    throw new Error(`report server is up inside the VM but ${https} did not answer from here`);
  }
}

async function answers(root: string, token: string): Promise<boolean> {
  try {
    const res = await fetch(`${root}status.json`, {
      headers: { "X-LeakFinder-Token": token },
      signal: AbortSignal.timeout(6_000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** Plan caps come back as 429 (and 403 for some quotas). */
function isCapError(e: unknown): boolean {
  if (e instanceof CreateosSandboxRateLimitError || e instanceof CreateosSandboxPermissionError) return true;
  return e instanceof CreateosSandboxApiError && /quota|limit|concurrent/i.test(e.message);
}

/** Turn a failed create into one line that says what to do. */
async function explainCreate(e: unknown): Promise<Error> {
  if (e instanceof CreateosSandboxPaymentRequiredError) {
    return new Error("CreateOS says the account is out of credit (402); top up, then retry");
  }
  if (!isCapError(e)) return e instanceof Error ? e : new Error(String(e));
  let held = "";
  let dying = "";
  try {
    const boxes = await SealedRoom.client().listSandboxes({ limit: 20 });
    const ids = (keep: (s: string) => boolean) =>
      boxes
        .filter((b) => keep(b.status))
        .map((b) => `${b.id} (${b.status})`)
        .join(", ");
    held = ids((s) => !["destroyed", "destroying", "failed"].includes(s));
    // A `destroying` row still holds its slot; calling that the daily cap would send you hunting for a quota you still have.
    dying = ids((s) => s === "destroying");
  } catch {
    /* listing is only a hint */
  }
  return new Error(
    held
      ? `CreateOS sandbox cap reached (Free = 1 concurrent; paused sandboxes count). Destroy the old room first: ${held}`
      : dying
        ? `CreateOS sandbox cap reached while the old room is still being destroyed: ${dying}. Wait ~30 s and retry.`
        : // Nothing is holding a slot, so it is the other cap: creates per rolling 24 h, destroyed sandboxes included.
          `CreateOS refused a new sandbox and none is running: likely the daily cap (Free = 10 per rolling 24 h, destroyed ones count). ${e instanceof Error ? e.message : ""}`.trim(),
  );
}

/**
 * A tarball of stripe + psycopg wheels for the VM's CPython and CPU (glibc
 * Linux, x86_64 unless the VM reports aarch64), built on this machine with
 * `pip download` and cached per Python version and arch, so a sealed room
 * installs them with no network at all.
 */
export function hostWheels(python: string, machine = ""): string {
  const ver = (python.match(/^(\d+)\.(\d+)/) ?? [])[0] ?? "3.13";
  const arch = /^(aarch64|arm64)$/i.test(machine) ? "aarch64" : "x86_64";
  const dir = join(homedir(), ".cache", "leakfinder");
  const out = join(dir, `wheels-cp${ver.replace(".", "")}-${arch}.tgz`);
  if (existsSync(out)) return out;
  mkdirSync(dir, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "lf-wheels-"));
  const platforms = ["manylinux_2_39", "manylinux_2_28", "manylinux_2_17", "manylinux2014", ...(arch === "x86_64" ? ["manylinux_2_5", "manylinux1"] : [])].map((p) => `${p}_${arch}`);
  const args = ["-m", "pip", "download", "-q", "--disable-pip-version-check", "-d", tmp, "--python-version", ver, "--implementation", "cp", "--only-binary=:all:", ...platforms.flatMap((p) => ["--platform", p]), "stripe", "psycopg[binary]"];
  const dl = spawnSync("python3", args, { encoding: "utf8", timeout: 180_000 });
  if (dl.status !== 0) throw new Error(`could not download wheels for Python ${ver} on this machine (python3 -m pip download): ${(dl.stderr || dl.stdout || String(dl.error ?? "")).trim().slice(-400)}`);
  // COPYFILE_DISABLE: macOS tar would otherwise add a `._<wheel>` AppleDouble file per wheel.
  const tar = spawnSync("tar", ["czf", out, "-C", tmp, "."], { encoding: "utf8", env: { ...process.env, COPYFILE_DISABLE: "1" } });
  if (tar.status !== 0) throw new Error(`could not pack wheels: ${tar.stderr.trim()}`);
  return out;
}
