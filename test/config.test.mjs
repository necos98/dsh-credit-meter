// Unit tests for the pure config domain (lib/config.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONFIG_KEYS,
  DEFAULT_CONFIG,
  NS,
  creditMeterSchema,
  resolveConfig,
  settingsNamespace,
} from "../lib/config.js";

test("resolveConfig applies defaults", () => {
  assert.deepEqual(resolveConfig({}), DEFAULT_CONFIG);
  assert.deepEqual(resolveConfig(undefined), DEFAULT_CONFIG);
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

test("resolveConfig rejects unknown keys", () => {
  assert.throws(() => resolveConfig({ nope: 1 }), /unknown key\(s\) nope/);
  // the legacy v0.1 price fields are orphaned settings keys, not config
  assert.throws(() => resolveConfig({ priceInputPerM: 0.27 }), /unknown key\(s\) priceInputPerM/);
});

test("resolveConfig rejects mistyped fields", () => {
  assert.throws(() => resolveConfig({ enabled: "yes" }), /boolean `enabled`/);
  assert.throws(() => resolveConfig({ budget: "10" }), /finite number `budget`/);
  assert.throws(() => resolveConfig({ currency: "  " }), /non-empty string `currency`/);
  assert.throws(() => resolveConfig({ offPeakEnabled: 1 }), /boolean `offPeakEnabled`/);
  assert.throws(() => resolveConfig({ balanceIntervalSec: "60" }), /finite number `balanceIntervalSec`/);
  assert.throws(() => resolveConfig({ priceOutputPeakPerM: "1.32" }), /finite number `priceOutputPeakPerM`/);
});

test("settingsNamespace validates the namespace pattern", () => {
  assert.equal(settingsNamespace(NS), NS);
  assert.throws(() => settingsNamespace("Uppercase!"), /must match/);
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
  assert.equal(NS, "credit-meter");
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
  assert.equal(typeof creditMeterSchema.toJSON, "function");
});
