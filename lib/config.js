// dsh-credit-meter — pure config domain.
//
// DEFAULT_CONFIG, creditMeterSchema and resolveConfig live here (not in
// index.js) so unit tests and evals can import them without booting Cordis.
// This module stays free of `ctx`.

import z from "@deepseek-ai/schemastery";

/**
 * Settings namespace, and the id of the Cordis patch row in
 * cordis.patch.yml. Since DSH 0.1.7-rc.2 the settings document is addressed by
 * the profile entry id (`entry.options.id`), not by a namespace a plugin
 * registers itself: `settings.describe()` publishes one namespace per live
 * entry, keyed by this id, and the browser half reads it with
 * `ctx.configForms.get(SETTINGS_NS)`. The host must therefore export a
 * `Config` schema — only volatile Config fields are exposed as a settings form.
 */
export const SETTINGS_NS = "dsh-credit-meter";

/** Accepted config keys, in the order the settings form presents them. */
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
 * defaulting to the deepseek-flash preset (DeepSeek-V4.1-Flash). During off-peak
 * hours the client half automatically applies the 50% discount.
 *
 * Prices verified against the official page on 2026-09-06: deepseek-flash
 * (DeepSeek-V4.1-Flash) bills $0.30 input (cache miss) / $0.006 cache read /
 * $0 cache write / $1.20 output at peak. The legacy names
 * `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are retired models
 * served and billed at the same Flash price.
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
  priceInputPeakPerM: 0.3,
  priceCacheReadPeakPerM: 0.006,
  priceCacheWritePeakPerM: 0,
  priceOutputPeakPerM: 1.2,
};

/**
 * The cosmokit volatile-reference protocol.
 *
 * Spelled as a `Symbol.for` global rather than by importing `isVolatile` from
 * `@deepseek-ai/cosmokit`: the registry lookup makes the check independent of
 * which copy of the shared library registered it (ESM vs CJS, and the isolated
 * `node_modules` layouts a plugin can be installed under). `@deepseek-ai/cosmokit`
 * is only a transitive dependency of schemastery, so importing it directly would
 * add a second dependency for one boolean check.
 *
 * A `.volatile()` Config field resolves to such a reference, whose value is read
 * through `get()`; DSH can hand that shape to `apply()` when the row's config was
 * resolved by the schema.
 */
const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");

/** @returns whether `value` is a volatile Config reference. */
function isVolatileRef(value) {
  return typeof value === "object" && value !== null && VOLATILE_WRITE in value;
}

/**
 * Replace every volatile reference in a resolved Config section with its value,
 * so ordinary property reads work. Without this a volatile field reads back as
 * the reference object, every type check in {@link sanitize} misses, and the
 * caller silently gets the built-in defaults instead of the configured values.
 * @param value - a resolved Config section (or any resolved Config value).
 * @returns The same shape with plain values.
 */
function unwrapVolatile(value) {
  if (isVolatileRef(value)) return unwrapVolatile(value.get());
  if (Array.isArray(value)) return value.map(unwrapVolatile);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, unwrapVolatile(child)])
    );
  }
  return value;
}

/**
 * Clamp and sanitize a resolved config section, filling missing fields from
 * `defaults`. Lenient on purpose: the persisted settings document may carry
 * orphaned keys from older plugin versions (e.g. the v0.1 `priceInputPerM`
 * fields), which are ignored and fall back to the defaults.
 * @param v - a resolved config section, plain or volatile-wrapped.
 * @param defaults - fallback values for missing or malformed fields.
 * @returns A detached, clamped config section.
 */
function sanitize(v, defaults) {
  const section = unwrapVolatile(v);
  const num = (x, dflt) =>
    typeof x === "number" && Number.isFinite(x) ? x : dflt;
  const price = (x, dflt) => Math.max(0, num(x, dflt));
  const currency =
    typeof section.currency === "string" && section.currency.trim().length > 0
      ? section.currency.trim().slice(0, 8)
      : defaults.currency;
  return {
    enabled:
      typeof section.enabled === "boolean" ? section.enabled : defaults.enabled,
    budget: Math.max(0, num(section.budget, defaults.budget)),
    currency,
    offPeakEnabled:
      typeof section.offPeakEnabled === "boolean"
        ? section.offPeakEnabled
        : defaults.offPeakEnabled,
    balanceIntervalSec: Math.min(
      3600,
      Math.max(
        5,
        num(section.balanceIntervalSec, defaults.balanceIntervalSec)
      )
    ),
    priceInputPeakPerM: price(
      section.priceInputPeakPerM,
      defaults.priceInputPeakPerM
    ),
    priceCacheReadPeakPerM: price(
      section.priceCacheReadPeakPerM,
      defaults.priceCacheReadPeakPerM
    ),
    priceCacheWritePeakPerM: price(
      section.priceCacheWritePeakPerM,
      defaults.priceCacheWritePeakPerM
    ),
    priceOutputPeakPerM: price(
      section.priceOutputPeakPerM,
      defaults.priceOutputPeakPerM
    ),
  };
}

/**
 * Clamp and complete one resolved config section (exposed for the unit tests
 * and for callers that own a resolved section).
 * @param section - a resolved config section (partial or absent).
 * @param defaults - fallback values, defaults to {@link DEFAULT_CONFIG}.
 * @returns A detached, clamped config section.
 */
export function creditMeterSchema(section, defaults = DEFAULT_CONFIG) {
  return sanitize(section ?? {}, defaults);
}

/**
 * Apply defaults and clamps to one config value.
 *
 * The loader already validated and defaulted the row's `config` block against
 * {@link Config} before `apply()` runs, so this only narrows the result for the
 * host's own use (log line) and remains lenient about values a caller passes
 * directly.
 * @param config - the row's config (already resolved, or raw in tests).
 * @returns A detached, clamped config section.
 */
export function resolveConfig(config) {
  if (config === undefined || config === null) return { ...DEFAULT_CONFIG };
  if (typeof config !== "object" || Array.isArray(config)) {
    throw new Error("CreditMeterConfig needs an object");
  }
  return sanitize(config, DEFAULT_CONFIG);
}

/**
 * The plugin's Config schema, exported from the host module as `Config`.
 *
 * Every field is `.volatile()`: that is what makes the entry appear in
 * `settings.describe()` as a live settings namespace and lets Settings write a
 * single field without remounting the plugin. Without at least one volatile
 * field the entry has no form and the browser half finds no namespace.
 *
 * Values are NOT re-validated at write time by this plugin: `sanitize()` still
 * narrows whatever arrives, so a hand-edited settings document cannot push the
 * host into a bad state.
 */
export const Config = z.object({
  /** Toggle every view on/off. */
  enabled: z.boolean().default(DEFAULT_CONFIG.enabled).volatile(),
  /** Credit bought; 0 = no budget, only the total used is shown. */
  budget: z.number().min(0).default(DEFAULT_CONFIG.budget).volatile(),
  /** Display-only currency code. */
  currency: z.string().default(DEFAULT_CONFIG.currency).volatile(),
  /** Halve every price outside the DeepSeek peak windows. */
  offPeakEnabled: z.boolean().default(DEFAULT_CONFIG.offPeakEnabled).volatile(),
  /** Real-balance refresh interval in seconds. */
  balanceIntervalSec: z
    .number()
    .min(5)
    .max(3600)
    .default(DEFAULT_CONFIG.balanceIntervalSec)
    .volatile(),
  /** Input (cache miss) price per 1M tokens, peak. */
  priceInputPeakPerM: z
    .number()
    .min(0)
    .default(DEFAULT_CONFIG.priceInputPeakPerM)
    .volatile(),
  /** Cache read price per 1M tokens, peak. */
  priceCacheReadPeakPerM: z
    .number()
    .min(0)
    .default(DEFAULT_CONFIG.priceCacheReadPeakPerM)
    .volatile(),
  /** Cache write price per 1M tokens, peak. */
  priceCacheWritePeakPerM: z
    .number()
    .min(0)
    .default(DEFAULT_CONFIG.priceCacheWritePeakPerM)
    .volatile(),
  /** Output price per 1M tokens, peak. */
  priceOutputPeakPerM: z
    .number()
    .min(0)
    .default(DEFAULT_CONFIG.priceOutputPeakPerM)
    .volatile(),
});
