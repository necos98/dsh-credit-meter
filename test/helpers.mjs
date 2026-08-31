// test/helpers.mjs — micro test framework for DSH plugins.
//
// Zero dependencies: node:test (built-in) runs the tests; this file provides
// the plugin-specific pieces:
//   - createFakeCtx: a fake Cordis ctx that records what apply() registers
//     (settings namespaces, webServer routes, lifecycle hooks, effects) so
//     tests can assert on the registrations without booting DSH.
//   - createFakeSettingsScope: fake settings scope with getSnapshot/subscribe/
//     set (set resolves, like the real one).
//   - createFakeClientCtx / loadClientModule: fake client services and the
//     window.__ModuleLoader__ shim for the browser half.

import fs from "node:fs";
import vm from "node:vm";

/** Minimal react stub: getSnapshot() is honored so rendered components see
 *  the real scope/balance-store state. Tests assert registrations and inspect
 *  the recorded element tree ({ __element: [type, props, ...children] }). */
const reactStub = {
  createElement: (...args) => ({ __element: args }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
};

/** Fake settingsScope: bind() returns a scope with getSnapshot/subscribe/set. */
export function createFakeSettingsScope(initial = {}) {
  const state = { value: { ...initial } };
  const listeners = new Set();
  return {
    bind() {
      return this;
    },
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(field, value) {
      state.value = { ...state.value, [field]: value };
      for (const listener of [...listeners]) listener();
      return Promise.resolve();
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
    namespaces: [],
    routes: [],
    lifecycle: {},
    effects: [],
    services: { ...services },
    settings: {
      register: (ns, schema) => {
        ctx.namespaces.push({ ns, schema });
      },
    },
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
 * Fake client ctx for the browser half: settingsScope always mounted,
 * locale/slots mounted by default (pass false to test the graceful skip).
 */
export function createFakeClientCtx({ settings = {}, locale = true, slots = true } = {}) {
  const ctx = {
    settingsScope: createFakeSettingsScope(settings),
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
