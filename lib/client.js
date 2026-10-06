// dsh-credit-meter — browser half (web).
//
// Shows:
//  1. sidebar footer (`sidebar.footer.action`): the REAL remaining credit
//     (account balance read on the host via api.deepseek.com/user/balance)
//     with a mini bar of the estimated spend; when the real balance is not
//     available it falls back to the budget − spend estimate. In rail mode a
//     compact pill.
//  2. current session header (`conversation.session.header.utilities`): a
//     badge with the estimated credit used by that session, read live from
//     the `tokenUsage` projection (framework hook seat `useProjection`).
//  3. a "Credits" settings section (`settings.section`): real balance with a
//     refresh button, estimate summary, a table with the estimated credit
//     used by EVERY session, and the controls for budget, currency, prices
//     and the model preset.
//
// Real data vs estimates:
//  - REMAINING CREDIT: REAL — the host exposes /credit-meter/balance, which
//    calls the official DeepSeek endpoint with your DEEPSEEK_API_KEY.
//  - COST PER SESSION: ESTIMATE — real provider tokens × configurable prices
//    (the API does not expose per-request spend).
//
// The factory is CommonJS-style on purpose: the client bundle is loaded by
// window.__ModuleLoader__ and gets react through require(), not import.
// No build step: this file is served as-is.

