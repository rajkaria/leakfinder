/**
 * One-command live check of the sealed room, for when .env exists:
 * whoami → open (ingress on) → seal check → Python, stripe, psycopg and a
 * Postgres `select 1` through the IP egress rule → serve a tiny report and
 * fetch it through the public URL → optional fork → destroy.
 *
 *   pnpm spike            one sandbox, destroyed in finally
 *   pnpm spike --fork     also pauseAndFork (needs the Beginner plan; on Free it prints why not)
 *   pnpm spike --hold 60  keep the room up 60 s so you can open the URL yourself
 *
 * Prints counts and status codes only, never rows.
 */
import { randomBytes } from "node:crypto";
import { SealedRoom, WORKDIR } from "../src/sandbox.js";

const args = process.argv.slice(2);
const withFork = args.includes("--fork");
const holdIdx = args.indexOf("--hold");
const holdSecs = holdIdx >= 0 ? Number(args[holdIdx + 1]) || 60 : 0;

const t0 = Date.now();
const log = (s: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s  ${s}`);

const CHECK_PY = `
import os, sys
print("python", sys.version.split()[0])
import stripe, psycopg
print("stripe", stripe.VERSION, "· psycopg", psycopg.__version__)
with psycopg.connect(os.environ["DATABASE_URL"], connect_timeout=10) as c:
    print("postgres select 1 →", c.execute("select 1").fetchone()[0])
`;

async function main() {
  const me = await SealedRoom.client().whoami();
  log(`whoami ${me.user_id} · running ${me.stats.running} · paused ${me.stats.paused} · total ${me.stats.total}`);

  let room: SealedRoom | undefined;
  try {
    room = await SealedRoom.open({ name: `leakfinder-spike-${Date.now().toString(36)}`, ingress: true });
    log(`opened ${room.id}`);
    log(`egress ${room.egress.join(", ")}`);

    const seal = await room.sealCheck();
    log(`seal ${seal.sealed ? "sealed" : "NOT SEALED"} · stripe ${seal.stripeReachable ? "reachable" : "UNREACHABLE"} · ${seal.detail}`);
    log(`egress now ${room.egress.join(", ")}`);

    await room.upload(`${WORKDIR}/spike_check.py`, CHECK_PY);
    const py = await room.runPython("spike_check.py", {}, 60_000);
    for (const line of (py.stdout + py.stderr).trim().split("\n").slice(-6)) log(`  ${line}`);
    log(`check exit ${py.exit_code} in ${(py.ms / 1000).toFixed(1)}s`);

    const token = randomBytes(24).toString("base64url");
    const html = "<!doctype html><meta charset=utf-8><title>LeakFinder spike</title><h1>LeakFinder spike</h1>";
    const { url } = await room.serveReport({ html, token });
    log(`report ${url}?k=${token}`);
    const res = await fetch(`${url}?k=${token}`, { signal: AbortSignal.timeout(10_000) });
    const body = await res.text();
    log(`public fetch ${res.status} · html ${body.includes("LeakFinder spike") ? "matches" : "DOES NOT MATCH"}`);
    const anon = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    log(`public fetch without token ${anon.status} (want 403)`);

    if (withFork) {
      let fork: SealedRoom | undefined;
      try {
        fork = await room.pauseAndFork();
        log(`fork ${fork.id} running · egress ${fork.egress.length} rules`);
        const r = await fork.exec(`test -f ${WORKDIR}/spike_check.py && echo fork-has-state`);
        log(`fork ${r.stdout.trim() || "missing state"} · ${(await fork.sealCheck()).detail}`);
      } catch (e) {
        log(`fork: ${(e as Error).message}`);
      } finally {
        if (fork) {
          await fork.destroy();
          log(`destroyed fork ${fork.id}`);
        }
      }
      const after = await fetch(url, { headers: { "X-LeakFinder-Token": token }, signal: AbortSignal.timeout(20_000) })
        .then((r) => String(r.status))
        .catch((e) => (e as Error).message);
      log(`report after pause/resume: ${after} (200 = detached server survived)`);
    }

    if (holdSecs > 0) {
      log(`holding ${holdSecs}s, open the report URL now`);
      await new Promise((r) => setTimeout(r, holdSecs * 1000));
    }
  } finally {
    if (room) {
      await room.destroy();
      log(`destroyed ${room.id}`);
    }
  }
}

// The SDK's HTTP/2 session is never unref'd; without an explicit exit the script would not return to the prompt.
main().then(
  () => process.exit(0),
  (e) => {
    console.error(`spike failed: ${(e as Error).message}`);
    process.exit(1);
  },
);
