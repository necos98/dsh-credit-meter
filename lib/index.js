// dsh-credit-meter — host node (Cordis wiring only).
//
// Three host surfaces:
//   1. a settings namespace ("credit-meter") for the web client half, whose
//      defaults come from the deployment config (cordis.patch.yml);
//   2. the HTTP route /credit-meter/balance, which resolves the
//      DEEPSEEK_API_KEY credential and queries the official DeepSeek balance
//      endpoint (handler factory in lib/handlers.js);
//   3. lifecycle hooks.
//
// Pure logic lives in lib/config.js and lib/handlers.js so it can be unit
// tested and eval'd without booting DSH.
// @module dsh-credit-meter

import {
  CONFIG_KEYS,
  DEFAULT_CONFIG,
  NS,
  creditMeterSchema,
  resolveConfig,
  settingsNamespace,
} from "./config.js";
import { BALANCE_PATH, createBalanceHandler } from "./handlers.js";

/** Cordis plugin name. */
export const name = "dsh-credit-meter";

/** No required services: settings, webServer and credentials are optional injections. */
export const inject = [];

/**
 * Plugin body (host).
 * @param ctx - a Cordis context.
 * @param config - the deployment config (cordis.patch.yml), validated at load.
 */
export function apply(ctx, config) {
  // Deployment config is validated at plugin load; its values pre-seed the
  // settings-namespace defaults (values already saved in the profile's
  // settings document take precedence).
  const defaults = resolveConfig(config);

  // 1) Settings namespace for the web client half.
  ctx.inject(["settings"], (settingsCtx) => {
    const schema = (section) => creditMeterSchema(section, defaults);
    schema.toJSON = creditMeterSchema.toJSON;
    settingsCtx.settings.register(settingsNamespace(NS), schema);
  });

  // 2) HTTP route: real DeepSeek account balance. The DEEPSEEK_API_KEY
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

  // 3) Lifecycle hooks.
  ctx.on("ready", () => {
    console.log(
      "[dsh-credit-meter] active (enabled=" + defaults.enabled +
        ", balanceInterval=" + defaults.balanceIntervalSec + "s)"
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
  NS,
  creditMeterSchema,
  resolveConfig,
  settingsNamespace,
};
