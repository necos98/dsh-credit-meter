// dsh-credit-meter — pure handlers.
//
// The balance HTTP handler factory lives here (not in index.js) so unit tests
// and evals can drive the route without booting Cordis or hitting the network.
// createBalanceHandler takes its dependencies explicitly (credentials getter,
// fetch implementation, clock, cache lifetime) in the same factory style as
// the template's command/policy handlers, so behavior is fully injectable.

/** Path of the balance route exposed by the host half. */
export const BALANCE_PATH = "/credit-meter/balance";

/** Official DeepSeek balance endpoint (https://api-docs.deepseek.com/api/get-user-balance/). */
export const BALANCE_URL = "https://api.deepseek.com/user/balance";

/** Credential ref resolved through ctx.credentials (the account API key). */
export const API_KEY_ENV = "DEEPSEEK_API_KEY";

/** How long a successful balance response is cached, in ms. */
export const CACHE_MS = 30_000;

// credentialRef() in @deepseek-ai/dsh-credentials is a pure runtime brand
// (validates and returns the string); inlined so the host module stays free
// of imports that the profile node_modules might not resolve.
export function credentialRef(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new TypeError(
      'credential ref "' + value + '" must match /^[A-Za-z_][A-Za-z0-9_]*$/'
    );
  }
  return value;
}

/** Write a JSON response (the API key never appears in the payload). */
function respondJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

/**
 * Build the /credit-meter/balance handler. The handler resolves the
 * DEEPSEEK_API_KEY credential through the injected credentials service (the
 * key never leaves the host) and queries the official DeepSeek balance
 * endpoint, returning the REAL account balance. Successful responses are
 * cached for cacheMs; a request with a valid ?ttl=<seconds> query (5–3600)
 * bypasses the cache so the client can poll for fresh data.
 *
 * Response shape: { ok: true, isAvailable, balance, currency, granted,
 * toppedUp, fetchedAt } on success, or { ok: false, error, message,
 * fetchedAt } — always HTTP 200 with the outcome in the body.
 *
 * @param deps.credentials - () => credentials service with async resolve(ref),
 *   or undefined when the service is not mounted.
 * @param deps.fetchImpl - fetch implementation; defaults to the global fetch,
 *   read lazily so tests can stub globalThis.fetch.
 * @param deps.now - () => ms timestamp; defaults to Date.now.
 * @param deps.cacheMs - cache lifetime in ms; defaults to CACHE_MS.
 * @returns the (req, res) => Promise handler.
 */
export function createBalanceHandler({
  credentials,
  fetchImpl,
  now = () => Date.now(),
  cacheMs = CACHE_MS,
} = {}) {
  // Per-handler cache (there is one plugin instance, so this is the bundle
  // cache): avoids hammering the DeepSeek API on every page refresh.
  let cache = undefined;

  return async function balanceHandler(req, res) {
    const doFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));
    const respond = (payload) => respondJson(res, 200, payload);

    // A request with a valid ttl skips the cache and hits DeepSeek right away.
    let bypassCache = false;
    try {
      const params = new URL(req.url ?? "/", "http://x").searchParams;
      const ttl = Number(params.get("ttl"));
      bypassCache = Number.isFinite(ttl) && ttl >= 5 && ttl <= 3600;
    } catch {
      bypassCache = false;
    }
    if (!bypassCache && cache !== undefined && now() - cache.fetchedAt < cacheMs) {
      return respond(cache.payload);
    }

    return (async () => {
      const service = credentials();
      const resolved =
        service === undefined
          ? undefined
          : await service.resolve(credentialRef(API_KEY_ENV));
      if (resolved === undefined || resolved.value === "") {
        return respond({
          ok: false,
          error: "no-credential",
          message: "DEEPSEEK_API_KEY not configured (ctx.credentials)",
          fetchedAt: now(),
        });
      }
      let response;
      try {
        response = await doFetch(BALANCE_URL, {
          headers: {
            Authorization: "Bearer " + resolved.value,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) {
        return respond({
          ok: false,
          error: "fetch-failed",
          message: error instanceof Error ? error.message : String(error),
          fetchedAt: now(),
        });
      }
      const text = await response.text().catch(() => "");
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
      if (!response.ok || data === null) {
        const detail =
          data !== null && data.error
            ? typeof data.error === "string"
              ? data.error
              : data.error.message ?? JSON.stringify(data.error)
            : "HTTP " + response.status;
        return respond({
          ok: false,
          error: "http-" + response.status,
          message: String(detail),
          fetchedAt: now(),
        });
      }
      const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
      // Prefer USD when present (e.g. multi-currency accounts), else the first.
      const info = infos.find((i) => i && i.currency === "USD") ?? infos[0];
      const num = (x) => {
        const n = Number.parseFloat(x);
        return Number.isFinite(n) ? n : null;
      };
      const payload = {
        ok: true,
        isAvailable: data.is_available === true,
        balance: info === undefined ? null : num(info.total_balance),
        currency: info && info.currency ? info.currency : "USD",
        granted: info === undefined ? null : num(info.granted_balance),
        toppedUp: info === undefined ? null : num(info.topped_up_balance),
        fetchedAt: now(),
      };
      cache = { fetchedAt: now(), payload };
      return respond(payload);
    })().catch((error) => {
      respond({
        ok: false,
        error: "internal",
        message: error instanceof Error ? error.message : String(error),
        fetchedAt: now(),
      });
    });
  };
}
