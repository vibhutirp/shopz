// Live web through the user's own browser: the same Shopify client (robots.txt, SSRF guard, cool-down, parsers),
// but every request goes out from the user's Chrome (their IP, their cookies) and product pages open visibly in the
// Shopz tab. A login wall or bot check on the page is handed to the human – never worked around.
import { createShopifyClient, parseJsonLd, parseOpenGraph, shopLabel } from '../live/shopify.js';
import { sha256Hex } from '../../../../packages/contracts/index.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Rebuild a tiny HTML document from what the extension read, so the server's JSON-LD / OpenGraph parsers stay the only parsers. */
export function pageHtml(read) {
  const ld = (Array.isArray(read?.jsonld) ? read.jsonld : []).map((j) => `<script type="application/ld+json">${String(j).replace(/<\/script/gi, '<\\/script')}</script>`).join('\n');
  const meta = Object.entries(read?.meta || {}).map(([k, v]) => `<meta property="${esc(k)}" content="${esc(v)}">`).join('\n');
  return `<html><head><title>${esc(read?.title || '')}</title>${meta}\n${ld}</head><body></body></html>`;
}

/**
 * fetch() lookalike that runs in the user's browser (extension background, credentials included).
 * The browser follows redirects itself; we turn a changed final URL into one synthetic 302 so the Shopify client's
 * redirect guard (public https hosts only) still sees every hop, then serve the cached body for the second call.
 */
export function companionFetch(remote, { now = () => Date.now() } = {}) {
  const followed = new Map(); // final url → { at, status, text }
  return async function fetchViaBrowser(url, init = {}) {
    const hit = followed.get(url);
    if (hit && now() - hit.at < 30000) {
      followed.delete(url);
      return new Response(hit.text, { status: hit.status, headers: { 'content-type': hit.type || 'text/plain' } });
    }
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const accept = init.headers?.accept || init.headers?.Accept || '*/*';
    const r = await remote.cmd('fetch', { url, accept }, { timeoutMs: 15000 });
    const status = Number(r.status) || 0;
    if (r.url && r.url !== url && status !== 0) {
      followed.set(r.url, { at: now(), status, text: String(r.text ?? ''), type: r.type });
      return new Response(null, { status: 302, headers: { location: r.url } });
    }
    const headers = { 'content-type': r.type || 'text/plain' };
    if (r.retry_after) headers['retry-after'] = String(r.retry_after);
    return new Response(status === 204 ? null : String(r.text ?? ''), { status: status || 502, headers });
  };
}

/**
 * Shopify client whose requests run in the user's browser. page() opens the product page in the Shopz tab and
 * reads the rendered DOM (JSON-LD + OpenGraph + visible text). A gate on the page (login, captcha, 2FA) waits for
 * the human, then reads again.
 */
export function createCompanionClient(remote, { checkRobots = true, now = () => Date.now(), onTurn = null, resolver = undefined } = {}) {
  const base = createShopifyClient({ fetchImpl: companionFetch(remote, { now }), checkRobots, now, ...(resolver ? { resolver } : {}) });

  // One Shopz tab: page reads run one after the other (the server path reads three pages in parallel).
  let tabLock = Promise.resolve();
  function readTab(url, opts = {}) {
    const run = tabLock.then(() => readTabNow(url, opts));
    tabLock = run.then(() => {}, () => {});
    return run;
  }

  async function readTabNow(url, { timeoutMs = 12000 } = {}) {
    const t0 = now();
    await remote.cmd('navigate', { url }, { timeoutMs: Math.max(timeoutMs, 15000) });
    let r = await remote.cmd('read', {}, { timeoutMs });
    if (r.gate && r.gate.kind && r.gate.kind !== 'payment') {
      if (onTurn) onTurn(r.gate);
      const done = await remote.yourTurn({ kind: r.gate.kind, url: r.url || url, reason: r.gate.reason });
      if (!done.ok) throw Object.assign(new Error(`${shopLabel(new URL(url).host)} needs you (${r.gate.kind}) – hand-off ${done.resumed_by}`), { blocked: true, gate: r.gate.kind });
      r = await remote.cmd('read', {}, { timeoutMs });
      if (r.gate && r.gate.kind && r.gate.kind !== 'payment') throw Object.assign(new Error(`${shopLabel(new URL(url).host)} still shows ${r.gate.kind}`), { blocked: true, gate: r.gate.kind });
    }
    return { ...r, ms: now() - t0 };
  }

  async function page(host, handle, { timeoutMs = 12000 } = {}) {
    const path = `/products/${encodeURIComponent(handle)}`;
    if (!(await base.allowed(host, path))) throw Object.assign(new Error(`robots.txt of ${shopLabel(host)} disallows ${path}`), { code: 'ROBOTS' });
    const r = await readTab(`https://${host}${path}`, { timeoutMs });
    const html = pageHtml(r);
    const jsonld = parseJsonLd(html, r.url || `https://${host}${path}`);
    const og = parseOpenGraph(html, r.url || `https://${host}${path}`);
    return {
      url: r.url || `https://${host}${path}`, status: 200, ms: r.ms, bytes: Number(r.bytes) || String(r.text || '').length,
      html_sha256: r.html_sha256 || sha256Hex(String(r.text || '')), jsonld, og, text: String(r.text || '').slice(0, 20000),
      via: 'companion', gate: r.gate || null,
    };
  }

  return { ...base, page, readTab, via: 'companion' };
}
