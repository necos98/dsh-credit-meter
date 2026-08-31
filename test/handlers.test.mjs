// Unit tests for the balance handler factory (lib/handlers.js). The factory
// takes its dependencies explicitly, so the route is driven without booting
// DSH and without any real network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  API_KEY_ENV,
  BALANCE_PATH,
  BALANCE_URL,
  CACHE_MS,
  createBalanceHandler,
  credentialRef,
} from "../lib/handlers.js";

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

const json = (res) => JSON.parse(res.body);

/** Credentials service stub: resolves the key only when `key` is set. */
function fakeCredentials(key) {
  return {
    resolve: async (ref) =>
      ref === API_KEY_ENV && key !== undefined
        ? { value: key, source: "env" }
        : undefined,
  };
}

/** Balance endpoint stub: 42.50 USD, multi-currency to test the USD preference. */
function balanceFetch({ calls } = {}) {
  return async () => {
    if (calls) calls.count += 1;
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          is_available: true,
          balance_infos: [
            { currency: "EUR", total_balance: "30.00", granted_balance: "0.00", topped_up_balance: "30.00" },
            { currency: "USD", total_balance: "42.50", granted_balance: "0.00", topped_up_balance: "42.50" },
          ],
        }),
    };
  };
}

test("exposes the route constants", () => {
  assert.equal(BALANCE_PATH, "/credit-meter/balance");
  assert.equal(BALANCE_URL, "https://api.deepseek.com/user/balance");
  assert.equal(API_KEY_ENV, "DEEPSEEK_API_KEY");
  assert.equal(CACHE_MS, 30_000);
});

test("credentialRef validates the ref pattern", () => {
  assert.equal(credentialRef(API_KEY_ENV), API_KEY_ENV);
  assert.throws(() => credentialRef("bad ref!"), /must match/);
});

test("no credentials service -> no-credential", async () => {
  const handler = createBalanceHandler({ credentials: () => undefined });
  const res = fakeRes();
  await handler({}, res);
  const p = json(res);
  assert.equal(res.status, 200);
  assert.equal(p.ok, false);
  assert.equal(p.error, "no-credential");
});

test("unresolved key -> no-credential", async () => {
  const handler = createBalanceHandler({ credentials: () => fakeCredentials(undefined) });
  const res = fakeRes();
  await handler({}, res);
  assert.equal(json(res).error, "no-credential");
});

test("real balance is parsed and USD is preferred", async () => {
  const handler = createBalanceHandler({
    credentials: () => fakeCredentials("sk-test"),
    fetchImpl: balanceFetch(),
  });
  const res = fakeRes();
  await handler({}, res);
  const p = json(res);
  assert.equal(p.ok, true);
  assert.equal(p.balance, 42.5);
  assert.equal(p.currency, "USD");
  assert.equal(p.isAvailable, true);
  assert.equal(p.granted, 0);
  assert.equal(p.toppedUp, 42.5);
  assert.equal(typeof p.fetchedAt, "number");
});

test("successful responses are cached", async () => {
  const calls = { count: 0 };
  const handler = createBalanceHandler({
    credentials: () => fakeCredentials("sk"),
    fetchImpl: balanceFetch({ calls }),
  });
  const r1 = fakeRes();
  await handler({}, r1);
  const r2 = fakeRes();
  await handler({}, r2);
  assert.equal(calls.count, 1);
  assert.equal(json(r2).balance, 42.5);
});

test("?ttl= bypasses the cache", async () => {
  const calls = { count: 0 };
  const handler = createBalanceHandler({
    credentials: () => fakeCredentials("sk"),
    fetchImpl: balanceFetch({ calls }),
  });
  await handler({}, fakeRes());
  await handler({ url: "/credit-meter/balance?ttl=10" }, fakeRes());
  assert.equal(calls.count, 2);
});

test("an invalid ttl does not bypass the cache", async () => {
  const calls = { count: 0 };
  const handler = createBalanceHandler({
    credentials: () => fakeCredentials("sk"),
    fetchImpl: balanceFetch({ calls }),
  });
  await handler({}, fakeRes());
  await handler({ url: "/credit-meter/balance?ttl=2" }, fakeRes());
  assert.equal(calls.count, 1);
});

test("the cache expires after cacheMs", async () => {
  let t = 0;
  const calls = { count: 0 };
  const handler = createBalanceHandler({
    credentials: () => fakeCredentials("sk"),
    fetchImpl: balanceFetch({ calls }),
    now: () => t,
    cacheMs: 30_000,
  });
  await handler({}, fakeRes()); // t = 0, cached
  t = 31_000; // cache expired
  await handler({}, fakeRes());
  assert.equal(calls.count, 2);
});

test("fetch failure -> fetch-failed", async () => {
  const handler = createBalanceHandler({
    credentials: () => fakeCredentials("sk"),
    fetchImpl: async () => {
      throw new Error("boom");
    },
  });
  const res = fakeRes();
  await handler({}, res);
  const p = json(res);
  assert.equal(p.ok, false);
  assert.equal(p.error, "fetch-failed");
  assert.match(p.message, /boom/);
});

test("http error -> http-<status> with the API detail", async () => {
  const handler = createBalanceHandler({
    credentials: () => fakeCredentials("sk"),
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: { message: "Invalid API key" } }),
    }),
  });
  const res = fakeRes();
  await handler({}, res);
  const p = json(res);
  assert.equal(p.ok, false);
  assert.equal(p.error, "http-401");
  assert.match(p.message, /Invalid API key/);
});

test("invalid json -> error", async () => {
  const handler = createBalanceHandler({
    credentials: () => fakeCredentials("sk"),
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => "not json" }),
  });
  const res = fakeRes();
  await handler({}, res);
  assert.equal(json(res).ok, false);
});
