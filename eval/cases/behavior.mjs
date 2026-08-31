// Behavior evals: scenario-level checks that run the plugin's apply() against
// a fake ctx. Deterministic and free. Run with `npm run eval`.
import { NS } from "../../lib/config.js";
import { BALANCE_PATH, API_KEY_ENV } from "../../lib/handlers.js";

/** Minimal node http response recorder. */
function fakeRes() {
  const r = { status: 0, headers: null, body: "" };
  r.writeHead = (code, headers) => {
    r.status = code;
    r.headers = headers;
  };
  r.end = (body) => {
    r.body = body;
  };
  return r;
}

export const cases = [
  {
    name: "settings namespace is registered and resolves for the client",
    run(t) {
      const ctx = t.fakeCtx({});
      t.assert.equal(ctx.namespaces[0].ns, NS);
      const resolved = ctx.namespaces[0].schema({ budget: 5 });
      t.assert.equal(resolved.budget, 5);
      t.assert.equal(resolved.enabled, true);
    },
  },
  {
    name: "config validation rejects unknown keys at load",
    run(t) {
      t.assert.throws(() => t.fakeCtx({ nope: true }), /unknown key\(s\) nope/);
    },
  },
  {
    name: "balance route answers no-credential without a key",
    async run(t) {
      const ctx = t.fakeCtx({});
      const route = ctx.routes.find((r) => r.path === BALANCE_PATH);
      t.assert.ok(route, "balance route registered");
      const res = fakeRes();
      await route.handler({}, res);
      const p = JSON.parse(res.body);
      t.assert.equal(res.status, 200);
      t.assert.equal(p.ok, false);
      t.assert.equal(p.error, "no-credential");
    },
  },
  {
    name: "balance route returns the real balance with a credential",
    async run(t) {
      const prevFetch = globalThis.fetch;
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            is_available: true,
            balance_infos: [{ currency: "USD", total_balance: "42.50", granted_balance: "0.00", topped_up_balance: "42.50" }],
          }),
      });
      try {
        const ctx = t.fakeCtx({}, {
          credentials: {
            resolve: async (ref) =>
              ref === API_KEY_ENV ? { value: "sk-eval", source: "env" } : undefined,
          },
        });
        const route = ctx.routes.find((r) => r.path === BALANCE_PATH);
        const res = fakeRes();
        await route.handler({}, res);
        const p = JSON.parse(res.body);
        t.assert.equal(p.ok, true);
        t.assert.equal(p.balance, 42.5);
        t.assert.equal(p.currency, "USD");
      } finally {
        globalThis.fetch = prevFetch;
      }
    },
  },
  {
    name: "balance route caches and honors ?ttl=",
    async run(t) {
      let calls = 0;
      const prevFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        calls += 1;
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              is_available: true,
              balance_infos: [{ currency: "USD", total_balance: "1.00" }],
            }),
        };
      };
      try {
        const ctx = t.fakeCtx({}, {
          credentials: { resolve: async () => ({ value: "sk-eval" }) },
        });
        const route = ctx.routes.find((r) => r.path === BALANCE_PATH);
        await route.handler({}, fakeRes());
        await route.handler({}, fakeRes());
        t.assert.equal(calls, 1, "second request served from the cache");
        await route.handler({ url: BALANCE_PATH + "?ttl=10" }, fakeRes());
        t.assert.equal(calls, 2, "ttl bypasses the cache");
      } finally {
        globalThis.fetch = prevFetch;
      }
    },
  },
];
