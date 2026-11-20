// Browser access: the visible browser controller (CONTRACTS §2) when it answers, else the merchants' JSON API.
// A failed controller call is retried once in http mode and reported via `lastFallback`.
import { SECTIONS, STORES, sha256Hex } from '../../../packages/contracts/index.js';
import { errText, fetchJson, merchantsFromEnv } from './search.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const TIMEOUTS = { health: 1500, nav: 10000, quick: 5000, checkoutController: 180000, checkoutApi: 10000, api: 4000 };

const stripHash = (url) => String(url).split('#')[0];
const portOf = (u) => u.port || (u.protocol === 'https:' ? '443' : '80');

export async function createBrowser({ controllerUrl = process.env.CONTROLLER_URL || 'http://localhost:4100', merchants = merchantsFromEnv() } = {}) {
  const ctrl = String(controllerUrl || '').replace(/\/+$/, '');
  let mode = 'http';
  if (ctrl) {
    try {
      const health = await fetchJson(`${ctrl}/health`, { timeoutMs: TIMEOUTS.health });
      if (health && health.ok !== false) mode = 'controller';
    } catch { /* controller not running → http mode */ }
  }

  const history = [];
  let snapCounter = 0;
  const nextSnapshotId = () => 'snap_' + String(++snapCounter).padStart(4, '0');
  const currentUrl = () => (history.length ? history[history.length - 1] : null);

  function merchantFor(u) {
    const list = merchants || [];
    const parse = (m) => { try { return new URL(m.base); } catch { return null; } };
    return list.find((m) => { const b = parse(m); return b && b.origin === u.origin; })
      || list.find((m) => { const b = parse(m); return b && portOf(b) === portOf(u) && LOCAL_HOSTS.has(b.hostname) && LOCAL_HOSTS.has(u.hostname); })
      || null;
  }

  /** http://localhost:PORT/p/SKU → { base, sku, pageUrl }. base = the configured merchant base when it matches. */
  function resolveUrl(url) {
    let u;
    try { u = new URL(url); } catch { return null; }
    const m = u.pathname.match(/^\/p\/([^/]+)\/?$/);
    const merchant = merchantFor(u);
    return {
      base: String(merchant ? merchant.base : u.origin).replace(/\/+$/, ''),
      sku: m ? decodeURIComponent(m[1]) : null,
      pageUrl: u.origin + u.pathname,
    };
  }

  function merchantForSku(sku) {
    const store = Object.values(STORES).find((s) => String(sku || '').startsWith(s.orderPrefix));
    const merchant = store && (merchants || []).find((m) => m.id === store.id);
    return merchant ? { base: String(merchant.base).replace(/\/+$/, ''), sku, pageUrl: `${String(merchant.base).replace(/\/+$/, '')}/p/${encodeURIComponent(sku)}` } : null;
  }

  async function ctrlCall(path, { method = 'POST', body, timeoutMs = TIMEOUTS.quick } = {}) {
    const res = await fetchJson(ctrl + path, { method, body: method === 'GET' ? undefined : (body ?? {}), timeoutMs });
    if (res && res.ok === false) throw new Error(res.error || `controller ${path} returned ok:false`);
    return res;
  }

  async function withFallback(name, viaController, viaHttp, { fallbackOnTimeout = true } = {}) {
    api.lastFallback = null;
    if (mode !== 'controller') return viaHttp();
    try {
      return await viaController();
    } catch (err) {
      if (err && (err.noFallback || (err.timeout && !fallbackOnTimeout))) throw err;
      api.lastFallback = `${name}: controller failed (${errText(err)}), used http mode`;
      return viaHttp();
    }
  }

  // ---- http mode -----------------------------------------------------------------------------------------
  async function httpTitle(url) {
    const t = resolveUrl(url);
    if (!t || !t.sku) return null;
    try {
      const p = await fetchJson(`${t.base}/api/products/${encodeURIComponent(t.sku)}`, { timeoutMs: 2000 });
      return (p && p.title) || null;
    } catch {
      return null;
    }
  }

  async function httpSnapshot(section, opts) {
    const cur = currentUrl();
    const target = cur && resolveUrl(cur);
    if (!target || !target.sku) throw new Error('snapshot: no product page is open');
    const data = await fetchJson(`${target.base}/api/products/${encodeURIComponent(target.sku)}/sections`, { timeoutMs: TIMEOUTS.api });
    const sections = (data && data.sections) || {};
    let text;
    let fields;
    if (section === 'all') {
      const names = [...SECTIONS.filter((n) => sections[n]), ...Object.keys(sections).filter((n) => !SECTIONS.includes(n))];
      text = names.map((n) => `## ${n}\n${typeof sections[n].text === 'string' ? sections[n].text : ''}`).join('\n\n');
      fields = {};
      for (const n of names) {
        for (const [k, v] of Object.entries(sections[n].fields || {})) fields[`${n}.${k}`] = v;
      }
    } else {
      const s = sections[section];
      text = s && typeof s.text === 'string' ? s.text : '';
      fields = s && s.fields && typeof s.fields === 'object' ? { ...s.fields } : {};
    }
    const pageUrl = stripHash(cur);
    return makeSnapshot({ url: section === 'all' ? pageUrl : `${pageUrl}#${section}`, section, text, fields }, opts);
  }

  async function httpCheckout({ url, sku, qty = 1 } = {}) {
    const t0 = Date.now();
    const fromUrl = url ? resolveUrl(url) : null;
    const fromCurrent = !url && !sku && currentUrl() ? resolveUrl(currentUrl()) : null;
    const target = (fromUrl && { ...fromUrl, sku: sku || fromUrl.sku }) || (sku && merchantForSku(sku)) || fromCurrent;
    if (!target || !target.sku) throw new Error('checkout: unknown product (pass url or sku)');
    const order = await fetchJson(`${target.base}/api/checkout`, { method: 'POST', body: { sku: target.sku, qty }, timeoutMs: TIMEOUTS.checkoutApi });
    if (!order || !order.order_id) throw new Error('checkout: the merchant returned no order id');
    history.push(`${target.base}/order/${encodeURIComponent(order.order_id)}`);
    return {
      order_id: order.order_id,
      totals: order.totals || null,
      delivery_eta: order.delivery_eta || null,
      confirmation_text: `Order ${order.order_id} confirmed`,
      executor: order.executor || 'api',
      steps: [{ step: 'api_checkout', ok: true, ms: Date.now() - t0 }],
      order,
    };
  }

  function makeSnapshot({ url, section, text, fields, taken_at }, opts = {}) {
    const snap = { snapshot_id: nextSnapshotId() };
    if (opts && opts.session_id) snap.session_id = opts.session_id;
    Object.assign(snap, { url, section, taken_at: taken_at || new Date().toISOString(), text, fields: fields || {}, sha256: sha256Hex(text) });
    return snap;
  }

  // ---- public API ----------------------------------------------------------------------------------------
  const api = {
    mode,
    lastFallback: null,

    currentUrl,

    open(url) {
      return withFallback('open', async () => {
        const r = await ctrlCall('/open', { body: { url }, timeoutMs: TIMEOUTS.nav });
        history.push(r.url || url);
        return { ok: true, url: r.url || url, title: r.title ?? null };
      }, async () => {
        history.push(url);
        return { ok: true, url, title: await httpTitle(url) };
      });
    },

    scroll(section) {
      return withFallback('scroll', async () => {
        await ctrlCall('/scroll', { body: { section } });
        return { ok: true };
      }, async () => ({ ok: true }));
    },

    highlight(section) {
      return withFallback('highlight', async () => {
        await ctrlCall('/highlight', { body: { section: section ?? null } });
        return { ok: true };
      }, async () => ({ ok: true }));
    },

    back() {
      const httpBack = async () => {
        if (history.length > 1) history.pop();
        return { ok: true, url: currentUrl() };
      };
      return withFallback('back', async () => {
        const r = await ctrlCall('/back');
        if (history.length > 1) history.pop();
        if (r.url && history.length) history[history.length - 1] = r.url;
        return { ok: true, url: r.url || currentUrl() };
      }, httpBack);
    },

    reload() {
      return withFallback('reload', async () => {
        const r = await ctrlCall('/reload', { timeoutMs: TIMEOUTS.nav });
        return { ok: true, url: r.url || currentUrl() };
      }, async () => ({ ok: true, url: currentUrl() }));
    },

    /** section: one of SECTIONS or 'all'. opts.session_id is copied into the snapshot. */
    snapshot(section = 'all', opts = {}) {
      const sec = section || 'all';
      return withFallback('snapshot', async () => {
        const s = await ctrlCall(`/snapshot?section=${encodeURIComponent(sec)}`, { method: 'GET' });
        const text = s && typeof s.text === 'string' ? s.text : '';
        return makeSnapshot({ url: s.url || currentUrl(), section: s.section || sec, text, fields: s.fields, taken_at: s.taken_at }, opts);
      }, () => httpSnapshot(sec, opts));
    },

    /**
     * Falls back to POST /api/checkout when the controller is unreachable or answers with an error, but never
     * on a timeout or a reply without order id: the browser checkout may still run or have succeeded, and a
     * second (API) checkout could place a duplicate order.
     */
    checkout({ url, sku, qty = 1 } = {}) {
      return withFallback('checkout', async () => {
        const r = await ctrlCall('/checkout', { body: { url, sku, qty }, timeoutMs: TIMEOUTS.checkoutController });
        if (!r || !r.order_id) {
          // The browser may have placed the order anyway: report instead of buying a second time via the API.
          throw Object.assign(new Error('controller checkout returned no order id'), { noFallback: true });
        }
        return {
          order_id: r.order_id,
          totals: r.totals || null,
          delivery_eta: r.delivery_eta || null,
          confirmation_text: r.confirmation_text || `Order ${r.order_id} confirmed`,
          executor: r.executor || 'playwright',
          steps: Array.isArray(r.steps) ? r.steps : [],
        };
      }, () => httpCheckout({ url, sku, qty }), { fallbackOnTimeout: false });
    },
  };
  return api;
}
