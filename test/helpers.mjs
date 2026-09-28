// test/helpers.mjs — micro test framework for DSH plugins.
//
// Zero dependencies: node:test (built-in) runs the tests; this file provides
// the plugin-specific pieces:
//   - createFakeCtx: a fake Cordis ctx that records what apply() registers
//     (webServer routes, lifecycle hooks, effects) so tests can assert on the
//     registrations without booting DSH.
//   - createFakeClientCtx / loadClientModule: fake client services (including
//     the `configForms` settings service) and the window.__ModuleLoader__ shim
//     for the browser half.

import fs from "node:fs";
import vm from "node:vm";

/** Minimal react stub: getSnapshot() is honored so rendered components see
 *  the real config-form/balance-store state. Tests assert registrations and
 *  inspect the recorded element tree ({ __element: [type, props, ...children] }). */
const reactStub = {
  createElement: (...args) => ({ __element: args }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
};

/**
 * Fake `configForms` service: `get(entryId)` returns a ConfigForm whose
 * snapshot mirrors the real `ConfigFormSnapshot` (status/value/base/user/
 * revision/writable/mode), so a test reading more than `.value` cannot pass
 * against a shape production does not have.
 *
 * `get` records every requested entry id in `.requested`, so a test can assert
 * that the client asks for the id the patch row actually composes — a drift
 * there would otherwise leave every test green while Settings silently served
 * defaults.
 * @param initial - the resolved section to start from.
 */
export function createFakeConfigForms(initial = {}) {
  let value = { ...initial };
  const listeners = new Set();
  const state = () => ({
    status: "ready",
    value,
    base: undefined,
    user: value,
    revision: 1,
    writable: true,
    mode: "host",
  });
  const form = {
    getSnapshot: state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(field, next) {
      value = { ...value, [field]: next };
      for (const listener of [...listeners]) listener();
      return Promise.resolve(true);
    },
    unset(field) {
      const next = { ...value };
      delete next[field];
      value = next;
      for (const listener of [...listeners]) listener();
      return Promise.resolve(true);
    },
    mutate() {
      return Promise.resolve(true);
    },
  };
  const requested = [];
  return {
    form,
    requested,
    get(entryId) {
      requested.push(entryId);
      return form;
    },
  };
}

/**
 * Build a fake Cordis context. inject() calls its callback immediately with
 * the fake ctx (services are assumed mounted), so apply() registers
 * everything synchronously and tests can inspect it. A fake `credentials`
 * service is mounted by default and resolves to no key; pass `services` to
 * override it or to add other services.
 */
export function createFakeCtx(services = {}) {
  const ctx = {
    routes: [],
    lifecycle: {},
    effects: [],
    services: { ...services },
    webServer: {
      register: (spec) => {
        ctx.routes.push(spec);
        return () => {
          ctx.routes = ctx.routes.filter((r) => r !== spec);
        };
      },
    },
    on: (event, callback) => {
      (ctx.lifecycle[event] ??= []).push(callback);
    },
    effect: (fn, label) => {
      ctx.effects.push({ fn, label });
      fn(); // Cordis runs effects on registration
    },
    inject: (_deps, callback) => {
      callback(ctx);
    },
    get: (serviceName) => {
      if (serviceName in ctx.services) return ctx.services[serviceName];
      if (serviceName === "credentials") {
        return { resolve: async () => undefined };
      }
      return undefined;
    },
  };
  return ctx;
}

/**
 * Fake client ctx for the browser half: the `configForms` settings service is
 * always mounted (read it back through `ctx.configForms.form`),
 * locale/slots mounted by default (pass false to test the graceful skip).
 */
export function createFakeClientCtx({ settings = {}, locale = true, slots = true } = {}) {
  const ctx = {
    configForms: createFakeConfigForms(settings),
    dictionaries: [],
    slotRegistrations: [],
    effects: [],
    locale: locale
      ? {
          register: (ns, dict) => {
            ctx.dictionaries.push({ ns, dict });
            return () => {};
          },
          bind: (ns) => {
            const found = ctx.dictionaries.find((d) => d.ns === ns);
            const dict = found ? found.dict.en : {};
            return (key) => dict[key] ?? key;
          },
        }
      : undefined,
    slots: slots
      ? {
          inject: (name, factory) => {
            ctx.slotRegistrations.push({ name, factory });
          },
          register: (meta, component) => ({ meta, component }),
        }
      : undefined,
    effect: (fn, label) => {
      ctx.effects.push({ fn, label });
      fn(); // Cordis runs effects on registration
    },
    get: (serviceName) =>
      serviceName === "locale" ? ctx.locale : serviceName === "slots" ? ctx.slots : undefined,
  };
  return ctx;
}

/**
 * Execute lib/client.js inside a fake `window` and return the loaded modules
 * keyed by id. The file is a classic script that calls
 * window.__ModuleLoader__.load({ id, factory }), so it runs under vm.
 * The sandbox forwards the browser globals the client uses (fetch, timers)
 * lazily, so tests can stub globalThis.fetch / globalThis.setInterval per test.
 * @param absolutePath Absolute path to lib/client.js.
 * @returns Map of module id -> exports.
 */
export function loadClientModule(absolutePath) {
  const modules = new Map();
  const window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        const require = (spec) => {
          if (spec === "react") return reactStub;
          throw new Error("Unhandled require in client module: " + spec);
        };
        modules.set(id, factory(require));
      },
    },
  };
  const code = fs.readFileSync(absolutePath, "utf8");
  vm.runInNewContext(
    code,
    {
      window,
      console,
      fetch: (...args) => globalThis.fetch(...args),
      setInterval: (...args) => globalThis.setInterval(...args),
      clearInterval: (handle) => globalThis.clearInterval(handle),
      setTimeout: (...args) => globalThis.setTimeout(...args),
      clearTimeout: (handle) => globalThis.clearTimeout(handle),
    },
    { filename: absolutePath }
  );
  return modules;
}
