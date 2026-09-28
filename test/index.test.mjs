// Unit tests for the host wiring (lib/index.js) run against a fake ctx.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Config, DEFAULT_CONFIG } from "../lib/config.js";
import { apply, name, BALANCE_PATH, SETTINGS_NS, resolveConfig } from "../lib/index.js";
import { createFakeCtx } from "./helpers.mjs";

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

test("module exports the Cordis contract", () => {
  assert.equal(name, "dsh-credit-meter");
  assert.equal(typeof apply, "function");
  // DSH reads the Config schema off the plugin module to validate the row and
  // to publish the settings namespace; without it the entry has no form.
  assert.ok(Config, "Config schema exported");
  assert.equal(typeof Config.toJSON, "function");
});

test("apply registers the balance route and lifecycle hooks", () => {
  const ctx = createFakeCtx();
  apply(ctx, {});
  assert.ok((ctx.lifecycle.ready ?? []).length >= 1);
  assert.ok((ctx.lifecycle.dispose ?? []).length >= 1);
  assert.ok(ctx.effects.length >= 1);
  // The settings namespace is no longer registered by the plugin: DSH derives
  // it from the entry's Config schema, so apply() must not need `ctx.settings`.
  assert.equal(ctx.get("settings"), undefined);
  assert.equal(ctx.namespaces, undefined);
});

test("apply registers the balance route", () => {
  const ctx = createFakeCtx();
  apply(ctx, {});
  assert.equal(ctx.routes.length, 1);
  assert.equal(ctx.routes[0].kind, "exact");
  assert.equal(ctx.routes[0].path, BALANCE_PATH);
  assert.equal(typeof ctx.routes[0].handler, "function");
});

test("the settings namespace id is the patch entry id", () => {
  // Settings writes are addressed by the profile entry id (`entry.options.id`),
  // which is the `id` written in cordis.patch.yml.
  assert.equal(SETTINGS_NS, "dsh-credit-meter");
});

test("SETTINGS_NS matches the inserted row id in cordis.patch.yml", () => {
  // This is the one real drift risk of the entry-keyed settings contract: the
  // browser half asks configForms for SETTINGS_NS, while the harness publishes
  // the namespace under the row id. If they diverge, Settings silently serves
  // the built-in defaults forever and no other test notices.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const patch = fs.readFileSync(
    path.join(here, "..", "cordis.patch.yml"),
    "utf8"
  );
  // Line-ending agnostic: a CRLF checkout would otherwise make `$` never match
  // and this test would silently pass on any drift.
  const ids = [...patch.matchAll(/^ {4}- id: ([^\s\r\n]+)/gm)].map((m) => m[1]);
  assert.deepEqual(
    ids,
    [SETTINGS_NS],
    "exactly one inserted row, and its id is the settings namespace"
  );
  // The module id of the browser half is the same row id, so configForms and
  // the loader agree on one identity.
  assert.equal(SETTINGS_NS, name);
});

test("apply tolerates an absent config block", () => {
  const ctx = createFakeCtx();
  apply(ctx);
  assert.equal(ctx.routes.length, 1);
});

test("Config resolves every field, defaults included", () => {
  assert.deepEqual(plain(Config({})), DEFAULT_CONFIG);
  assert.deepEqual(plain(Config(undefined)), DEFAULT_CONFIG);
});

test("Config keeps explicit values", () => {
  const resolved = plain(Config({ budget: 5, currency: "EUR" }));
  assert.equal(resolved.budget, 5);
  assert.equal(resolved.currency, "EUR");
  assert.equal(resolved.enabled, true, "untouched fields keep their default");
});

test("Config rejects a mistyped field", () => {
  assert.throws(() => Config({ enabled: "yes" }), /enabled/);
  assert.throws(() => Config({ budget: "10" }), /budget/);
});

test("Config rejects an out-of-range value", () => {
  assert.throws(() => Config({ balanceIntervalSec: 1 }), /balanceIntervalSec/);
  assert.throws(() => Config({ balanceIntervalSec: 9999 }), /balanceIntervalSec/);
});

test("Config ignores unknown keys for the values it resolves", () => {
  // Lenient by design: an older settings document may carry orphaned keys
  // (the v0.1 priceInputPerM fields), and the settings form only projects the
  // fields the schema declares. resolveConfig drops them entirely.
  const resolved = plain(Config({ budget: 5, legacyPriceInputPerM: 0.27 }));
  assert.equal(resolved.budget, 5);
  assert.equal(resolveConfig(resolved).legacyPriceInputPerM, undefined);
});
