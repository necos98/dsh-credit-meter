// Unit tests for the browser half (lib/client.js) loaded through the
// window.__ModuleLoader__ shim. Registration-level assertions mirror the
// template's client tests; the pure math and the components are exercised
// through the `internals` export and a recording react stub.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeClientCtx, loadClientModule } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const clientModules = loadClientModule(path.join(here, "..", "lib", "client.js"));
const client = clientModules.get("dsh-credit-meter");
const I = client.internals;

// Deterministic config for math tests: off-peak discount disabled.
const PEAK_CFG = { ...I.DEFAULT_CONFIG, offPeakEnabled: false };

// 2026-08-03 is a Monday; 02:00 UTC is peak, 12:00 UTC is off-peak,
// 2026-08-02 is a Sunday.
const PEAK_T = Date.parse("2026-08-03T02:00:00Z");
const OFF_T = Date.parse("2026-08-03T12:00:00Z");
const WEEKEND_T = Date.parse("2026-08-02T02:00:00Z");

// Two sessions with usage + one without, used by the aggregation tests.
const listState = {
  ids: ["s1", "s2", "s3"],
  byId: {
    s1: {
      id: "s1",
      displayTitle: "Alpha",
      blank: false,
      projectionValues: {
        tokenUsage: { uncachedInputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    },
    s2: { id: "s2", displayTitle: "Beta", blank: false, projectionValues: undefined },
    s3: {
      id: "s3",
      displayTitle: "Gamma",
      blank: false,
      projectionValues: {
        tokenUsage: { uncachedInputTokens: 0, outputTokens: 1e6, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    },
  },
};

const realFetch = globalThis.fetch;

beforeEach(() => {
  // No real network: the host route answers ok:false (estimate fallback).
  globalThis.fetch = async () => ({
    ok: false,
    json: async () => ({ ok: false, error: "no-credential", message: "test" }),
  });
  I.balanceStore.stop();
  I.balanceStore.state = { status: "loading", payload: null, lastError: null };
  I.balanceStore.intervalSec = I.DEFAULT_CONFIG.balanceIntervalSec;
  I.readConfig({ status: "ready", value: PEAK_CFG, writable: true });
});

afterEach(() => {
  I.balanceStore.stop();
  globalThis.fetch = realFetch;
});

/** Resolve the component registered on a slot. */
function slotComponent(ctx, name) {
  const slot = ctx.slotRegistrations.find((r) => r.name === name);
  assert.ok(slot, "slot " + name + " not registered");
  const reg = slot.factory();
  return reg.component;
}

// -- element-tree helpers over the recording react stub ({ __element: args })

function findText(node, pred) {
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findText(item, pred);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (node === null || node === undefined || typeof node !== "object") return undefined;
  const el = node.__element;
  if (el !== undefined) {
    for (const child of el.slice(2)) {
      if (typeof child === "string" && pred(child)) return child;
    }
    for (const child of el) {
      const hit = findText(child, pred);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

function findInput(node, pred) {
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findInput(item, pred);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (node === null || node === undefined || typeof node !== "object") return undefined;
  const el = node.__element;
  if (el !== undefined) {
    if (el[1] && el[1].type === "number" && pred(el[1])) return el[1];
    for (const child of el) {
      const hit = findInput(child, pred);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

function findSelect(node, pred) {
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findSelect(item, pred);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (node === null || node === undefined || typeof node !== "object") return undefined;
  const el = node.__element;
  if (el !== undefined) {
    if (el[0] === "select" && pred(el[1])) return el[1];
    for (const child of el) {
      const hit = findSelect(child, pred);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

// -- module contract

test("client module loads and exposes the plugin contract", () => {
  assert.ok(client, "module should be registered under dsh-credit-meter");
  assert.equal(typeof client.apply, "function");
  assert.deepEqual([...client.inject].sort(), ["configForms", "locale", "slots"].sort());
  assert.ok(I, "exports.internals present (for the tests)");
  assert.ok(I.DEFAULT_CONFIG && I.balanceStore && typeof I.tokenCost === "function");
});

test("client registers dictionaries and the three UI slots", () => {
  const ctx = createFakeClientCtx({ settings: { enabled: true, budget: 10 } });
  client.apply(ctx);
  // The client must ask the settings service for the entry id the patch row
  // composes, or Settings would serve defaults forever with every test green.
  assert.deepEqual(ctx.configForms.requested, ["dsh-credit-meter"]);
  assert.equal(ctx.dictionaries.length, 1);
  assert.ok(ctx.dictionaries[0].dict.en["footer.remaining"]);
  assert.ok(ctx.dictionaries[0].dict.it["footer.remaining"], "it dictionary present");
  assert.equal(ctx.slotRegistrations.length, 3);
  const names = ctx.slotRegistrations.map((r) => r.name).sort();
  assert.deepEqual(names, [
    "conversation.session.header.utilities",
    "settings.section",
    "sidebar.footer.action",
  ].sort());
  const section = ctx.slotRegistrations.find((r) => r.name === "settings.section");
  const reg = section.factory();
  assert.equal(reg.meta.id, "credit-meter");
  assert.equal(typeof reg.meta.label, "function");
  assert.equal(reg.meta.label(), "Credits", "label resolves through the en dictionary");
  assert.equal(typeof reg.component, "function");
});

test("client skips UI registration when slots are missing", () => {
  const ctx = createFakeClientCtx({ slots: false });
  client.apply(ctx);
  assert.equal(ctx.slotRegistrations.length, 0);
});

test("client skips dictionaries when locale is missing", () => {
  const ctx = createFakeClientCtx({ locale: false });
  client.apply(ctx);
  assert.equal(ctx.dictionaries.length, 0);
});

test("client config is synced from the settings scope", () => {
  const ctx = createFakeClientCtx({ settings: { priceInputPeakPerM: 2, offPeakEnabled: false } });
  client.apply(ctx);
  assert.equal(I.tokenCostWithFactor({ uncachedInputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 1), 2);
});

// -- pure math

test("tokenCost uses the peak prices and the off-peak factor", () => {
  assert.equal(new Date(PEAK_T).getUTCDay(), 1, "PEAK_T is a Monday (sanity)");
  I.readConfig({ status: "ready", value: { ...I.DEFAULT_CONFIG, offPeakEnabled: true }, writable: true });
  const oneM = { uncachedInputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  assert.ok(Math.abs(I.tokenCost(oneM, PEAK_T) - 0.44) < 1e-9, "1M uncached input peak = $0.44");
  assert.ok(
    Math.abs(I.tokenCost({ uncachedInputTokens: 0, outputTokens: 1e6, cacheReadTokens: 0, cacheWriteTokens: 0 }, PEAK_T) - 1.32) < 1e-9,
    "1M output peak = $1.32"
  );
  assert.ok(
    Math.abs(I.tokenCost({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 1e6, cacheWriteTokens: 0 }, PEAK_T) - 0.014) < 1e-9,
    "1M cache read peak = $0.014"
  );
  assert.equal(I.tokenCost(undefined), null);
  const mixed = I.tokenCost({ uncachedInputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 1e6 }, PEAK_T);
  assert.ok(Math.abs(mixed - (0.44 + 1.32 + 0.014)) < 1e-9, "mix peak (cache write is free)");
  assert.ok(Math.abs(I.tokenCost(oneM, OFF_T) - 0.22) < 1e-9, "1M input off-peak = $0.22 (50%)");
  assert.ok(
    Math.abs(I.tokenCostWithFactor(oneM, 0.5) - 0.22) < 1e-9,
    "tokenCostWithFactor 0.5 = half (explicit)"
  );
});

test("isPeakAt follows the DeepSeek peak windows (UTC, Mon-Fri)", () => {
  assert.equal(I.isPeakAt(PEAK_T), true, "Mon 02:00 UTC -> peak");
  assert.equal(I.isPeakAt(OFF_T), false, "Mon 12:00 UTC -> off-peak");
  assert.equal(I.isPeakAt(WEEKEND_T), false, "Sun 02:00 UTC -> off-peak (weekend)");
  assert.equal(I.isPeakAt(Date.parse("2026-08-03T04:00:00Z")), false, "Mon 04:00 -> boundary");
  assert.equal(I.isPeakAt(Date.parse("2026-08-03T06:00:00Z")), true, "Mon 06:00 -> peak");
  assert.equal(I.isPeakAt(Date.parse("2026-08-03T10:00:00Z")), false, "Mon 10:00 -> boundary");
  assert.ok(["peak", "off-peak"].includes(I.currentPeriod()));
});

test("priceFactor is 1 in peak and 0.5 in off-peak when enabled", () => {
  I.readConfig({ status: "ready", value: { ...I.DEFAULT_CONFIG, offPeakEnabled: true }, writable: true });
  assert.equal(I.priceFactor(PEAK_T), 1);
  assert.equal(I.priceFactor(OFF_T), 0.5);
  I.readConfig({ status: "ready", value: { ...I.DEFAULT_CONFIG, offPeakEnabled: false }, writable: true });
  assert.equal(I.priceFactor(OFF_T), 1);
});

test("money and token formatters", () => {
  I.readConfig({ status: "ready", value: { ...I.DEFAULT_CONFIG, currency: "USD" }, writable: true });
  assert.equal(I.formatMoney(1.37), "$1.37");
  assert.equal(I.formatBalance(42.5, "USD"), "$42.50");
  assert.equal(I.formatCompact(8.5), "$8.5");
  assert.equal(I.formatRail(8.5), "$8.5");
  assert.equal(I.formatRail(10), "$10");
  assert.equal(I.formatRail(1500), "$1.5K");
  assert.equal(I.formatTokens(517), "517");
  assert.equal(I.formatTokens(12345), "12.3K");
  assert.equal(I.formatTokens(123456), "123K");
  assert.equal(I.formatTokens(1_200_000), "1.2M");
});

test("model price presets are recognized", () => {
  assert.equal(I.presetOf({ priceInputPerM: 0.44, priceCacheReadPerM: 0.014, priceCacheWritePerM: 0, priceOutputPerM: 1.32 }), "deepseek-v4-flash");
  assert.equal(I.presetOf({ priceInputPerM: 1.32, priceCacheReadPerM: 0.044, priceCacheWritePerM: 0, priceOutputPerM: 3.96 }), "deepseek-v4-pro");
  assert.equal(I.presetOf({ priceInputPerM: 0.3, priceCacheReadPerM: 0.1, priceCacheWritePerM: 0, priceOutputPerM: 2 }), "custom");
});

test("realBalanceOf extracts the usable balance", () => {
  // Field-level asserts: values created in the vm sandbox have a different
  // realm prototype, so deepStrictEqual against a test-realm literal fails.
  const rb = I.realBalanceOf({ status: "ok", payload: { ok: true, balance: 42.5, currency: "USD", isAvailable: true } });
  assert.equal(rb.amount, 42.5);
  assert.equal(rb.currency, "USD");
  assert.equal(rb.isAvailable, true);
  assert.equal(I.realBalanceOf({ status: "loading", payload: null }), null);
  assert.equal(I.realBalanceOf({ status: "error", payload: null, lastError: "x" }), null);
});

test("totalsFromList and rowsFromList aggregate session usage", () => {
  // s1 = 1M in (0.44) + 1M out (1.32) = 1.76; s3 = 1M out = 1.32 -> 3.08
  const totals = I.totalsFromList(listState);
  assert.ok(Math.abs(totals.used - (1.76 + 1.32)) < 1e-9);
  assert.equal(totals.withUsage, 2);
  assert.ok(Math.abs(I.totalsFromListFactor(listState, 1).used - 3.08) < 1e-9);
  assert.ok(Math.abs(I.totalsFromListFactor(listState, 0.5).used - 1.54) < 1e-9);
  const rows = I.rowsFromList(listState);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].id, "s1");
  assert.equal(rows[1].id, "s3");
  assert.equal(rows[2].id, "s2", "no usage rows go last");
});

test("legacy v0.1 price keys in the settings document are ignored", () => {
  I.readConfig({ status: "ready", value: { priceInputPerM: 0.27, priceCacheReadPerM: 0.07, priceOutputPerM: 1.1 }, writable: true });
  const oneM = { uncachedInputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  assert.equal(I.tokenCostWithFactor(oneM, 1), 0.44);
  assert.equal(I.tokenCostWithFactor({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 1e6, cacheWriteTokens: 0 }, 1), 0.014);
});

// -- balance store

test("balance store polls the host route and re-arms on reschedule", async () => {
  const marks = [];
  const origSetInterval = globalThis.setInterval;
  const origClearInterval = globalThis.clearInterval;
  globalThis.setInterval = (fn, ms) => {
    marks.push(ms);
    return origSetInterval(fn, ms);
  };
  globalThis.clearInterval = (t) => origClearInterval(t);
  try {
    globalThis.fetch = async () => ({
      json: async () => ({ ok: true, balance: 42.5, currency: "USD", isAvailable: true, fetchedAt: Date.now() }),
    });
    const ctx = createFakeClientCtx({ settings: { balanceIntervalSec: 60 } });
    client.apply(ctx);
    assert.ok(marks.includes(60000), "polling starts with the configured interval");
    await I.balanceStore.refresh();
    assert.equal(I.balanceStore.state.status, "ok");
    assert.equal(I.balanceStore.state.payload.balance, 42.5);
    I.balanceStore.reschedule(10);
    assert.ok(marks.includes(10000), "reschedule re-arms the timer");
    assert.equal(I.balanceStore.intervalSec, 10);
  } finally {
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
    I.balanceStore.stop();
  }
});

test("balance interval is clamped to 5-3600 seconds", () => {
  I.balanceStore.reschedule(2);
  assert.equal(I.balanceStore.intervalSec, 5);
  I.balanceStore.reschedule(9999);
  assert.equal(I.balanceStore.intervalSec, 3600);
});

test("balance store records fetch errors", async () => {
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  await I.balanceStore.refresh();
  assert.equal(I.balanceStore.state.status, "error");
  assert.match(I.balanceStore.state.lastError, /network down/);
});

test("balance store treats ok:false responses as errors", async () => {
  globalThis.fetch = async () => ({
    json: async () => ({ ok: false, error: "no-credential", message: "no key configured" }),
  });
  await I.balanceStore.refresh();
  assert.equal(I.balanceStore.state.status, "error");
  assert.match(I.balanceStore.state.lastError, /no key configured/);
});

test("stop clears the polling timer", () => {
  const ctx = createFakeClientCtx({ settings: {} });
  client.apply(ctx);
  assert.notEqual(I.balanceStore.timer, null);
  I.balanceStore.stop();
  assert.equal(I.balanceStore.timer, null);
});

// -- component rendering (recording react stub)

test("footer renders the remaining credit estimate and the real balance", () => {
  const ctx = createFakeClientCtx({ settings: { enabled: true, budget: 10, offPeakEnabled: false } });
  client.apply(ctx);
  const comp = slotComponent(ctx, "sidebar.footer.action");
  const props = { scope: ctx.configForms.form, useSessions: (sel) => sel(listState), t: (k) => k };
  // no real balance (ok:false) -> estimate: budget 10 - used 3.08 = $6.92
  const wide = comp({ wide: true, ...props });
  assert.ok(findText(wide, (txt) => txt === "$6.92"), "wide shows the estimate remaining");
  const rail = comp({ wide: false, ...props });
  assert.notEqual(rail, null);
  assert.ok(findText(rail, (txt) => txt === "$6.9"), "rail shows the compact amount");
  // real balance available -> $42.50 with the "real balance" label
  I.balanceStore.state = {
    status: "ok",
    payload: { ok: true, balance: 42.5, currency: "USD", isAvailable: true, fetchedAt: Date.now() },
    lastError: null,
  };
  const withReal = comp({ wide: true, ...props });
  assert.ok(findText(withReal, (txt) => txt === "$42.50"), "wide shows the real balance");
  assert.ok(findText(withReal, (txt) => txt.includes("footer.real")), "label says real balance");
});

test("footer returns null when disabled", () => {
  const ctx = createFakeClientCtx({ settings: { enabled: false } });
  client.apply(ctx);
  const comp = slotComponent(ctx, "sidebar.footer.action");
  assert.equal(comp({ wide: true, scope: ctx.configForms.form, useSessions: (sel) => sel(listState), t: (k) => k }), null);
});

test("session header badge shows the estimated session cost", () => {
  const ctx = createFakeClientCtx({ settings: { offPeakEnabled: false } });
  client.apply(ctx);
  const comp = slotComponent(ctx, "conversation.session.header.utilities");
  const rendered = comp({
    sessionId: "s1",
    useProjection: () => ({ uncachedInputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    scope: ctx.configForms.form,
    t: (k) => k,
  });
  assert.ok(findText(rendered, (txt) => txt === "$1.76"), "badge shows the session cost");
  assert.equal(
    comp({ sessionId: "s1", useProjection: () => undefined, scope: ctx.configForms.form, t: (k) => k }),
    null,
    "no badge without usage"
  );
});

test("credits section lists sessions and edits settings", async () => {
  const ctx = createFakeClientCtx({
    settings: { enabled: true, budget: 10, offPeakEnabled: false, balanceIntervalSec: 60 },
  });
  client.apply(ctx);
  const comp = slotComponent(ctx, "settings.section");
  const rendered = comp({ close() {}, scope: ctx.configForms.form, useSessions: (sel) => sel(listState), t: (k) => k });
  assert.ok(findText(rendered, (txt) => txt === "Alpha"), "section lists the Alpha session");
  assert.ok(findText(rendered, (txt) => txt === "$1.76"), "section shows the Alpha session cost");
  assert.ok(
    findText(rendered, (txt) => txt.includes("section.range") && txt.includes("$3.08")),
    "section shows the off-peak -> peak range"
  );

  const budgetInput = findInput(rendered, (p) => p.value === 10);
  assert.ok(budgetInput, "budget input present (value 10)");
  await budgetInput.onChange({ target: { value: "20" } });
  assert.equal(ctx.configForms.form.getSnapshot().value.budget, 20);

  const intervalInput = findInput(rendered, (p) => p.value === 60);
  assert.ok(intervalInput, "balance interval input present (value 60)");
  await intervalInput.onChange({ target: { value: "20" } });
  assert.equal(ctx.configForms.form.getSnapshot().value.balanceIntervalSec, 20);
  await intervalInput.onChange({ target: { value: "2" } });
  assert.equal(ctx.configForms.form.getSnapshot().value.balanceIntervalSec, 5, "clamped to 5s from the client");

  const presetSelect = findSelect(rendered, (p) => p.value === "deepseek-v4-flash");
  assert.ok(presetSelect, "preset select present (deepseek-v4-flash default)");
  await presetSelect.onChange({ target: { value: "deepseek-v4-pro" } });
  const v = ctx.configForms.form.getSnapshot().value;
  assert.equal(v.priceInputPeakPerM, 1.32);
  assert.equal(v.priceCacheReadPeakPerM, 0.044);
  assert.equal(v.priceOutputPeakPerM, 3.96);
});
