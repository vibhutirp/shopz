// Optional web search for the live mode (off by default – no key, no subscription).
// LIVE_SEARCH_URL = a SearXNG-compatible endpoint (GET <url>/search?q=…&format=json). Results only point Shopz at
// product pages on stores the user allowed; they never add a store. Any failure is logged and the store search goes on.
export function webSearchFromEnv(env = process.env, fetchImpl = globalThis.fetch) {
  const base = String(env.LIVE_SEARCH_URL || '').trim().replace(/\/+$/, '');
  if (!base) return null;
  return async function webSearch(query, { timeoutMs = 4000 } = {}) {
    const res = await fetchImpl(`${base}/search?q=${encodeURIComponent(`${query} buy`)}&format=json`, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    return (Array.isArray(j.results) ? j.results : []).map((r) => ({ url: String(r.url || ''), title: String(r.title || '').slice(0, 160) }))
      .filter((r) => /^https:\/\//.test(r.url)).slice(0, 20);
  };
}

/** Web hits that are product pages on an allowed store → [{ host, handle }]. */
export function productHits(hits, allowedHosts) {
  const allow = new Set(allowedHosts);
  const out = [];
  for (const h of hits || []) {
    let u; try { u = new URL(h.url); } catch { continue; }
    const m = u.pathname.match(/^(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/(?:collections\/[^/]+\/)?products\/([a-z0-9][a-z0-9-]*)\/?$/i);
    if (m && allow.has(u.host) && !out.some((x) => x.host === u.host && x.handle === m[1])) out.push({ host: u.host, handle: m[1].toLowerCase() });
  }
  return out;
}
