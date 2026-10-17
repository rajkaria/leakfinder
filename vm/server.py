"""LeakFinder report server. Runs inside the sealed VM, stdlib only (3.10+).

Serves exactly two things to the public ingress URL: report.html and
status.json. Everything else is 404. A token is required for every route,
given once as ?k=<token> and then carried by an HttpOnly cookie so the page's
relative fetches work. POST /dryrun and POST /apply run the agent-written
fix.py next to it; /apply runs it with APPLY=1 at most once and remembers the
result in applied.json, so a double click or a reload cannot charge twice.

Env: LEAKFINDER_TOKEN (required), LEAKFINDER_WORKDIR (default /workspace),
LEAKFINDER_PORT (default 8080, 0 = any free port), LEAKFINDER_BIND
(default 0.0.0.0, because ingress forwards to eth0, not loopback).
"""

import hmac
import json
import os
import re
import subprocess
import sys
import threading
from datetime import datetime, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

WORKDIR = os.environ.get("LEAKFINDER_WORKDIR", "/workspace")
TOKEN = os.environ.get("LEAKFINDER_TOKEN", "")
PORT = int(os.environ.get("LEAKFINDER_PORT", "8080"))
BIND = os.environ.get("LEAKFINDER_BIND", "0.0.0.0")
FIX_TIMEOUT_S = int(os.environ.get("LEAKFINDER_FIX_TIMEOUT", "300"))

MARKER = "LEAKFINDER_SUMMARY"
COOKIE = "lf_token"
LOG_LINES = 40
MAX_LINE = 400
MAX_BODY = 64 * 1024
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
TEST_KEY_PREFIXES = ("sk_test_", "rk_test_")
CSP = (
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; "
    "connect-src 'self'; img-src data:"
)
SUMMARY_INTS = (
    "revoked", "invoices", "invoiced_cents", "refunds", "refunded_cents",
    "cancelled", "rows_synced", "leak_closed_cents",
)

# One fix.py at a time: a dry run and an apply must never overlap.
RUN_LOCK = threading.Lock()


def path(name):
    return os.path.join(WORKDIR, name)


def redact(text):
    return EMAIL.sub("[email]", text)


def parse_summary(stdout):
    """Same rules as parseSummary in src/types.ts: last marker line wins, ints only."""
    for line in reversed(stdout.splitlines()):
        if not line.startswith(MARKER):
            continue
        try:
            raw = json.loads(line[len(MARKER):].strip())
        except ValueError:
            return None
        if not isinstance(raw, dict):
            return None
        out = {"mode": "applied" if raw.get("mode") == "applied" else "dry_run"}
        for k in SUMMARY_INTS:
            try:
                out[k] = int(round(float(raw.get(k, 0))))
            except (TypeError, ValueError, OverflowError):
                out[k] = 0
        return out
    return None


def tail(stdout, stderr):
    lines = (stdout + ("\n" + stderr if stderr else "")).splitlines()
    lines = [redact(l)[:MAX_LINE] for l in lines if l.strip()]
    return lines[-LOG_LINES:]


def run_fix(apply):
    env = dict(os.environ)
    env["APPLY"] = "1" if apply else "0"
    env.pop("LEAKFINDER_TOKEN", None)  # fix.py has no business with the report token
    try:
        p = subprocess.run(
            [sys.executable, "fix.py"],
            cwd=WORKDIR,
            env=env,
            capture_output=True,
            text=True,
            timeout=FIX_TIMEOUT_S,
        )
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired as e:
        out = e.stdout if isinstance(e.stdout, str) else (e.stdout or b"").decode("utf-8", "replace")
        return 124, out, "fix.py timed out after %ds" % FIX_TIMEOUT_S


def read_applied():
    try:
        with open(path("applied.json")) as f:
            data = json.load(f)
        return data if isinstance(data, dict) and data.get("applied") is True else None
    except (OSError, ValueError):
        return None


def write_applied(data):
    tmp = path("applied.json.tmp")
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, path("applied.json"))


def live_key_present():
    key = os.environ.get("STRIPE_SECRET_KEY", "")
    return bool(key) and not key.startswith(TEST_KEY_PREFIXES)


