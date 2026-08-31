// Unit tests for the host wiring (lib/index.js) run against a fake ctx.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../lib/config.js";
import { apply, name, NS, BALANCE_PATH } from "../lib/index.js";
import { createFakeCtx } from "./helpers.mjs";

test("module exports the Cordis contract", () => {
  assert.equal(name, "dsh-credit-meter");
  assert.equal(typeof apply, "function");
});

test("apply registers the settings namespace and lifecycle hooks", () => {
  const ctx = createFakeCtx();
  apply(ctx, {});
  assert.equal(ctx.namespaces.length, 1);
  assert.equal(ctx.namespaces[0].ns, NS);
  assert.equal(typeof ctx.namespaces[0].schema, "function");
  assert.ok((ctx.lifecycle.ready ?? []).length >= 1);
  assert.ok((ctx.lifecycle.dispose ?? []).length >= 1);
  assert.ok(ctx.effects.length >= 1);
});

test("apply registers the balance route", () => {
  const ctx = createFakeCtx();
  apply(ctx, {});
  assert.equal(ctx.routes.length, 1);
  assert.equal(ctx.routes[0].kind, "exact");
  assert.equal(ctx.routes[0].path, BALANCE_PATH);
  assert.equal(typeof ctx.routes[0].handler, "function");
});

test("settings namespace schema resolves client values", () => {
  const ctx = createFakeCtx();
  apply(ctx, {});
  const schema = ctx.namespaces[0].schema;
  const resolved = schema({ budget: 5 });
  assert.equal(resolved.budget, 5);
  assert.equal(resolved.enabled, true);
});

test("patch config pre-seeds the namespace defaults", () => {
  const ctx = createFakeCtx();
  apply(ctx, { budget: 77 });
  const schema = ctx.namespaces[0].schema;
  // no config block -> patch default; the persisted document still wins
  assert.equal(schema({}).budget, 77);
  assert.equal(schema({ budget: 1 }).budget, 1);
});

test("defaults without a config block match DEFAULT_CONFIG", () => {
  const ctx = createFakeCtx();
  apply(ctx);
  const schema = ctx.namespaces[0].schema;
  assert.deepEqual(schema({}), DEFAULT_CONFIG);
});

test("invalid config fails at load", () => {
  const ctx = createFakeCtx();
  assert.throws(() => apply(ctx, { enabled: "yes" }), /boolean `enabled`/);
  assert.throws(() => apply(ctx, { nope: true }), /unknown key\(s\) nope/);
});
