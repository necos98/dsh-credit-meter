# Plugin surfaces cheat sheet

Grounded against the SDK installed with **DSH 0.1.1-rc.2**. Copy the snippet
you need into `lib/index.js` (host) or `lib/client.js` (browser half).

## Host: custom tool (`ctx.tools` + `defineTool`)

From `@deepseek-ai/dsh-tools`. `register` returns a disposer; wire it to
`ctx.effect` so removal cleans up.

```js
import { defineTool } from "@deepseek-ai/dsh-tools";

// In apply(ctx):
const dispose = ctx.tools.register(
  defineTool({
    name: "my_plugin_lookup",
    description: "Look something up by query",
    parameters: { query: { type: "string", description: "Search term" } },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args) {
      return "result for " + args.query;
    },
  })
);
ctx.effect(() => dispose, "my-plugin: tool");
```

## Host: HTTP route (`webServer`)

Same pattern as the reference implementation: exact-path route, node http
handler, disposer into `ctx.effect`.

```js
ctx.inject(["webServer"], (serverCtx) => {
  const dispose = serverCtx.webServer.register({
    kind: "exact",
    path: "/my-plugin/ping",
    handler: (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });
  ctx.effect(() => dispose, "my-plugin: route");
});
```

## Host: settings namespace (shared config)

The host owns the schema; the browser half reads/writes it via
`settingsScope`. Schema is a callable with `toJSON` (no schemastery import).

```js
function mySchema(section) {
  const v = section ?? {};
  return { enabled: typeof v.enabled === "boolean" ? v.enabled : true };
}
mySchema.toJSON = () => ({ type: "object", dict: {} });

ctx.inject(["settings"], (settingsCtx) => {
  settingsCtx.settings.register("my-plugin", mySchema);
});
```

## Host ↔ browser: RPC channel (action surface)

The generic RPC channel in `@deepseek-ai/dsh-client-connection` lets the
browser call back into the host and get a result — the "action" counterpart of
the settings namespace's shared config. The host registers a channel; the
browser calls an endpoint on it. The result envelope is validated on both
sides, so the failure shape matters (see the error-code note below).

Host half (`lib/index.js`):

```js
// "connection" is an optional service: inject it like commands below, so a
// composition without client-connection still gets the rest of the plugin.
ctx.inject(["connection"], (connectionCtx) => {
  connectionCtx.connection.rpc.handle(
    "/my-plugin-actions",
    async (endpoint, payload, signal) => {
      if (endpoint !== "install") {
        return {
          ok: false,
          error: { code: "bad-request", message: "unknown endpoint", details: { issues: [] } },
        };
      }
      try {
        const installed = await installSomething(payload);
        return { ok: true, value: installed };
      } catch (error) {
        return { ok: false, error: { code: "internal", message: String(error), details: {} } };
      }
    },
    // REQUIRED options — see the notes below.
    { authority: "loopback" }
  );
});
```

Notes:

- **`options` (the third argument) is required.** `register()` reads
  `options.authority` before anything else; calling `rpc.handle(channel,
  handler)` without it throws `TypeError: Cannot read properties of undefined
  (reading 'authority')` inside the `ctx.inject` child fiber, which fails
  **silently**: the plugin entry stays "active", the route never registers, and
  the SPA fallback answers the browser POST with 405. Always pass
  `{ authority: "loopback" }`, or the serving authority (declared in the
  connection plugin's `trustedHosts` config / `--trusted-host` flag) for
  trusted-host LAN deployments.
- **Channel names** must match `/^\/[A-Za-z0-9._~-]+$/` and must not be
  `/api` (reserved).
- The handler receives `(endpoint, payload, signal)` and must **return** the
  RPC result envelope: `{ ok: true, value }` on success, or
  `{ ok: false, error: { code, message, details } }` on failure.
- **Error codes must be members of `rpcErrorSchema`.** The browser validates
  every response with `rpcResultSchema` (from `@deepseek-ai/dsh-host-apiproxy`
  / `api`), a discriminated union on `code`. Returning a custom code (e.g.
  `"install-failed"`) makes the client reject the response with a confusing
  `invalid_union` error instead of your message. Custom channels should use
  `code: "internal"` with `details: {}`, or `code: "bad-request"` with
  `details: { issues: [] }`.
- **Do not throw from the handler for business errors**: a throw makes the
  host answer HTTP 500 (`handler failure: ...`) and the client sees a
  transport failure, not your error. Return the failure envelope instead.
- `rpc.handle` registers the route (and its removal) through the context's
  effect lifecycle, so no manual cleanup is needed.

Browser half (`lib/client.js`):

- Add `"@deepseek-ai/dsh-client-connection"` to `dsh.client.inject` in
  `package.json` so the module ships in the web bundle, and `"connection"` to
  the client module's `inject` array:

```json
"client": {
  "platform": "web",
  "inject": [
    "@deepseek-ai/dsh-client-runtime",
    "@deepseek-ai/dsh-client-locale",
    "@deepseek-ai/dsh-client-ui-settings",
    "@deepseek-ai/dsh-client-connection"
  ]
}
```

```js
// inject: ["slots", "locale", "settingsScope", "connection"]
const connection = ctx.get("connection");
const result = await connection.rpc.call("/my-plugin-actions", "install", { name: "x" });
if (result.ok) {
  // result.value — the installed thing
} else {
  // result.error — { code, message, details } with a schema-known code
}
```

- `rpc.call(channel, endpoint, payload)` resolves to `{ ok: true, value }` or
  `{ ok: false, error }`; the response is validated against `rpcResultSchema`,
  so the failure envelope must carry a known code (see above).

## Client: UI slots

Slots are injected by name. Common ones (see the web client packages):

```js
// A whole settings tab (label shows in the sidebar of Settings)
slots.inject("settings.section", () =>
  slots.register(
    {
      name: "settings.section",
      id: "my-plugin",
      order: 90,
      label: () => t("section.nav"),
      locale: NS,
      inject: () => ({ scope }),
    },
    MySettingsSection
  )
);

// A compact row at the bottom of the sidebar (rail mode: same component)
slots.inject("sidebar.footer.action", () =>
  slots.register(
    { name: "sidebar.footer.action", id: "my-plugin", order: 90, locale: NS, inject: () => ({ scope }) },
    SidebarFooterRow
  )
);

// A badge next to the current session title
slots.inject("conversation.session.header.utilities", () =>
  slots.register(
    { name: "conversation.session.header.utilities", id: "my-plugin", order: 90, locale: NS, inject: () => ({ scope }) },
    SessionHeaderBadge
  )
);
```

## Client: i18n dictionaries

```js
ctx.effect(
  () =>
    locale.register(NS, {
      en: { "row.title": "My plugin" },
      // Add more locales here as needed.
    }),
  "my-plugin: dictionaries"
);
const t = locale.bind(NS);
```

## Optional injection pattern

Dependencies that may not be mounted get registered conditionally, so a
composition without them still gets the rest of the plugin:

```js
ctx.inject(["commands"], (commandCtx) => {
  commandCtx.commands.register({ /* ... */ });
});
```

## Not covered here

- **Background jobs** — `ctx.jobs.start(spec)`: `@deepseek-ai/dsh-jobs`
- **Schedules** — durable one-shot/fixed-rate reminders: `@deepseek-ai/dsh-schedule`
- **Skills** — `@deepseek-ai/dsh-skill` and `@deepseek-ai/dsh-skill-filesystem`

Check their type declarations in `node_modules/@deepseek-ai/*` for the exact
APIs of your DSH version.