window.__ModuleLoader__.load({
  id: "dsh-credit-meter",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");

    // #region configuration (defaults + settings namespace)
    // Locale/UI namespace: the i18n dictionary key and the slot id prefix.
    const NS = "credit-meter";
    // Settings namespace: the id of this plugin's Cordis patch row
    // (cordis.patch.yml). Since DSH 0.1.7-rc.2 a plugin does not register a
    // namespace itself — `settings.describe()` publishes one namespace per live
    // entry, keyed by the entry id, and the host half's volatile `Config` fields
    // are what appear in it. The browser half reads and writes it through
    // `ctx.configForms.get(SETTINGS_NS)`; the former `settingsScope` service and
    // `settings.register(ns, schema)` no longer exist.
    const SETTINGS_NS = "dsh-credit-meter";
    // PEAK prices per 1M tokens — official DeepSeek pricing
    // (https://api-docs.deepseek.com/quick_start/pricing/), default deepseek-flash
    // (DeepSeek-V4.1-Flash). Prices verified against the official page on 2026-09-06.
    const DEFAULT_CONFIG = {
      enabled: true,
      budget: 10,
      currency: "USD",
      offPeakEnabled: true,
      balanceIntervalSec: 60,
      priceInputPeakPerM: 0.3,
      priceCacheReadPeakPerM: 0.006,
      priceCacheWritePeakPerM: 0,
      priceOutputPeakPerM: 1.2,
    };

    let config = { ...DEFAULT_CONFIG };

    function readConfig(snapshot) {
      const v = snapshot.value ?? {};
      const num = (x, dflt) =>
        typeof x === "number" && Number.isFinite(x) ? x : dflt;
      const price = (x, dflt) => Math.max(0, num(x, dflt));
      config = {
        enabled: v.enabled !== false,
        budget: Math.max(0, num(v.budget, DEFAULT_CONFIG.budget)),
        currency:
          typeof v.currency === "string" && v.currency.trim().length > 0
            ? v.currency.trim().slice(0, 8)
            : DEFAULT_CONFIG.currency,
        offPeakEnabled: v.offPeakEnabled !== false,
        balanceIntervalSec: Math.min(3600, Math.max(5, num(v.balanceIntervalSec, DEFAULT_CONFIG.balanceIntervalSec))),
        priceInputPeakPerM: price(v.priceInputPeakPerM, DEFAULT_CONFIG.priceInputPeakPerM),
        priceCacheReadPeakPerM: price(v.priceCacheReadPeakPerM, DEFAULT_CONFIG.priceCacheReadPeakPerM),
        priceCacheWritePeakPerM: price(v.priceCacheWritePeakPerM, DEFAULT_CONFIG.priceCacheWritePeakPerM),
        priceOutputPeakPerM: price(v.priceOutputPeakPerM, DEFAULT_CONFIG.priceOutputPeakPerM),
      };
    }
    // #endregion

    // #region DeepSeek peak/off-peak windows (UTC)
    // Peak: 01:00-04:00 and 06:00-10:00 UTC, Mon-Fri, EXCLUDING Chinese public
    // holidays (holidays are off-peak in full). Off-peak = 50% of the peak
    // prices (official pricing page).
    const PEAK_WINDOWS = [
      [1, 4],
      [6, 10],
    ];

    // Chinese public holidays (Beijing calendar days, "YYYY-MM-DD").
    // Source: State Council notice 国办发明电〔2025〕7号 (published 2025-11-04),
    // https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm.
    // Covers the 2026 notice windows in full:
    //  New Year      2026-01-01..03
    //  Spring Festival 2026-02-15..23
    //  Qingming      2026-04-04..06
    //  Labor Day     2026-05-01..05
    //  Dragon Boat   2026-06-19..21
    //  Mid-Autumn    2026-09-25..27
    //  National Day  2026-10-01..07
    // (Weekends inside the ranges are harmless: only weekday days change behaviour.)
    // Maintenance: add the next year's table when the State Council publishes it
    // (typically November); unlisted years fall back to the weekday-only peak logic.
    const CHINESE_HOLIDAYS = new Set([
      "2026-01-01", "2026-01-02", "2026-01-03",
      "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20",
      "2026-02-21", "2026-02-22", "2026-02-23",
      "2026-04-04", "2026-04-05", "2026-04-06",
      "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
      "2026-06-19", "2026-06-20", "2026-06-21",
      "2026-09-25", "2026-09-26", "2026-09-27",
      "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07",
    ]);

    /** Beijing calendar day ("YYYY-MM-DD") of an instant; "" when it cannot be
     *  parsed (an invalid instant never matches a holiday). */
    function beijingDay(t) {
      const d = t instanceof Date ? t : new Date(t);
      const ms = d.getTime();
      if (ms === undefined || !Number.isFinite(ms)) return "";
      return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
    }

    function isPeakAt(date) {
      const d = date instanceof Date ? date : new Date(date);
      if (d instanceof Date && Number.isNaN(d.getTime())) return false; // invalid instant: not peak
      const day = d.getUTCDay();
      if (day === 0 || day === 6) return false; // weekends are always off-peak
      if (CHINESE_HOLIDAYS.has(beijingDay(d))) return false; // holidays are off-peak in full
      const h = d.getUTCHours() + d.getUTCMinutes() / 60;
      return PEAK_WINDOWS.some(([a, b]) => h >= a && h < b);
    }

    function currentPeriod() {
      return isPeakAt(Date.now()) ? "peak" : "off-peak";
    }

    /** Price factor for the given instant (1 in peak, 0.5 in off-peak when enabled). */
    function priceFactor(at) {
      if (!config.offPeakEnabled) return 1;
      return isPeakAt(at ?? Date.now()) ? 1 : 0.5;
    }
    // #endregion

    // #region calculations and formatting (pure, exposed in exports.internals)
    const CURRENCY_SYMBOLS = {
      USD: "$",
      EUR: "€",
      GBP: "£",
      JPY: "¥",
      CNY: "¥",
      CAD: "CA$",
      AUD: "A$",
      CHF: "CHF ",
      SEK: "kr ",
      NOK: "kr ",
      DKK: "kr ",
    };

    function moneySymbol(currency) {
      const c = currency ?? "USD";
      return CURRENCY_SYMBOLS[c] ?? c + " ";
    }

    /** Cost with an explicit price factor (1 = peak, 0.5 = off-peak). */
    function tokenCostWithFactor(tu, factor) {
      if (tu === undefined || tu === null) return null;
      const p = config;
      return (
        ((tu.uncachedInputTokens ?? 0) / 1e6) * p.priceInputPeakPerM +
        ((tu.cacheReadTokens ?? 0) / 1e6) * p.priceCacheReadPeakPerM +
        ((tu.cacheWriteTokens ?? 0) / 1e6) * p.priceCacheWritePeakPerM +
        ((tu.outputTokens ?? 0) / 1e6) * p.priceOutputPeakPerM
      ) * factor;
    }

    /** Estimated cost in currency units for a tokenUsage projection; null if absent.
     *  The prices in config are PEAK: in off-peak the 0.5 factor applies.
     *  @param tu - tokenUsage projection.
     *  @param at - instant (ms or Date) to compute the period for; default: now.
     */
    function tokenCost(tu, at) {
      if (tu === undefined || tu === null) return null;
      return tokenCostWithFactor(tu, priceFactor(at));
    }

    function formatMoney(n) {
      if (typeof n !== "number" || !Number.isFinite(n)) return "—";
      return moneySymbol(config.currency) + n.toFixed(2);
    }

    /** Format an amount in an explicit currency (e.g. the real API balance). */
    function formatBalance(n, currency) {
      if (typeof n !== "number" || !Number.isFinite(n)) return "—";
      return moneySymbol(currency) + n.toFixed(2);
    }

    function formatCompact(n, currency) {
      if (typeof n !== "number" || !Number.isFinite(n)) return "—";
      return moneySymbol(currency ?? config.currency) + (n < 10 ? n.toFixed(1) : Math.round(n).toLocaleString());
    }

    /** Ultra-compact version for the rail pill (collapsed sidebar). */
    function formatRail(n, currency) {
      if (typeof n !== "number" || !Number.isFinite(n)) return "—";
      const sym = moneySymbol(currency ?? config.currency);
      if (n < 1000) return sym + (n < 10 ? n.toFixed(1) : String(Math.round(n)));
      const k = n / 1000;
      return sym + (k < 100 ? k.toFixed(1) + "K" : Math.round(k) + "K");
    }

    /** Compact token counter: 517 / 12.2K / 123K / 1.2M (one decimal below three digits). */
    function formatTokens(n) {
      if (typeof n !== "number" || !Number.isFinite(n)) return "—";
      if (n < 1000) return String(Math.round(n));
      if (n < 1e6) {
        const k = n / 1e3;
        return (k < 100 ? k.toFixed(1) : String(Math.round(k))) + "K";
      }
      return (n / 1e6).toFixed(1) + "M";
    }

    /** Sum of the estimated cost over all sessions in the list store. */
    function totalsFromList(state) {
      return totalsFromListFactor(state, priceFactor());
    }

    /** Like totalsFromList but with an explicit price factor (1 peak, 0.5 off-peak). */
    function totalsFromListFactor(state, factor) {
      let used = 0;
      let withUsage = 0;
      for (const id of state.ids ?? []) {
        const c = tokenCostWithFactor(state.byId?.[id]?.projectionValues?.tokenUsage, factor);
        if (c !== null) {
          used += c;
          withUsage += 1;
        }
      }
      return { used, withUsage };
    }

    /** Session row for the table: title, tokens, cost. */
    function rowsFromList(state) {
      const rows = [];
      for (const id of state.ids ?? []) {
        const s = state.byId?.[id];
        if (s === undefined || s.blank === true) continue;
        const tu = s.projectionValues?.tokenUsage;
        const cost = tokenCost(tu);
        rows.push({
          id,
          title: s.displayTitle ?? s.title ?? id,
          usage: tu,
          cost,
          hasUsage: cost !== null,
        });
      }
      rows.sort((a, b) => {
        if (a.hasUsage !== b.hasUsage) return a.hasUsage ? -1 : 1;
        return (b.cost ?? 0) - (a.cost ?? 0);
      });
      return rows;
    }
    // #endregion

    // #region model price presets — official DeepSeek pricing
    // (https://api-docs.deepseek.com/quick_start/pricing/), USD / 1M tokens,
    // PEAK prices (in off-peak the plugin automatically applies the 50%).
    // Prices verified against the official page on 2026-09-06.
    //
    // The legacy keys (deepseek-v4-flash, deepseek-v4-flash-vision-exp) are
    // RETIRED model names still accepted by the API, billed at the
    // deepseek-flash price; they stay in the map only so persisted selections
    // resolve — presetOf() returns the FIRST exact match, so "deepseek-flash"
    // is listed before them.
    const MODEL_PRESETS = {
      "deepseek-flash": {
        label: "deepseek-flash (V4.1-Flash)",
        priceInputPerM: 0.3,
        priceCacheReadPerM: 0.006,
        priceCacheWritePerM: 0,
        priceOutputPerM: 1.2,
      },
      "deepseek-v4-pro": {
        label: "deepseek-v4-pro",
        priceInputPerM: 1.32,
        priceCacheReadPerM: 0.044,
        priceCacheWritePerM: 0,
        priceOutputPerM: 3.96,
      },
      "deepseek-v4-flash": {
        label: "deepseek-v4-flash (legacy, billed at deepseek-flash price)",
        priceInputPerM: 0.3,
        priceCacheReadPerM: 0.006,
        priceCacheWritePerM: 0,
        priceOutputPerM: 1.2,
      },
      "deepseek-v4-flash-vision-exp": {
        label: "deepseek-v4-flash-vision-exp (legacy, billed at deepseek-flash price)",
        priceInputPerM: 0.3,
        priceCacheReadPerM: 0.006,
        priceCacheWritePerM: 0,
        priceOutputPerM: 1.2,
      },
    };

    /** Detect the preset matching the current prices (or "custom"). */
    function presetOf(prices) {
      const near = (a, b) => Math.abs(a - b) < 1e-9;
      for (const key of Object.keys(MODEL_PRESETS)) {
        const p = MODEL_PRESETS[key];
        if (
          near(prices.priceInputPerM, p.priceInputPerM) &&
          near(prices.priceCacheReadPerM, p.priceCacheReadPerM) &&
          near(prices.priceCacheWritePerM, p.priceCacheWritePerM) &&
          near(prices.priceOutputPerM, p.priceOutputPerM)
        ) {
          return key;
        }
      }
      return "custom";
    }
    // #endregion

    // #region real-balance store (fetch toward the host route /credit-meter/balance)
    const balanceStore = {
      state: { status: "loading", payload: null, lastError: null },
      listeners: new Set(),
      timer: null,
      intervalSec: DEFAULT_CONFIG.balanceIntervalSec,
      getSnapshot: () => balanceStore.state,
      subscribe: (listener) => {
        balanceStore.listeners.add(listener);
        return () => balanceStore.listeners.delete(listener);
      },
      notify: () => {
        for (const l of balanceStore.listeners) l();
      },
      /** Balance state: { ok, balance, currency, isAvailable, fetchedAt } | { ok:false, error, message }. */
      async refresh() {
        balanceStore.state = { ...balanceStore.state, status: "loading" };
        balanceStore.notify();
        let data = null;
        try {
          // ttl = the configured interval: asks the host to bypass its cache
          // and really query DeepSeek on every poll.
          const res = await fetch(
            "/credit-meter/balance?ttl=" + encodeURIComponent(balanceStore.intervalSec),
            { cache: "no-store" }
          );
          data = await res.json().catch(() => null);
        } catch (error) {
          balanceStore.state = {
            status: "error",
            payload: null,
            lastError: error instanceof Error ? error.message : String(error),
          };
          balanceStore.notify();
          return;
        }
        if (data === null || data.ok !== true) {
          balanceStore.state = {
            status: "error",
            payload: null,
            lastError:
              data !== null && data.message ? String(data.message) : "invalid response",
          };
        } else {
          balanceStore.state = { status: "ok", payload: data, lastError: null };
        }
        balanceStore.notify();
      },
      /** Start polling with the given interval (seconds). */
      start(intervalSec) {
        balanceStore.intervalSec = Math.min(3600, Math.max(5, intervalSec));
        if (balanceStore.timer !== null) clearInterval(balanceStore.timer);
        balanceStore.refresh();
        balanceStore.timer = setInterval(() => balanceStore.refresh(), balanceStore.intervalSec * 1000);
      },
      /** Re-arm the polling at a new configured interval (no immediate re-fetch). */
      reschedule(intervalSec) {
        const sec = Math.min(3600, Math.max(5, intervalSec));
        if (sec === balanceStore.intervalSec) return;
        balanceStore.intervalSec = sec;
        if (balanceStore.timer !== null) {
          clearInterval(balanceStore.timer);
          balanceStore.timer = setInterval(() => balanceStore.refresh(), balanceStore.intervalSec * 1000);
        }
      },
      stop() {
        if (balanceStore.timer !== null) {
          clearInterval(balanceStore.timer);
          balanceStore.timer = null;
        }
      },
    };

    /** Hook: read the real-balance state (re-renders when a fetch completes). */
    function useBalance() {
      return React.useSyncExternalStore(balanceStore.subscribe, balanceStore.getSnapshot);
    }

    /** Usable real balance, or null when not available. */
    function realBalanceOf(balance) {
      if (balance === null || balance === undefined) return null;
      if (balance.status !== "ok" || balance.payload === null) return null;
      const p = balance.payload;
      if (p.ok !== true || typeof p.balance !== "number") return null;
      return { amount: p.balance, currency: p.currency ?? "USD", isAvailable: p.isAvailable === true, fetchedAt: p.fetchedAt };
    }
    // #endregion

    // #region styles (single <style> tag, _crdt prefix)
    const css =
      "._crdtRow{box-sizing:border-box;border-top:1px solid var(--dsw-alias-border-l2);flex:none;align-items:center;gap:8px;width:100%;min-width:0;padding:8px 10px;display:flex;overflow:hidden}" +
      "._crdtBody{flex-direction:column;flex:1;min-width:0;gap:2px;display:flex}" +
      "._crdtLabel{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:nowrap}" +
      "._crdtPeriodLine{align-items:center;gap:8px;display:flex}" +
      "._crdtPeriod{gap:4px;align-items:center;color:var(--dsw-alias-label-secondary);font-size:10px;line-height:14px;display:inline-flex;white-space:nowrap}" +
      "._crdtDot{border-radius:50%;width:6px;height:6px;flex:none}" +
      "._crdtPeriodPeak ._crdtDot{background:var(--dsw-alias-state-warn-primary)}" +
      "._crdtPeriodOff ._crdtDot{background:var(--dsw-alias-state-success-primary)}" +
      "._crdtValue{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:20px;white-space:nowrap}" +
      "._crdtBar{background:var(--dsw-alias-border-l2);border-radius:2px;height:4px;width:100%;overflow:hidden}" +
      "._crdtBarFill{background:var(--dsw-alias-brand-primary);border-radius:2px;height:100%;transition:width .2s}" +
      "._crdtRail{box-sizing:border-box;cursor:pointer;border-radius:18px;min-width:36px;height:36px;padding:0 8px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);align-items:center;justify-content:center;margin:4px 0;font-size:11px;font-weight:600;display:flex;white-space:nowrap}" +
      "._crdtRail:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
      "._crdtBadge{gap:4px;align-items:center;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;height:22px;padding:0 8px;font-size:12px;line-height:18px;display:flex;white-space:nowrap}" +
      "._crdtBadge b{color:var(--dsw-alias-label-primary);font-weight:500}" +
      "._crdtSection{flex-direction:column;gap:16px;padding:20px;display:flex;overflow:auto}" +
      "._crdtCard{background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;flex-direction:column;gap:10px;padding:14px;display:flex}" +
      "._crdtCardHead{align-items:baseline;gap:8px;display:flex}" +
      "._crdtCardTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}" +
      "._crdtCardSub{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}" +
      "._crdtStat{flex-direction:column;gap:2px;display:flex}" +
      "._crdtStatValue{color:var(--dsw-alias-label-primary);font-size:20px;font-weight:600;line-height:28px}" +
      "._crdtStats{gap:24px;display:flex;flex-wrap:wrap}" +
      "._crdtField{flex-direction:column;gap:4px;display:flex}" +
      "._crdtFieldRow{gap:16px;flex-wrap:wrap;align-items:flex-end;display:flex}" +
      "._crdtLabel2{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}" +
      "._crdtInput{box-sizing:border-box;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;height:30px;padding:0 8px;font-family:inherit;font-size:13px;line-height:20px;width:110px}" +
      "._crdtInput:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}" +
      "._crdtSelect{box-sizing:border-box;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;height:30px;padding:0 6px;font-family:inherit;font-size:13px;line-height:20px;width:190px}" +
      "._crdtSelect:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}" +
      "._crdtRefresh{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;flex:none;height:28px;padding:0 12px;margin-left:auto;font-size:12px;line-height:18px;transition:background .15s}" +
      "._crdtRefresh:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
      "._crdtRefresh:disabled{opacity:.5;cursor:default}" +
      "._crdtGrid{min-width:0;overflow:auto;max-height:340px}" +
      "._crdtTable{width:100%;border-collapse:collapse;font-size:12px;line-height:18px}" +
      "._crdtTable th{color:var(--dsw-alias-label-tertiary);text-align:left;font-weight:400;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);white-space:nowrap}" +
      "._crdtTable td{color:var(--dsw-alias-label-primary);padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}" +
      "._crdtTable td._crdtNum{text-align:right;font-variant-numeric:tabular-nums}" +
      "._crdtTable th._crdtNum{text-align:right}" +
      "._crdtTitleCell{max-width:220px;text-overflow:ellipsis;overflow:hidden}" +
      "._crdtNote{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}" +
      "._crdtToggle{background:var(--dsw-alias-label-tertiary);cursor:pointer;border:none;border-radius:10px;flex:none;width:36px;height:20px;padding:0;position:relative;transition:background .15s}" +
      "._crdtToggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}" +
      "._crdtKnob{background:var(--dsw-alias-bg-base);border-radius:50%;top:2px;left:2px;width:16px;height:16px;position:absolute;transition:transform .15s}" +
      "._crdtToggleOn ._crdtKnob{transform:translateX(16px)}" +
      "._crdtPill{gap:8px;align-items:center;display:flex}" +
      "._crdtPillLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:nowrap}";
    const tagId = "dsh-credit-meter/CreditMeter.module.css";
    if (
      typeof document !== "undefined" &&
      document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null
    ) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-credit-meter";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }
    const C = {
      row: "_crdtRow",
      body: "_crdtBody",
      label: "_crdtLabel",
      periodLine: "_crdtPeriodLine",
      period: "_crdtPeriod",
      periodPeak: "_crdtPeriodPeak",
      periodOff: "_crdtPeriodOff",
      dot: "_crdtDot",
      value: "_crdtValue",
      bar: "_crdtBar",
      barFill: "_crdtBarFill",
      rail: "_crdtRail",
      badge: "_crdtBadge",
      section: "_crdtSection",
      card: "_crdtCard",
      cardHead: "_crdtCardHead",
      cardTitle: "_crdtCardTitle",
      cardSub: "_crdtCardSub",
      stat: "_crdtStat",
      statValue: "_crdtStatValue",
      stats: "_crdtStats",
      field: "_crdtField",
      fieldRow: "_crdtFieldRow",
      label2: "_crdtLabel2",
      input: "_crdtInput",
      select: "_crdtSelect",
      refresh: "_crdtRefresh",
      grid: "_crdtGrid",
      table: "_crdtTable",
      num: "_crdtNum",
      titleCell: "_crdtTitleCell",
      note: "_crdtNote",
      toggle: "_crdtToggle",
      toggleOn: "_crdtToggleOn",
      knob: "_crdtKnob",
      pill: "_crdtPill",
      pillLabel: "_crdtPillLabel",
    };

    function Toggle({ checked, accent, onToggle }) {
      return React.createElement(
        "button",
        {
          type: "button",
          role: "switch",
          "aria-checked": checked,
          className: C.toggle + (checked ? " " + C.toggleOn : ""),
          style: checked ? { background: accent } : undefined,
          onClick: () => onToggle(!checked),
        },
        React.createElement("span", { className: C.knob })
      );
    }

    /** Badge of the current tariff period: peak (amber) / off-peak (green). */
    function PeriodBadge({ t }) {
      const peak = isPeakAt(Date.now());
      return React.createElement(
        "span",
        { className: C.period + (peak ? " " + C.periodPeak : " " + C.periodOff), title: t("period.title") },
        React.createElement("span", { className: C.dot }),
        peak ? t("period.peak") : t("period.off")
      );
    }

    /** Helper hook: subscribe the config form (settings namespace) and its snapshot. */
    function useScope(scope) {
      return React.useSyncExternalStore(
        (listener) => scope.subscribe(listener),
        () => scope.getSnapshot()
      );
    }
    // #endregion

    // #region 1) sidebar footer: remaining credit
    /** Compact row at the bottom of the sidebar (next to Settings). */
    function SidebarFooterCredit({ wide, scope, useSessions, t }) {
      if (scope === undefined || useSessions === undefined) return null;
      const snap = useScope(scope);
      const v = snap.value ?? {};
      const enabled = v.enabled !== false;
      const budget = Math.max(0, typeof v.budget === "number" ? v.budget : DEFAULT_CONFIG.budget);
      const sessions = useSessions((s) => s);
      const { used } = totalsFromList(sessions);
      const real = realBalanceOf(useBalance());
      // REAL balance when available; otherwise the budget − spend estimate.
      const remaining = real !== null ? real.amount : Math.max(0, budget - used);
      const remainingCurrency = real !== null ? real.currency : config.currency;
      const percent = budget > 0 ? Math.min(100, (used / budget) * 100) : 0;
      const sourceLabel = real !== null ? t("footer.real") : t("footer.estimate");
      if (!enabled) return null;

      if (!wide) {
        return React.createElement(
          "div",
          { className: C.rail, title: t("footer.remaining") + ": " + formatBalance(remaining, remainingCurrency) + " (" + sourceLabel + ") — " + t("footer.used") + ": " + formatMoney(used) },
          formatRail(remaining, remainingCurrency)
        );
      }
      return React.createElement(
        "div",
        { className: C.row },
        React.createElement(
          "div",
          { className: C.body },
          React.createElement(
            "div",
            { className: C.periodLine },
            React.createElement("div", { className: C.label }, t("footer.remaining") + " · " + sourceLabel),
            PeriodBadge({ t })
          ),
          React.createElement("div", { className: C.value }, formatBalance(remaining, remainingCurrency)),
          React.createElement(
            "div",
            { className: C.bar },
            React.createElement("div", { className: C.barFill, style: { width: percent + "%" } })
          ),
          React.createElement("div", { className: C.label }, t("footer.used") + ": " + formatMoney(used))
        )
      );
    }
    // #endregion

    // #region 2) session header: credit used by the current session
    function SessionHeaderCreditBadge({ sessionId, useProjection, scope, t }) {
      if (scope === undefined || useProjection === undefined) return null;
      const snap = useScope(scope);
      // Periodic re-render (60s) so the estimate follows peak/off-peak changes.
      useBalance();
      if ((snap.value ?? {}).enabled === false) return null;
      const usage = useProjection("tokenUsage");
      const cost = tokenCost(usage);
      if (cost === null) return null;
      return React.createElement(
        "span",
        { className: C.badge, title: t("badge.title", { session: sessionId }) },
        t("badge.prefix"),
        React.createElement("b", null, formatMoney(cost))
      );
    }
    // #endregion

    // #region 3) "Credits" settings section
    // Pure helper (invoked directly, not via createElement: no hooks).
    function numberField(label, value, step, onCommit) {
      return React.createElement(
        "label",
        { className: C.field },
        React.createElement("span", { className: C.label2 }, label),
        React.createElement("input", {
          className: C.input,
          type: "number",
          min: 0,
          step: step ?? "any",
          value: Number.isFinite(value) ? value : 0,
          onChange: (event) => onCommit(Number(event.target.value)),
        })
      );
    }

    function CreditsSettingsSection({ close, scope, useSessions, t }) {
      if (scope === undefined || useSessions === undefined) return null;
      const snap = useScope(scope);
      const v = snap.value ?? {};
      const set = (field, value) => {
        scope.set(field, value).catch(() => {});
      };
      const sessions = useSessions((s) => s);
      const { used, withUsage } = totalsFromList(sessions);
      const usedPeak = totalsFromListFactor(sessions, 1).used;
      const usedOff = totalsFromListFactor(sessions, config.offPeakEnabled ? 0.5 : 1).used;
      const rows = rowsFromList(sessions);
      const enabled = v.enabled !== false;
      const budget = Math.max(0, typeof v.budget === "number" ? v.budget : DEFAULT_CONFIG.budget);
      const remaining = budget > 0 ? Math.max(0, budget - used) : null;
      const percent = budget > 0 ? Math.min(100, (used / budget) * 100) : 0;
      const balance = useBalance();
      const real = realBalanceOf(balance);
      const preset = presetOf({
        priceInputPerM: v.priceInputPeakPerM ?? DEFAULT_CONFIG.priceInputPeakPerM,
        priceCacheReadPerM: v.priceCacheReadPeakPerM ?? DEFAULT_CONFIG.priceCacheReadPeakPerM,
        priceCacheWritePerM: v.priceCacheWritePeakPerM ?? DEFAULT_CONFIG.priceCacheWritePeakPerM,
        priceOutputPerM: v.priceOutputPeakPerM ?? DEFAULT_CONFIG.priceOutputPeakPerM,
      });

      return React.createElement(
        "div",
        { className: C.section },
        React.createElement(
          "div",
          { className: C.card },
          React.createElement(
            "div",
            { className: C.cardHead },
            React.createElement("div", { className: C.cardTitle }, t("balance.title")),
            React.createElement("div", { className: C.cardSub }, t("balance.desc")),
            React.createElement(
              "button",
              {
                type: "button",
                className: C.refresh,
                onClick: () => balanceStore.refresh(),
                disabled: balance.status === "loading",
              },
              t("balance.refresh")
            )
          ),
          balance.status === "loading"
            ? React.createElement("div", { className: C.note }, t("balance.loading"))
            : real !== null
              ? React.createElement(
                  "div",
                  { className: C.stats },
                  React.createElement(
                    "div",
                    { className: C.stat },
                    React.createElement("span", { className: C.label2 }, t("balance.value")),
                    React.createElement("span", { className: C.statValue }, formatBalance(real.amount, real.currency))
                  ),
                  React.createElement(
                    "div",
                    { className: C.stat },
                    React.createElement("span", { className: C.label2 }, t("balance.available")),
                    React.createElement(
                      "span",
                      { className: C.statValue },
                      real.isAvailable ? t("balance.availableYes") : t("balance.availableNo")
                    )
                  ),
                  React.createElement(
                    "div",
                    { className: C.stat },
                    React.createElement("span", { className: C.label2 }, t("balance.updatedAt")),
                    React.createElement("span", { className: C.statValue }, new Date(real.fetchedAt).toLocaleTimeString())
                  )
                )
              : React.createElement("div", { className: C.note }, (balance.status === "error" && balance.lastError) || t("balance.error")),
          React.createElement("div", { className: C.note }, t("balance.note"))
        ),
        React.createElement(
          "div",
          { className: C.card },
          React.createElement(
            "div",
            { className: C.cardHead },
            React.createElement("div", { className: C.cardTitle }, t("section.title")),
            React.createElement("div", { className: C.cardSub }, t("section.desc"))
          ),
          React.createElement(
            "div",
            { className: C.stats },
            React.createElement(
              "div",
              { className: C.stat },
              React.createElement("span", { className: C.label2 }, t("section.remainingEst")),
              React.createElement("span", { className: C.statValue }, remaining === null ? "—" : formatMoney(remaining))
            ),
            React.createElement(
              "div",
              { className: C.stat },
              React.createElement("span", { className: C.label2 }, t("section.usedTotal")),
              React.createElement("span", { className: C.statValue }, formatMoney(used))
            ),
            React.createElement(
              "div",
              { className: C.stat },
              React.createElement("span", { className: C.label2 }, t("section.budget")),
              React.createElement("span", { className: C.statValue }, budget > 0 ? formatMoney(budget) : "∞")
            ),
            React.createElement(
              "div",
              { className: C.stat },
              React.createElement("span", { className: C.label2 }, t("section.sessions")),
              React.createElement("span", { className: C.statValue }, String(withUsage))
            )
          ),
          budget > 0
            ? React.createElement(
                "div",
                { className: C.bar },
                React.createElement("div", { className: C.barFill, style: { width: percent + "%" } })
              )
            : null,
          React.createElement(
            "div",
            { className: C.note },
            t("section.range") + ": " + formatMoney(usedOff) + " – " + formatMoney(usedPeak)
          )
        ),
        React.createElement(
          "div",
          { className: C.card },
          React.createElement(
            "div",
            { className: C.cardHead },
            React.createElement("div", { className: C.cardTitle }, t("section.config"))
          ),
          React.createElement(
            "div",
            { className: C.pill },
            React.createElement(Toggle, {
              checked: enabled,
              accent: "var(--dsw-alias-state-success-primary)",
              onToggle: (next) => set("enabled", next),
            }),
            React.createElement("span", { className: C.pillLabel }, t("section.enabled"))
          ),
          React.createElement(
            "div",
            { className: C.pill },
            React.createElement(Toggle, {
              checked: (v.offPeakEnabled ?? DEFAULT_CONFIG.offPeakEnabled) !== false,
              accent: "var(--dsw-alias-state-success-primary)",
              onToggle: (next) => set("offPeakEnabled", next),
            }),
            React.createElement("span", { className: C.pillLabel }, t("section.offPeak"))
          ),
          React.createElement(
            "div",
            { className: C.pill },
            React.createElement("span", { className: C.pillLabel }, t("period.label")),
            PeriodBadge({ t })
          ),
          React.createElement(
            "label",
            { className: C.field },
            React.createElement("span", { className: C.label2 }, t("section.preset")),
            React.createElement("select", {
              className: C.select,
              value: preset,
              onChange: (event) => {
                const p = MODEL_PRESETS[event.target.value];
                if (p === undefined) return;
                set("priceInputPeakPerM", p.priceInputPerM);
                set("priceCacheReadPeakPerM", p.priceCacheReadPerM);
                set("priceCacheWritePeakPerM", p.priceCacheWritePerM);
                set("priceOutputPeakPerM", p.priceOutputPerM);
              },
            },
            // Visible options: the current model names only. The legacy keys
            // (deepseek-v4-flash, deepseek-v4-flash-vision-exp) stay in
            // MODEL_PRESETS so persisted selections resolve, but are not
            // offered.
            React.createElement("option", { value: "deepseek-flash" }, t("section.presetFlash")),
            React.createElement("option", { value: "deepseek-v4-pro" }, t("section.presetPro")),
            React.createElement("option", { value: "custom" }, t("section.presetCustom"))
            )
          ),
          React.createElement(
            "div",
            { className: C.fieldRow },
            numberField(t("section.budget"), budget, 0.5, (n) => set("budget", Number.isFinite(n) ? Math.max(0, n) : 0)),
            numberField(t("section.balanceInterval"), v.balanceIntervalSec ?? DEFAULT_CONFIG.balanceIntervalSec, 5, (n) => set("balanceIntervalSec", Number.isFinite(n) ? Math.min(3600, Math.max(5, Math.round(n))) : DEFAULT_CONFIG.balanceIntervalSec)),
            React.createElement(
              "label",
              { className: C.field },
              React.createElement("span", { className: C.label2 }, t("section.currency")),
              React.createElement("input", {
                className: C.input,
                type: "text",
                maxLength: 8,
                value: v.currency ?? config.currency,
                onChange: (event) => set("currency", event.target.value),
              })
            )
          ),
          React.createElement(
            "div",
            { className: C.fieldRow },
            numberField(t("section.priceInput"), v.priceInputPeakPerM ?? DEFAULT_CONFIG.priceInputPeakPerM, 0.01, (n) => set("priceInputPeakPerM", Number.isFinite(n) ? Math.max(0, n) : 0)),
            numberField(t("section.priceCacheRead"), v.priceCacheReadPeakPerM ?? DEFAULT_CONFIG.priceCacheReadPeakPerM, 0.01, (n) => set("priceCacheReadPeakPerM", Number.isFinite(n) ? Math.max(0, n) : 0)),
            numberField(t("section.priceCacheWrite"), v.priceCacheWritePeakPerM ?? DEFAULT_CONFIG.priceCacheWritePeakPerM, 0.01, (n) => set("priceCacheWritePeakPerM", Number.isFinite(n) ? Math.max(0, n) : 0)),
            numberField(t("section.priceOutput"), v.priceOutputPeakPerM ?? DEFAULT_CONFIG.priceOutputPeakPerM, 0.01, (n) => set("priceOutputPeakPerM", Number.isFinite(n) ? Math.max(0, n) : 0))
          )
        ),
        React.createElement(
          "div",
          { className: C.card },
          React.createElement(
            "div",
            { className: C.cardHead },
            React.createElement("div", { className: C.cardTitle }, t("section.perSession"))
          ),
          rows.length === 0
            ? React.createElement("div", { className: C.note }, t("section.empty"))
            : React.createElement(
                "div",
                { className: C.grid },
                React.createElement(
                  "table",
                  { className: C.table },
                  React.createElement(
                    "thead",
                    null,
                    React.createElement(
                      "tr",
                      null,
                      React.createElement("th", null, t("section.session")),
                      React.createElement("th", { className: C.num }, t("section.tokensIn")),
                      React.createElement("th", { className: C.num }, t("section.tokensCache")),
                      React.createElement("th", { className: C.num }, t("section.tokensOut")),
                      React.createElement("th", { className: C.num }, t("section.cost"))
                    )
                  ),
                  React.createElement(
                    "tbody",
                    null,
                    rows.map((row) =>
                      React.createElement(
                        "tr",
                        { key: row.id },
                        React.createElement("td", { className: C.titleCell, title: row.id }, row.title),
                        React.createElement("td", { className: C.num }, row.hasUsage ? formatTokens(row.usage.uncachedInputTokens ?? 0) : "—"),
                        React.createElement("td", { className: C.num }, row.hasUsage ? formatTokens(row.usage.cacheReadTokens ?? 0) : "—"),
                        React.createElement("td", { className: C.num }, row.hasUsage ? formatTokens(row.usage.outputTokens ?? 0) : "—"),
                        React.createElement("td", { className: C.num }, row.hasUsage ? formatMoney(row.cost) : "—")
                      )
                    )
                  )
                )
              )
        ),
        React.createElement("div", { className: C.note }, t("section.note"))
      );
    }
    // #endregion

    // #region plugin body
    // `configForms` is the settings domain's service; it owns the Host
    // configuration mirror and the per-entry write queue.
    const inject = ["slots", "locale", "configForms"];

    function apply(ctx) {
      console.log("[dsh-credit-meter] client activated");

      // 1) Configuration: sync the config with the host namespace and re-arm
      //    the balance polling whenever the settings change. Without a live
      //    `Config` form the snapshot's value stays undefined and readConfig()
      //    falls back to the built-in defaults.
      const scope = ctx.configForms.get(SETTINGS_NS);
      const sync = () => {
        readConfig(scope.getSnapshot());
        balanceStore.reschedule(config.balanceIntervalSec);
      };
      sync();
      const unsubScope = scope.subscribe(sync);
      ctx.effect(() => unsubScope, "dsh-credit-meter: settings sync");

      // 2) Real balance: start the periodic fetch toward the host route; on
      //    removal stop timer and listeners.
      balanceStore.start(config.balanceIntervalSec);
      ctx.effect(() => () => balanceStore.stop(), "dsh-credit-meter: balance store");

      // 3) i18n dictionaries.
      const locale = ctx.get("locale");
      if (locale !== undefined) {
        ctx.effect(
          () =>
            locale.register(NS, {
              en: {
                "footer.remaining": "Remaining credit",
                "footer.used": "used",
                "footer.real": "real balance",
                "footer.estimate": "estimate",
                "badge.prefix": "≈",
                "badge.title": "Estimated credit used by {session}",
                "section.nav": "Credits",
                "balance.title": "Account balance (DeepSeek)",
                "balance.desc": "Real balance read from api.deepseek.com/user/balance",
                "balance.value": "Balance",
                "balance.available": "Available",
                "balance.availableYes": "yes",
                "balance.availableNo": "no — top up",
                "balance.updatedAt": "Updated",
                "balance.refresh": "Refresh",
                "balance.loading": "Loading…",
                "balance.error": "Balance unavailable (missing DEEPSEEK_API_KEY or network). Showing the estimate below.",
                "balance.note": "The host reads the balance with your DEEPSEEK_API_KEY; the key never leaves the host.",
                "section.title": "Estimate (budget)",
                "section.desc": "Budget you set minus the estimated spend (provider tokens × prices)",
                "section.remainingEst": "Remaining (est.)",
                "section.usedTotal": "Total used",
                "section.budget": "Budget",
                "section.sessions": "Sessions with usage",
                "section.range": "Range (all off-peak → all peak)",
                "section.balanceInterval": "Balance refresh (s)",
                "section.config": "Configuration",
                "section.enabled": "Enabled",
                "section.offPeak": "Off-peak discount (50%)",
                "section.preset": "Model prices (peak)",
                "section.presetFlash": "deepseek-flash (V4.1-Flash)",
                "section.presetPro": "deepseek-v4-pro",
                "section.presetCustom": "custom",
                "section.currency": "Currency",
                "section.priceInput": "Input (miss) /1M",
                "section.priceCacheRead": "Cache read /1M",
                "section.priceCacheWrite": "Cache write /1M",
                "section.priceOutput": "Output /1M",
                "period.label": "Current period",
                "period.peak": "peak",
                "period.off": "off-peak",
                "period.title": "DeepSeek peak hours: 01:00–04:00 and 06:00–10:00 UTC, Mon–Fri, excluding Chinese public holidays (always off-peak). Off-peak = 50% of peak prices.",
                "section.perSession": "Per session",
                "section.session": "Session",
                "section.tokensIn": "Input",
                "section.tokensCache": "Cache",
                "section.tokensOut": "Output",
                "section.cost": "Est. cost",
                "section.empty": "No sessions with usage yet",
                "section.note": "Per-session costs are estimates: real provider tokens × peak prices above, halved automatically during off-peak hours. Input is dominated by CACHE READS (each step re-reads the whole context, billed at the cheap cache-hit price). The API does not expose per-request spend — the DeepSeek platform usage page is the billing authority.",
              },
              it: {
                "footer.remaining": "Credito residuo",
                "footer.used": "usati",
                "footer.real": "saldo reale",
                "footer.estimate": "stima",
                "badge.prefix": "≈",
                "badge.title": "Credito stimato usato da {session}",
                "section.nav": "Crediti",
                "balance.title": "Saldo account (DeepSeek)",
                "balance.desc": "Saldo reale letto da api.deepseek.com/user/balance",
                "balance.value": "Saldo",
                "balance.available": "Disponibile",
                "balance.availableYes": "sì",
                "balance.availableNo": "no — ricarica",
                "balance.updatedAt": "Aggiornato",
                "balance.refresh": "Aggiorna",
                "balance.loading": "Caricamento…",
                "balance.error": "Saldo non disponibile (DEEPSEEK_API_KEY mancante o rete). Sotto la stima.",
                "balance.note": "L'host legge il saldo con la tua DEEPSEEK_API_KEY; la chiave non esce mai dall'host.",
                "section.title": "Stima (budget)",
                "section.desc": "Budget che imposti tu meno la spesa stimata (token del provider × prezzi)",
                "section.remainingEst": "Residuo (stima)",
                "section.usedTotal": "Totale usato",
                "section.budget": "Budget",
                "section.sessions": "Sessioni con usage",
                "section.range": "Range (tutto off-peak → tutto peak)",
                "section.balanceInterval": "Aggiorna saldo (s)",
                "section.config": "Configurazione",
                "section.enabled": "Attivo",
                "section.offPeak": "Sconto off-peak (50%)",
                "section.preset": "Prezzi modello (peak)",
                "section.presetFlash": "deepseek-flash (V4.1-Flash)",
                "section.presetPro": "deepseek-v4-pro",
                "section.presetCustom": "personalizzati",
                "section.currency": "Valuta",
                "section.priceInput": "Input (miss) /1M",
                "section.priceCacheRead": "Cache read /1M",
                "section.priceCacheWrite": "Cache write /1M",
                "section.priceOutput": "Output /1M",
                "period.label": "Periodo attuale",
                "period.peak": "peak",
                "period.off": "off-peak",
                "period.title": "Ore peak DeepSeek: 01:00–04:00 e 06:00–10:00 UTC, lun–ven, escludendo le festività pubbliche cinesi (sempre off-peak). Off-peak = 50% dei prezzi peak.",
                "section.perSession": "Per sessione",
                "section.session": "Sessione",
                "section.tokensIn": "Input",
                "section.tokensCache": "Cache",
                "section.tokensOut": "Output",
                "section.cost": "Costo stimato",
                "section.empty": "Nessuna sessione con usage, per ora",
                "section.note": "I costi per sessione sono stime: token reali del provider × prezzi peak sopra, dimezzati automaticamente in off-peak. L'input è dominato dai CACHE READ (ogni step rilegge l'intero contesto, addebitato al prezzo cache-hit). L'API non espone la spesa per richiesta — la pagina di usage della piattaforma DeepSeek fa fede per la fatturazione.",
              },
            }),
          "dsh-credit-meter: dictionaries"
        );
      }

      // 4) UI slots.
      const slots = ctx.get("slots");
      if (slots !== undefined) {
        const t = locale !== undefined ? locale.bind(NS) : (key) => key;

        // 4a) Sidebar footer: remaining credit (always visible).
        slots.inject("sidebar.footer.action", () =>
          slots.register(
            {
              name: "sidebar.footer.action",
              id: "credit-meter",
              order: 90,
              locale: NS,
              inject: () => ({ scope }),
            },
            SidebarFooterCredit
          )
        );

        // 4b) Current session header: badge with the estimated credit used.
        slots.inject("conversation.session.header.utilities", () =>
          slots.register(
            {
              name: "conversation.session.header.utilities",
              id: "credit-meter",
              order: 90,
              locale: NS,
              inject: () => ({ scope }),
            },
            SessionHeaderCreditBadge
          )
        );

        // 4c) "Credits" settings section: summary + per-session table.
        slots.inject("settings.section", () =>
          slots.register(
            {
              name: "settings.section",
              id: "credit-meter",
              order: 90,
              label: () => t("section.nav"),
              locale: NS,
              inject: () => ({ scope }),
            },
            CreditsSettingsSection
          )
        );
      }
    }
    // #endregion

    // Exposed for the unit tests (no production use).
    exports.internals = {
      DEFAULT_CONFIG,
      MODEL_PRESETS,
      tokenCost,
      tokenCostWithFactor,
      isPeakAt,
      currentPeriod,
      priceFactor,
      formatMoney,
      formatBalance,
      formatCompact,
      formatRail,
      formatTokens,
      totalsFromList,
      totalsFromListFactor,
      rowsFromList,
      moneySymbol,
      presetOf,
      realBalanceOf,
      balanceStore,
      readConfig,
    };
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