class Handler(BaseHTTPRequestHandler):
    server_version = "LeakFinder"
    sys_version = ""

    # --- auth -------------------------------------------------------------
    def presented_tokens(self):
        q = parse_qs(urlsplit(self.path).query)
        found = list(q.get("k", []))
        header = self.headers.get("X-LeakFinder-Token")
        if header:
            found.append(header)
        raw = self.headers.get("Cookie")
        if raw:
            try:
                c = SimpleCookie()
                c.load(raw)
                if COOKIE in c:
                    found.append(c[COOKIE].value)
            except Exception:
                pass
        return found

    def authorized(self):
        want = TOKEN.encode()
        ok = False
        for t in self.presented_tokens():
            # Compare every candidate so timing does not depend on which one matched.
            ok = hmac.compare_digest(t.encode(), want) or ok
        return ok

    # --- responses --------------------------------------------------------
    def send(self, code, body, ctype, extra=None):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("X-Robots-Tag", "noindex")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def json(self, code, obj):
        self.send(code, json.dumps(obj), "application/json")

    def forbidden(self):
        self.json(403, {"error": "forbidden"})

    def route(self):
        return urlsplit(self.path).path.rstrip("/") or "/"

    # --- GET --------------------------------------------------------------
    def do_GET(self):
        route = self.route()
        if route not in ("/", "/index.html", "/report.html", "/status.json"):
            return self.json(404, {"error": "not found"})
        if not self.authorized():
            return self.forbidden()
        if route == "/status.json":
            return self.json(200, read_applied() or {"applied": False})
        try:
            with open(path("report.html"), "rb") as f:
                html = f.read()
        except OSError:
            return self.json(404, {"error": "no report yet"})
        cookie = "%s=%s; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400" % (COOKIE, TOKEN)
        if self.headers.get("X-Forwarded-Proto", "").lower() == "https":
            cookie += "; Secure"
        self.send(200, html, "text/html; charset=utf-8", {
            "Content-Security-Policy": CSP,
            "Set-Cookie": cookie,
        })

    do_HEAD = do_GET

    # --- POST -------------------------------------------------------------
    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            return self.json(413, {"error": "body too large"})
        if length:
            self.rfile.read(length)
        route = self.route()
        if route not in ("/dryrun", "/apply"):
            return self.json(404, {"error": "not found"})
        if not self.authorized():
            return self.forbidden()
        if not os.path.isfile(path("fix.py")):
            return self.json(409, {"error": "fix.py not written yet"})
        if route == "/dryrun":
            return self.dryrun()
        return self.apply()

    def dryrun(self):
        with RUN_LOCK:
            code, out, err = run_fix(apply=False)
        self.json(200 if code == 0 else 500, {
            "summary": parse_summary(out),
            "log": tail(out, err),
            "exit_code": code,
        })

    def apply(self):
        if live_key_present():
            return self.json(403, {"error": "refusing to apply with a live Stripe key; use sk_test_ or rk_test_"})
        with RUN_LOCK:
            done = read_applied()
            if done:
                return self.json(200, done)
            code, out, err = run_fix(apply=True)
            summary = parse_summary(out)
            log = tail(out, err)
            if code != 0 or summary is None:
                return self.json(500, {"applied": False, "summary": summary, "log": log, "exit_code": code})
            result = {
                "applied": True,
                "summary": summary,
                "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "log": log,
            }
            write_applied(result)
        self.json(200, result)

    def log_message(self, fmt, *args):
        # Never log the query string: it carries the token.
        route = urlsplit(getattr(self, "path", "") or "").path
        sys.stderr.write("%s %s %s\n" % (getattr(self, "command", ""), route, args[1] if len(args) > 1 else ""))


def main():
    if not TOKEN:
        sys.stderr.write("LEAKFINDER_TOKEN is required\n")
        sys.exit(2)
    httpd = ThreadingHTTPServer((BIND, PORT), Handler)
    httpd.daemon_threads = True
    host, port = httpd.server_address[:2]
    print("LEAKFINDER_SERVER listening %s:%d" % (host, port), flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
