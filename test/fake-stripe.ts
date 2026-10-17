/**
 * A small in-memory Stripe on localhost. The real stripe-node v23 client (and
 * stripe-python, through stripe.api_base) talks to it over HTTP, so callers
 * check the requests the seed actually sends: paths, form-encoded params,
 * pagination, expand. test/seed.test.ts uses it, and so does
 * scripts/rehearse-offline.ts, which runs the real `pnpm seed` and
 * `pnpm verify` against it.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import StripeSdk from "stripe";
import type Stripe from "stripe";

export type Obj = Record<string, any>;

export function parseForm(qs: string): Obj {
  const out: Obj = {};
  for (const [k, v] of new URLSearchParams(qs)) {
    const parts = k.split(/[[\]]+/).filter(Boolean);
    let o = out;
    parts.forEach((p, i) => {
      if (i === parts.length - 1) o[p] = v;
      else o = o[p] ??= /^\d+$/.test(parts[i + 1]) ? [] : {};
    });
  }
  return out;
}

export class FakeStripe {
  customers = new Map<string, Obj>();
  subs = new Map<string, Obj>();
  prices = new Map<string, Obj>();
  products = new Map<string, Obj>();
  /** Stripe Search is not offered to accounts in India; flip this to make it 400. */
  searchWorks = true;
  /** Ids search has not indexed yet (search runs up to a minute behind). */
  searchLag = new Set<string>();
  calls: string[] = [];
  /** Messages of routes that threw (a failed assertion on what the SDK sent). */
  errors: string[] = [];
  private n = 0;
  id = (prefix: string) => `${prefix}_${String(++this.n).padStart(6, "0")}`;

  customer(fields: Obj = {}) {
    const c = { id: this.id("cus"), object: "customer", metadata: {}, invoice_settings: { default_payment_method: null }, ...fields };
    this.customers.set(c.id, c);
    return c;
  }
  price(fields: Obj = {}) {
    const p = { id: this.id("price"), object: "price", active: true, unit_amount: 2900, currency: "usd", recurring: { interval: "month", interval_count: 1 }, metadata: {}, ...fields };
    this.prices.set(p.id, p);
    return p;
  }
  product(fields: Obj = {}) {
    const p = { id: this.id("prod"), object: "product", active: true, metadata: {}, ...fields };
    this.products.set(p.id, p);
    return p;
  }
  sub(customer: string, price: Obj, fields: Obj = {}) {
    const now = 1_790_000_000;
    const s = {
      id: this.id("sub"),
      object: "subscription",
      customer,
      status: "active",
      cancel_at_period_end: false,
      metadata: {},
      items: { object: "list", has_more: false, data: [{ id: this.id("si"), object: "subscription_item", current_period_start: now, current_period_end: now + 30 * 86_400, price, quantity: 1 }] },
      ...fields,
    };
    this.subs.set(s.id, s);
    return s;
  }

  private page(items: Obj[], q: Obj, url: string) {
    const limit = Number(q.limit ?? 10);
    const from = q.starting_after ? items.findIndex((x) => x.id === q.starting_after) + 1 : 0;
    const data = items.slice(from, from + limit);
    return { object: "list", data, has_more: from + limit < items.length, url };
  }
  private newestFirst = (m: Map<string, Obj>) => [...m.values()].reverse();
  private expandSub = (s: Obj, q: Obj) => {
    const wants = Object.values(q.expand ?? {}).includes("data.customer");
    if (!wants) return s;
    return { ...s, customer: this.customers.get(s.customer) ?? { id: s.customer, object: "customer", deleted: true } };
  };

  handle(method: string, path: string, q: Obj): [number, Obj] {
    this.calls.push(`${method} ${path}`);
    const missing: [number, Obj] = [404, { error: { type: "invalid_request_error", code: "resource_missing", message: `No such object: ${path}` } }];
    let m: RegExpMatchArray | null;
    if (method === "GET" && path === "/v1/customers/search") {
      if (!this.searchWorks) return [400, { error: { type: "invalid_request_error", message: "Search is not available in your country." } }];
      const [, key, val] = /metadata\['([^']+)'\]:'([^']*)'/.exec(q.query) ?? [];
      const data = this.newestFirst(this.customers).filter((c) => c.metadata?.[key] === val && !this.searchLag.has(c.id));
      return [200, { object: "search_result", data, has_more: false, next_page: null, url: "/v1/customers/search" }];
    }
    if (method === "GET" && path === "/v1/customers") return [200, this.page(this.newestFirst(this.customers), q, path)];
    if (method === "POST" && path === "/v1/customers") {
      const pm = q.payment_method ? this.id("pm") : null;
      return [200, this.customer({ email: q.email, name: q.name, metadata: q.metadata ?? {}, invoice_settings: { default_payment_method: q.invoice_settings?.default_payment_method ? pm : null } })];
    }
    if ((m = path.match(/^\/v1\/customers\/(\w+)$/)) && method === "DELETE") {
      if (!this.customers.delete(m[1])) return missing;
      for (const s of this.subs.values()) if (s.customer === m[1] && s.status !== "canceled") s.status = "canceled";
      return [200, { id: m[1], object: "customer", deleted: true }];
    }
    if (method === "GET" && path === "/v1/subscriptions") {
      const all = this.newestFirst(this.subs).filter((s) => (q.status === "all" ? true : s.status !== "canceled"));
      const page = this.page(all, q, path);
      return [200, { ...page, data: page.data.map((s) => this.expandSub(s, q)) }];
    }
    if (method === "POST" && path === "/v1/subscriptions") {
      const c = this.customers.get(q.customer);
      const price = this.prices.get(q.items?.[0]?.price);
      if (!c || !price) return missing;
      assert.equal(q.payment_behavior, "error_if_incomplete");
      const trial = Number(q.trial_period_days ?? 0);
      // No card on file and no trial: the first invoice cannot be paid.
      const status = trial ? "trialing" : c.invoice_settings.default_payment_method ? "active" : "incomplete";
      return [200, this.sub(c.id, price, { status, metadata: q.metadata ?? {}, cancel_at_period_end: q.cancel_at_period_end === "true" })];
    }
    if ((m = path.match(/^\/v1\/subscriptions\/(\w+)$/))) {
      const s = this.subs.get(m[1]);
      if (!s) return missing;
      if (method === "DELETE") s.status = "canceled";
      return [200, s];
    }
    for (const [base, store] of [["prices", this.prices], ["products", this.products]] as const) {
      if (method === "GET" && path === `/v1/${base}`) return [200, this.page(this.newestFirst(store).filter((x) => q.active === undefined || String(x.active) === q.active), q, path)];
      if (method === "POST" && path === `/v1/${base}`) {
        const fields = { ...q, metadata: q.metadata ?? {} };
        if (base === "prices") return [200, this.price({ ...fields, unit_amount: Number(q.unit_amount), recurring: { interval: q.recurring?.interval, interval_count: 1 } })];
        return [200, this.product(fields)];
      }
      if ((m = path.match(new RegExp(`^/v1/${base}/(\\w+)$`))) && method === "POST") {
        const x = store.get(m[1]);
        if (!x) return missing;
        if (q.active !== undefined) x.active = q.active === "true";
        return [200, x];
      }
    }
    return [404, { error: { type: "invalid_request_error", message: `fake has no route ${method} ${path}` } }];
  }
}

