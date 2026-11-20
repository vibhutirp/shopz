// Merchant search over the stores' JSON API (docs/CONTRACTS.md §1).
import { STORES } from '../../../packages/contracts/index.js';

const SEARCH_TIMEOUT_MS = 4000;

/** Short, log-friendly error text (no stack, no URL credentials). */
export function errText(err) {
  if (!err) return 'unknown error';
  if (err.timeout) return err.message;
  const cause = err.cause && (err.cause.code || err.cause.message);
  return String(cause || err.message || err).slice(0, 200);
}

function isRefused(err) {
  const code = err && err.cause && err.cause.code;
  return code === 'ECONNREFUSED' || code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT';
}

async function attemptJson(url, { method, body, timeoutMs }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const init = { method, signal: ac.signal, headers: { accept: 'application/json' } };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    const text = await res.text();
    let json = null;
    if (text) {
      try { json = JSON.parse(text); } catch { json = undefined; }
    }
    if (!res.ok) {
      const err = new Error((json && json.error) || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = json === undefined ? text.slice(0, 500) : json;
      throw err;
    }
    if (json === undefined) throw new Error(`invalid JSON (HTTP ${res.status})`);
    return json;
  } catch (err) {
    if (err && err.name === 'AbortError') {
      const t = new Error(`timeout after ${timeoutMs} ms`);
      t.timeout = true;
      throw t;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * fetch + JSON with a hard timeout (covers the body read). Throws on HTTP >= 400 (err.status, err.body)
 * and on timeout (err.timeout = true). A refused connection to "localhost" is retried on 127.0.0.1 and ::1,
 * because Node may resolve localhost to the other address family than the one the server listens on.
 */
export async function fetchJson(url, { method = 'GET', body, timeoutMs = SEARCH_TIMEOUT_MS } = {}) {
  try {
    return await attemptJson(url, { method, body, timeoutMs });
  } catch (err) {
    let host = '';
    try { host = new URL(url).hostname; } catch { /* keep '' */ }
    if (host !== 'localhost' || !isRefused(err)) throw err;
    let last = err;
    for (const alt of ['127.0.0.1', '[::1]']) {
      try {
        return await attemptJson(url.replace('//localhost', `//${alt}`), { method, body, timeoutMs });
      } catch (e) {
        last = e;
        if (!isRefused(e)) break;
      }
    }
    throw last;
  }
}

function port(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : fallback;
}

/** The two demo stores with ports from RUNHUB_PORT / DAILYCART_PORT (defaults 4001 / 4002). */
export function merchantsFromEnv(env = process.env) {
  return [
    { id: STORES.runhub.id, name: STORES.runhub.name, base: `http://localhost:${port(env.RUNHUB_PORT, STORES.runhub.port)}` },
    { id: STORES.dailycart.id, name: STORES.dailycart.name, base: `http://localhost:${port(env.DAILYCART_PORT, STORES.dailycart.port)}` },
  ];
}

async function searchOne(merchant, query, category, timeoutMs) {
  const t0 = Date.now();
  const base = String(merchant.base || '').replace(/\/+$/, '');
  try {
    const qs = `q=${encodeURIComponent(query ?? '')}&category=${encodeURIComponent(category ?? '')}`;
    const json = await fetchJson(`${base}/api/search?${qs}`, { timeoutMs });
    const list = Array.isArray(json && json.results) ? json.results : [];
    const results = await Promise.all(list.filter((r) => r && r.sku).map(async (r) => {
      const item = { ...r, store: r.store || merchant.id, store_name: r.store_name || merchant.name };
      if (typeof item.url === 'string' && item.url.startsWith('/')) item.url = base + item.url;
      try {
        item.details = await fetchJson(`${base}/api/products/${encodeURIComponent(r.sku)}`, { timeoutMs });
      } catch {
        item.details = null; // product stays a candidate; ranking uses the summary fields
      }
      return item;
    }));
    return { entry: { store: merchant.id, count: results.length, ms: Date.now() - t0 }, results };
  } catch (err) {
    return { entry: { store: merchant.id, count: 0, error: errText(err), ms: Date.now() - t0 }, results: [] };
  }
}

/**
 * Search every store in parallel: GET {base}/api/search?q=&category=, then GET {base}/api/products/:sku per hit
 * (attached as .details). A store that fails is skipped and reported in perStore with `error`.
 * → { seen, perStore: [{ store, count, ms, error? }], results: ProductSummary[] }
 */
export async function searchMerchants({ query = '', category = '', merchants = merchantsFromEnv(), timeoutMs = SEARCH_TIMEOUT_MS } = {}) {
  const per = await Promise.all((merchants || []).map((m) => searchOne(m, query, category, timeoutMs)));
  const results = per.flatMap((p) => p.results);
  return { seen: results.length, perStore: per.map((p) => p.entry), results };
}
