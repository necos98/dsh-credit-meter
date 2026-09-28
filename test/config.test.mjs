// Unit tests for the pure config domain (lib/config.js): defaults, clamping,
// legacy-key tolerance and the plugin's Config schema.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Config,
  CONFIG_KEYS,
  DEFAULT_CONFIG,
  SETTINGS_NS,
  creditMeterSchema,
  resolveConfig,
} from "../lib/config.js";

/** The cosmokit volatile-reference protocol (Symbol.for: stable across copies). */
const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");

/**
 * A `.volatile()` Config field resolves to a reference whose value is read
 * through `get()`, exactly as DSH's own `plainConfig` unwraps it. Assertions on
 * a resolved section have to do the same.
 * @param value - a resolved Config section or a single config value.
 * @returns the plain JSON-shaped value.
 */
function plain(value) {
  if (typeof value === "object" && value !== null && VOLATILE_WRITE in value) {
    return plain(value.get());
  }
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

test("resolveConfig applies defaults", () => {
  assert.deepEqual(resolveConfig({}), DEFAULT_CONFIG);
  assert.deepEqual(resolveConfig(undefined), DEFAULT_CONFIG);
  assert.deepEqual(resolveConfig(null), DEFAULT_CONFIG);
});

test("resolveConfig passes explicit values through", () => {
  const cfg = {
    enabled: false,
    budget: 50,
    currency: "EUR",
    offPeakEnabled: false,
    balanceIntervalSec: 120,
    priceInputPeakPerM: 1.32,
    priceCacheReadPeakPerM: 0.044,
    priceCacheWritePeakPerM: 0,
    priceOutputPeakPerM: 3.96,
  };
  assert.deepEqual(resolveConfig(cfg), cfg);
});

test("resolveConfig ignores unknown and legacy keys", () => {
  // Lenient on purpose: the persisted settings document may carry orphaned
  // keys from an older plugin version (the v0.1 priceInputPerM fields).
  const resolved = resolveConfig({ budget: 3, nope: 1, priceInputPerM: 0.27 });
  assert.equal(resolved.budget, 3);
  assert.equal(resolved.nope, undefined);
  assert.equal(resolved.priceInputPerM, undefined);
  assert.deepEqual(Object.keys(resolved).sort(), [...CONFIG_KEYS].sort());
});

test("resolveConfig reads a schema-resolved (volatile) section", () => {
  // DSH resolves the row config against the Config schema, so a volatile field
  // arrives as a reference, not as its value: resolveConfig has to unwrap it or
  // every configured value would silently fall back to the built-in default.
  const resolved = resolveConfig(Config({ budget: 42, currency: "EUR" }));
  assert.equal(resolved.budget, 42);
  assert.equal(resolved.currency, "EUR");
  assert.equal(resolved.enabled, DEFAULT_CONFIG.enabled);
  assert.equal(resolved.balanceIntervalSec, DEFAULT_CONFIG.balanceIntervalSec);
});

test("resolveConfig narrows malformed fields instead of throwing", () => {  // The Config schema rejects these at activation; resolveConfig is the last
  // line of defence for a hand-edited settings document, so it sanitizes.
  assert.equal(resolveConfig({ enabled: "yes" }).enabled, DEFAULT_CONFIG.enabled);
  assert.equal(resolveConfig({ budget: "10" }).budget, DEFAULT_CONFIG.budget);
  assert.equal(resolveConfig({ currency: "  " }).currency, DEFAULT_CONFIG.currency);
  assert.equal(
    resolveConfig({ offPeakEnabled: 1 }).offPeakEnabled,
    DEFAULT_CONFIG.offPeakEnabled
  );
  assert.equal(
    resolveConfig({ balanceIntervalSec: "60" }).balanceIntervalSec,
    DEFAULT_CONFIG.balanceIntervalSec
  );
  assert.equal(
    resolveConfig({ priceOutputPeakPerM: "1.32" }).priceOutputPeakPerM,
    DEFAULT_CONFIG.priceOutputPeakPerM
  );
});

test("resolveConfig rejects a non-object", () => {
  assert.throws(() => resolveConfig("nope"), /needs an object/);
  assert.throws(() => resolveConfig([1, 2]), /needs an object/);
});

test("creditMeterSchema applies defaults and clamps", () => {
  assert.deepEqual(creditMeterSchema(undefined), DEFAULT_CONFIG);
  const clamped = creditMeterSchema({
    budget: -5,
    priceInputPeakPerM: -1,
    priceOutputPeakPerM: 2,
    offPeakEnabled: false,
  });
  assert.equal(clamped.budget, 0);
  assert.equal(clamped.priceInputPeakPerM, 0);
  assert.equal(clamped.priceOutputPeakPerM, 2);
  assert.equal(clamped.offPeakEnabled, false);
  assert.equal(creditMeterSchema({ balanceIntervalSec: 2 }).balanceIntervalSec, 5);
  assert.equal(creditMeterSchema({ balanceIntervalSec: 9999 }).balanceIntervalSec, 3600);
});

test("creditMeterSchema ignores legacy v0.1 price keys", () => {
  const s = creditMeterSchema({
    priceInputPerM: 0.27,
    priceCacheReadPerM: 0.07,
    priceOutputPerM: 1.1,
  });
  assert.equal(s.priceInputPeakPerM, DEFAULT_CONFIG.priceInputPeakPerM);
  assert.equal(s.priceCacheReadPeakPerM, DEFAULT_CONFIG.priceCacheReadPeakPerM);
  assert.equal(s.priceOutputPeakPerM, DEFAULT_CONFIG.priceOutputPeakPerM);
});

test("creditMeterSchema falls back to explicit defaults", () => {
  const defaults = { ...DEFAULT_CONFIG, budget: 99 };
  assert.equal(creditMeterSchema({ budget: 3 }, defaults).budget, 3);
  assert.equal(creditMeterSchema({}, defaults).budget, 99);
});

test("module exports are stable", () => {
  assert.equal(SETTINGS_NS, "dsh-credit-meter");
  assert.deepEqual(CONFIG_KEYS, [
    "enabled",
    "budget",
    "currency",
    "offPeakEnabled",
    "balanceIntervalSec",
    "priceInputPeakPerM",
    "priceCacheReadPeakPerM",
    "priceCacheWritePeakPerM",
    "priceOutputPeakPerM",
  ]);
});

// -- Config schema: what DSH validates the cordis.patch.yml row against and
//    what it turns into the settings namespace the browser half reads.

test("Config is a schemastery schema covering every config key", () => {
  assert.equal(typeof Config, "function");
  assert.equal(typeof Config.toJSON, "function");
  const json = JSON.stringify(Config.toJSON());
  for (const key of CONFIG_KEYS) {
    assert.ok(json.includes('"' + key + '"'), "Config declares `" + key + "`");
  }
});

test("Config marks every field volatile so the settings form exists", () => {
  // DSH publishes a settings namespace only for volatile Config fields: a
  // field without .volatile() never reaches the browser half, and a Config
  // with no volatile field at all yields no namespace (the bug this fixes).
  for (const key of CONFIG_KEYS) {
    assert.equal(Config.dict[key].meta.volatile, true, "`" + key + "` is volatile");
  }
});

test("Config resolves defaults for an empty row config", () => {
  assert.deepEqual(plain(Config({})), DEFAULT_CONFIG);
});

test("Config rejects a mistyped or out-of-range field", () => {
  assert.throws(() => Config({ enabled: "yes" }), /enabled/);
  assert.throws(() => Config({ balanceIntervalSec: 1 }), /balanceIntervalSec/);
});
