// dsh-credit-meter — pure config domain.
//
// resolveConfig, creditMeterSchema and settingsNamespace live here (not in
// index.js) so unit tests and evals can import them without booting Cordis.
// This module must stay free of `ctx` and of package imports.

/** Settings namespace shared with the web client (lib/client.js). */
export const NS = "credit-meter";

/** Accepted config keys, for the unknown-key guard. */
export const CONFIG_KEYS = [
  "enabled",
  "budget",
  "currency",
  "offPeakEnabled",
  "balanceIntervalSec",
  "priceInputPeakPerM",
  "priceCacheReadPeakPerM",
  "priceCacheWritePeakPerM",
  "priceOutputPeakPerM",
];

/**
 * Default settings. Prices are PEAK prices (USD per 1M tokens) from the
 * official DeepSeek pricing page (https://api-docs.deepseek.com/quick_start/pricing/),
 * defaulting to the deepseek-v4-flash preset. During off-peak hours the client
 * half automatically applies the 50% discount.
 */
export const DEFAULT_CONFIG = {
  enabled: true,
  // 0 = no budget: only the total used is shown, the remaining is "—".
  budget: 10,
  currency: "USD",
  // true = apply the off-peak discount (50%) outside the peak windows.
  offPeakEnabled: true,
  // Real-balance refresh interval, in seconds (clamped to 5–3600).
  balanceIntervalSec: 60,
  priceInputPeakPerM: 0.44,
  priceCacheReadPeakPerM: 0.014,
  priceCacheWritePeakPerM: 0,
  priceOutputPeakPerM: 1.32,
};

/**
 * settingsNamespace() in @deepseek-ai/dsh-settings is only a branded string
 * with a validation pattern; inlined so the host module stays free of imports
 * that the profile node_modules might not resolve.
 */
export function settingsNamespace(value) {
  if (!/^[a-z][a-z0-9-]*$/.test(value)) {
    throw new TypeError(
      'settings namespace "' + value + '" must match /^[a-z][a-z0-9-]*$/'
    );
  }
  return value;
}

/** Apply defaults and clamps to one settings/config value (lenient). */
function sanitize(v, defaults) {
  const num = (x, dflt) =>
    typeof x === "number" && Number.isFinite(x) ? x : dflt;
  const price = (x, dflt) => Math.max(0, num(x, dflt));
  const currency =
    typeof v.currency === "string" && v.currency.trim().length > 0
      ? v.currency.trim().slice(0, 8)
      : defaults.currency;
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : defaults.enabled,
    budget: Math.max(0, num(v.budget, defaults.budget)),
    currency,
    offPeakEnabled:
      typeof v.offPeakEnabled === "boolean"
        ? v.offPeakEnabled
        : defaults.offPeakEnabled,
    balanceIntervalSec: Math.min(
      3600,
      Math.max(5, num(v.balanceIntervalSec, defaults.balanceIntervalSec))
    ),
    priceInputPeakPerM: price(v.priceInputPeakPerM, defaults.priceInputPeakPerM),
    priceCacheReadPeakPerM: price(v.priceCacheReadPeakPerM, defaults.priceCacheReadPeakPerM),
    priceCacheWritePeakPerM: price(v.priceCacheWritePeakPerM, defaults.priceCacheWritePeakPerM),
    priceOutputPeakPerM: price(v.priceOutputPeakPerM, defaults.priceOutputPeakPerM),
  };
}

/**
 * Validate deployment-owned config (the `config` block of the cordis.patch.yml
 * row). Missing, mistyped, or unknown fields fail at plugin load rather than
 * being ignored. The validated result pre-seeds the settings-namespace
 * defaults; values already saved in the profile's settings document win.
 * @param config Raw plugin config.
 * @returns A detached validated config with defaults applied.
 */
export function resolveConfig(config = {}) {
  if (typeof config !== "object" || config === null) {
    throw new Error("CreditMeterConfig needs an object");
  }
  const unknown = Object.keys(config).filter((key) => !CONFIG_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new Error(
      "CreditMeterConfig has unknown key(s) " + unknown.join(", ") +
        " — config is { enabled, budget, currency, offPeakEnabled, " +
        "balanceIntervalSec, priceInputPeakPerM, priceCacheReadPeakPerM, " +
        "priceCacheWritePeakPerM, priceOutputPeakPerM }"
    );
  }
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    throw new Error("CreditMeterConfig needs a boolean `enabled`");
  }
  if (
    config.budget !== undefined &&
    (typeof config.budget !== "number" || !Number.isFinite(config.budget))
  ) {
    throw new Error("CreditMeterConfig needs a finite number `budget`");
  }
  if (
    config.currency !== undefined &&
    (typeof config.currency !== "string" || config.currency.trim() === "")
  ) {
    throw new Error("CreditMeterConfig needs a non-empty string `currency`");
  }
  if (
    config.offPeakEnabled !== undefined &&
    typeof config.offPeakEnabled !== "boolean"
  ) {
    throw new Error("CreditMeterConfig needs a boolean `offPeakEnabled`");
  }
  if (
    config.balanceIntervalSec !== undefined &&
    (typeof config.balanceIntervalSec !== "number" ||
      !Number.isFinite(config.balanceIntervalSec))
  ) {
    throw new Error("CreditMeterConfig needs a finite number `balanceIntervalSec`");
  }
  for (const key of [
    "priceInputPeakPerM",
    "priceCacheReadPeakPerM",
    "priceCacheWritePeakPerM",
    "priceOutputPeakPerM",
  ]) {
    if (
      config[key] !== undefined &&
      (typeof config[key] !== "number" || !Number.isFinite(config[key]))
    ) {
      throw new Error("CreditMeterConfig needs a finite number `" + key + "`");
    }
  }
  return sanitize(config, DEFAULT_CONFIG);
}

// Schema of the settings namespace, written as a callable function
// (schemastery schemas are invoked as functions): settings.register(ns, schema)
// resolves the value with schema(section), so a function with toJSON is enough
// and needs no @deepseek-ai/schemastery import.
//
// Lenient on purpose: the persisted settings document may carry orphaned keys
// from older plugin versions (e.g. the v0.1 priceInputPerM fields), which are
// ignored and fall back to the defaults.
export function creditMeterSchema(section, defaults = DEFAULT_CONFIG) {
  return sanitize(section ?? {}, defaults);
}
creditMeterSchema.toJSON = () => ({ type: "object", dict: {} });
