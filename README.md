# dsh-credit-meter

A **DSH** (DeepSeek Harness, web profile) plugin that shows:

1. the **REAL remaining DeepSeek account balance** — read on the host via the
   official [`GET https://api.deepseek.com/user/balance`](https://api-docs.deepseek.com/api/get-user-balance/)
   endpoint with your `DEEPSEEK_API_KEY` (the key never leaves the host) — in a
   line always visible at the bottom of the sidebar; when the balance is not
   reachable it falls back to the budget − spend estimate;
2. the **estimated credit used per session**:
   - a badge next to the open session's title (updated live),
   - a full table in **Settings → Credits** with the estimated cost (and
     tokens) of **all** sessions.

Built on the [dsh-plugin-template](https://github.com/necos98/dsh-plugin-template)
skeleton: host wiring in `lib/index.js`, pure config/handler logic in
`lib/config.js` / `lib/handlers.js`, the browser half in `lib/client.js`, a
zero-dependency unit-test suite and a micro eval framework.

## Real data vs estimates

| Request | Type | How |
| --- | --- | --- |
| **Remaining credit (account balance)** | ✅ **REAL** | The host exposes the route `/credit-meter/balance`, which calls the official DeepSeek `user/balance` endpoint with your `DEEPSEEK_API_KEY` (via `ctx.credentials`). 30s cache. If the key is missing or the network fails, the plugin falls back to the estimate. |
| **Credit used per session** | ⚠️ **ESTIMATE** | DSH tracks the `tokenUsage` projection per session (REAL provider tokens: `uncachedInputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`) — but the API does not expose per-request spend, so the cost = tokens × **configurable prices**. |

> **Prices = official DeepSeek pricing** ([`quick_start/pricing`](https://api-docs.deepseek.com/quick_start/pricing/)),
> as **PEAK** prices (USD per 1M tokens):
>
> | Model | Input (cache miss) peak | Cache read peak | Output peak |
> | --- | --- | --- | --- |
> | deepseek-v4-flash | 0.44 | 0.014 | 1.32 |
> | deepseek-v4-pro | 1.32 | 0.044 | 3.96 |
> | deepseek-v4-flash-vision-exp | 0.44 | 0.014 | 1.32 |
>
> **Peak hours**: 01:00–04:00 and 06:00–10:00 UTC, Mon–Fri. In **off-peak** the
> prices are halved and the plugin applies the discount **automatically**
> ("Off-peak discount (50%)" toggle in the settings). A **badge** always shows
> whether you are in `peak` (amber) or `off-peak` (green): at the bottom of the
> sidebar and in Settings → Credits. The **"Model prices"** selector applies
> the three model presets (or custom prices).

## What it shows

| Where | What |
| --- | --- |
| **Sidebar, at the bottom** (next to Settings) | "Remaining credit · real balance" with the amount from the DeepSeek balance, **peak/off-peak badge**, mini bar of the estimated spend and total used; in rail mode a compact pill. "estimate" label when the real balance is not available. |
| **Open session header** | Badge `≈ $0.42` — estimated credit used by that session |
| **Settings → Credits** | **"Account balance (DeepSeek)"** card (balance, availability, update time, Refresh button) + estimate card (est. remaining / used / budget / sessions) + per-session table + configuration (enabled, budget, currency, model preset, prices) |

## Structure

| Path | Role |
|---|---|
| `lib/index.js` | **Host** wiring (Cordis): `Config` schema (the settings namespace), `/credit-meter/balance` HTTP route, lifecycle hooks. |
| `lib/config.js` | Pure config domain: `DEFAULT_CONFIG`, `creditMeterSchema`, `resolveConfig`, the `Config` schema and the settings namespace id. Unit-tested directly. |
| `lib/handlers.js` | Pure handlers: the `createBalanceHandler` factory (DeepSeek balance fetch + cache). Unit-tested directly. |
| `lib/client.js` | **Browser** half (web): cost math, peak/off-peak logic, real-balance polling, three UI slots, i18n dictionaries. |
| `test/helpers.mjs` | Micro test framework: fake `ctx`, fake client services (including `configForms`), `window.__ModuleLoader__` shim. |
| `test/*.test.mjs` | Unit tests: config domain, host wiring, balance handler, browser half. |
| `eval/framework.mjs` + `eval/run.mjs` | Micro eval framework: behavior evals (free) + LLM evals (opt-in). |
| `eval/cases/` | Eval cases (behavior). |
| `docs/surfaces.md` | Copy-paste snippets for extra surfaces (tool, HTTP route, UI slots, host↔browser RPC channel). |
| `cordis.patch.yml` | Row that inserts the plugin into the profile; config defaults are changed here (or in the profile's own `cordis.patch.yml`, which takes precedence). |
| `package.json` | `exports` (`.` + `./client` + `./cordis.patch.yml`), `dsh.bundle.patch`, `dsh.client`, scripts (`check`, `test`, `eval`, `eval:llm`). |

## Installation

From the profile that runs the web app (the folder where `dsh` boots):

```sh
# 1. install the package in the profile (pnpm must be on PATH or use corepack)
dsh plugin add "file:C:/Users/jacob/Desktop/dsh-plugins/dsh-credit-meter"

# 2. restart dsh web (stop and relaunch; on the next start the client bundle is served)
```

The plugin ships its own `cordis.patch.yml` (declared via `dsh.bundle.patch`),
so it registers itself as a profile layer — **no manual row needed** in the
profile's `cordis.patch.yml`. If you previously added a manual
`credit-meter` row there (older versions), remove it: the row targets the
composed id `dsh-credit-meter` now, and keeping both would insert the plugin
twice.

## Settings

Open **Settings → Credits**:

- **Enabled** — toggle all the views on/off (default: on)
- **Budget** — the credit you bought (0 = no budget: only the total used is shown)
- **Currency** — ISO code (USD/EUR/…), display only
- **Balance refresh (s)** — how often the real balance is re-fetched (5–3600)
- **Model prices (peak)** — deepseek-v4-flash / deepseek-v4-pro /
  deepseek-v4-flash-vision-exp presets, or **custom**: **Input /1M**,
  **Cache read /1M**, **Cache write /1M**, **Output /1M** — prices per million
  tokens
- **Off-peak discount (50%)** — halve all prices outside the peak windows

Preferences are saved in the host's settings document, in the namespace keyed
by this plugin's profile entry id: **`dsh-credit-meter`**. The `config` block of
`cordis.patch.yml` pre-seeds the defaults for fresh installs; the persisted
document always wins.

The namespace is not registered by the plugin: since **DSH 0.1.7-rc.2** a
plugin declares its preferences as a `Config` schema (exported from
`lib/index.js`) and the harness exposes the **volatile** fields of every live
entry as that entry's settings form. The browser half reads and writes it
through the `configForms` service (`ctx.configForms.get("dsh-credit-meter")`);
it no longer injects `settingsScope`. The former
`ctx.settings.register(ns, schema)` host call does not exist any more, and a
`Config` schema with no `.volatile()` field produces **no** settings namespace
at all — which is what left the client half `pending (waiting for service:
settingsScope)`.

## Compatibility

Built and verified against **DSH 0.1.7-rc.2**. Peer dependency ranges:

| Package | Range |
|---|---|
| `@deepseek-ai/schemastery` | `~3.18.4` |
| `@deepseek-ai/cordis` | `~4.0.4` |

`schemastery` is the one runtime dependency (`Config` is a schemastery schema);
the rest of the plugin is dependency-free. Client modules are injected by name
(`dsh.client.inject`) and resolved from the web app bundle, so they need no
version pin.

## Testing

```
npm ci            # needed once: Config is a schemastery schema
npm test          # node --test
npm run check     # node --check on every JS/MJS file
```

New tests are just files named `*.test.mjs` under `test/`.

## Evals

```
npm run eval         # behavior evals (deterministic, free)
npm run eval:llm     # + LLM evals (needs DEEPSEEK_API_KEY, costs tokens)
```

- **Behavior evals** (`eval/cases/behavior.mjs`): scenario checks that run
  `apply()` against the fake ctx — e.g. "the balance route answers
  no-credential without a key", "the route returns the real balance with a
  credential", "the route caches and honors `?ttl=`". Free, CI-safe.
- **LLM evals**: supported by the framework (`eval/framework.mjs`); add cases
  under `eval/cases/` and run them with `npm run eval:llm`.

## CI

`.github/workflows/ci.yml` runs `npm run check`, `npm test` and `npm run eval`
on every push and pull request — free, no tokens.

## Dev loop

From the profile that runs the web app:

```
dsh plugin add .            # self-link from the plugin checkout
dsh plugin list
```

Edit `lib/*.js` and `cordis.patch.yml`, then restart the profile process
(the web client hot-reloads via `dsh-plugin-hmr`). To remove:

```
dsh plugin remove dsh-credit-meter
```

## Cordis patch rows: entry ids vs `options.id`

The loader prefixes every entry id with its tree namespace: an entry mounted
through an include shows up in runtime logs and loader APIs as
`include:dsh-credit-meter`. A patch row, however, must target the entry's
**composed id** — the `id` written in the entry list (`dsh-credit-meter`),
i.e. `entry.options.id`:

```yaml
- id: dsh-credit-meter
  disabled: true
```

Writing the namespaced id (`include:dsh-credit-meter`) matches nothing: the
include logs `patch: entry not found` and skips the row, so it silently does
nothing.

## Notes

- The cost is **estimated**: it is based on the provider-declared tokens and on
  the prices you configure; it is not an invoice.
- The data comes from the `tokenUsage` projection (the whole session log), so
  it includes compacted turns too.
- Everything runs in the browser (no network logs): the only host
  communication is the settings namespace and the `/credit-meter/balance`
  route.
- The table lists the non-blank sessions, ordered by decreasing cost.

## Removal

```sh
dsh plugin remove dsh-credit-meter
# restart dsh web
```