/** The fake behind an HTTP server on 127.0.0.1 (a free port unless one is given). */
export async function startFakeStripe(port = 0) {
  const fake = new FakeStripe();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake");
      let status: number, json: Obj;
      try {
        [status, json] = fake.handle(req.method ?? "GET", url.pathname, parseForm(req.method === "GET" || req.method === "DELETE" ? url.search.slice(1) : body));
      } catch (e) {
        // A failed assertion in a route: answer 500 so the SDK call fails loudly instead of the process dying.
        fake.errors.push(e instanceof Error ? e.message : String(e));
        [status, json] = [500, { error: { type: "api_error", message: `fake Stripe: ${e instanceof Error ? e.message : e}` } }];
      }
      res.writeHead(status, { "content-type": "application/json", "request-id": "req_fake" }).end(JSON.stringify(json));
    });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const at = (server.address() as { port: number }).port;
  return {
    fake,
    port: at,
    /** For stripe-python: stripe.api_base = apiBase. */
    apiBase: `http://127.0.0.1:${at}`,
    client: () => new StripeSdk("sk_test_fake", { host: "127.0.0.1", port: at, protocol: "http", maxNetworkRetries: 0, telemetry: false }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export async function withFakeStripe(fn: (fake: FakeStripe, stripe: Stripe) => Promise<void>) {
  const s = await startFakeStripe();
  try {
    await fn(s.fake, s.client());
    assert.deepEqual(s.fake.errors, [], "no route failed inside the fake");
  } finally {
    await s.close();
  }
}
