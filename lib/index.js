// dsh-credit-meter — host node (Cordis wiring only).
//
// Three host surfaces:
//   1. the plugin's Config schema (see lib/config.js), exported as `Config`;
//      DSH 0.1.7-rc.2 turns the volatile fields of a live entry into a settings
//      namespace keyed by the profile entry id (`dsh-credit-meter`), which the
//      web client half reads and writes through `ctx.configForms` (the older
//      `settings.register(ns, schema)` / `ctx.settingsScope` pair is gone);
//   2. the HTTP route /credit-meter/balance, which resolves the
//      DEEPSEEK_API_KEY credential and queries the official DeepSeek balance
//      endpoint (handler factory in lib/handlers.js);
//   3. lifecycle hooks.
//
// Pure logic lives in lib/config.js and lib/handlers.js so it can be unit
// tested and eval'd without booting DSH.
// @module dsh-credit-meter

import {
  Config,
  CONFIG_KEYS,
  DEFAULT_CONFIG,
  SETTINGS_NS,
  creditMeterSchema,
  resolveConfig,
} from "./config.js";
import { BALANCE_PATH, createBalanceHandler } from "./handlers.js";

/** Cordis plugin name. */
export const name = "dsh-credit-meter";

/** No required services: webServer and credentials are optional injections. */
export const inject = [];

/**
 * Plugin body (host).
 * @param ctx - a Cordis context.
 * @param config - the row's Config, validated and defaulted against
 *   {@link Config} by the loader before activation.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);

  // 1) HTTP route: real DeepSeek account balance. The DEEPSEEK_API_KEY
  //    credential is resolved per request and never leaves the host.
  ctx.inject(["webServer"], (serverCtx) => {
    const handler = createBalanceHandler({
      credentials: () => serverCtx.get("credentials"),
    });
    const dispose = serverCtx.webServer.register({
      kind: "exact",
      path: BALANCE_PATH,
      handler,
    });
    ctx.effect(() => dispose, "dsh-credit-meter: balance route");
  });

  // 2) Lifecycle hooks.
  ctx.on("ready", () => {
    console.log(
      "[dsh-credit-meter] active (enabled=" + resolved.enabled +
        ", balanceInterval=" + resolved.balanceIntervalSec + "s)"
    );
  });
  ctx.on("dispose", () => {
    console.log("[dsh-credit-meter] removed");
  });
}

export {
  BALANCE_PATH,
  CONFIG_KEYS,
  DEFAULT_CONFIG,
  SETTINGS_NS,
  creditMeterSchema,
  resolveConfig,
};
