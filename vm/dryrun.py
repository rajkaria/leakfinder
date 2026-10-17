"""
LeakFinder's dry-run harness. Runs the agent-written fix.py with APPLY=0 in a
way that cannot write, whatever the script does with APPLY: every Stripe
request other than GET is refused before it leaves the VM, and every Postgres
session is read-only. A script that tries to write fails with the reason, and
the agent is asked to rewrite it. The script is not trusted to honour APPLY;
this file is what makes a dry run dry.

Uploaded next to fix.py as leakfinder_dryrun.py and run from there:

    python3 leakfinder_dryrun.py [fix.py]
"""
import os
import runpy
import sys

os.environ["APPLY"] = "0"


class DryRunWriteRefused(RuntimeError):
    pass


def guard_stripe():
    try:
        from stripe import _http_client as http
    except Exception:
        return  # no stripe library: nothing can call it

    def wrap(fn):
        def guarded(self, method, url, *args, **kwargs):
            if str(method).lower() != "get":
                where = str(url).split("?")[0]
                where = where[where.find("/v1/"):] if "/v1/" in where else where
                raise DryRunWriteRefused("dry run: Stripe %s %s refused; gate only this write on APPLY and keep the reads in both modes" % (str(method).upper(), where))
            return fn(self, method, url, *args, **kwargs)

        return guarded

    # Every request the library makes goes through one of these on the base client.
    for name in ("request_with_retries", "request_stream_with_retries", "request_with_retries_async", "request_stream_with_retries_async"):
        fn = getattr(http.HTTPClient, name, None)
        if fn is not None:
            setattr(http.HTTPClient, name, wrap(fn))


def guard_postgres():
    try:
        import psycopg
    except Exception:
        return
    original = psycopg.Connection.connect.__func__

    def connect(cls, *args, **kwargs):
        conn = original(cls, *args, **kwargs)
        # Session level and committed at once, so every later transaction on this connection is read-only.
        auto = conn.autocommit
        conn.autocommit = True
        conn.execute("SET SESSION default_transaction_read_only = on")
        conn.autocommit = auto
        return conn

    psycopg.Connection.connect = classmethod(connect)
    psycopg.connect = psycopg.Connection.connect


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "fix.py")
    guard_stripe()
    guard_postgres()
    sys.argv = [target] + sys.argv[2:]
    runpy.run_path(target, run_name="__main__")
