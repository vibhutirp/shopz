// Demo stores through the user's own browser: the same browser API as src/browser.js (open, scroll, highlight, back,
// reload, snapshot, checkout), carried out in the Shopz tab by the Companion extension. The checkout goes as far as
// the payment page; "Place order" is the human's tap (hand-off), then Shopz reads the confirmation page.
import { sha256Hex } from '../../../../packages/contracts/index.js';

const NUMBER_RE = /^-?\d+(?:\.\d+)?$/; // same rule as the controller and the merchants' sections API
const fieldKey = (attr) => attr.slice(5).replace(/-/g, '_');
const typed = (raw) => (raw === 'true' ? true : raw === 'false' ? false : NUMBER_RE.test(String(raw)) ? (String(raw).includes('.') ? Number.parseFloat(raw) : Number.parseInt(raw, 10)) : raw);
const stripHash = (u) => String(u || '').split('#')[0];
export const QTY_SELECTOR = '[data-testid="qty"], select[name="qty"], input[name="qty"]';
// The agent's part of the demo checkout; the last step (Place order) is the human's.
export const AGENT_STEPS = [
  { step: 'add_to_cart', click: '[data-testid="add-to-cart"]', until: '[data-testid="checkout"]' },
  { step: 'checkout', click: '[data-testid="checkout"]', until: '[data-testid="continue"]' },
  { step: 'continue', click: '[data-testid="continue"]', until: '[data-testid="place-order"]' },
];
const money = (v) => { const m = String(v ?? '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/); return m ? Math.round(Number(m[0]) * 100) / 100 : null; };

export function createCompanionBrowser(remote, { fallback = null, turnTimeoutMs = 170000 } = {}) {
  const history = [];
  let snapCounter = 0;
  const currentUrl = () => (history.length ? history[history.length - 1] : null);

  async function guarded(name, viaCompanion, viaFallback) {
    api.lastFallback = null;
    try { return await viaCompanion(); } catch (err) {
      if (err && (err.refused || err.noFallback || !fallback || !viaFallback)) throw err;
      api.lastFallback = `${name}: your browser failed (${String(err.message || err).slice(0, 80)}), used the server instead`;
      return viaFallback();
    }
  }

  const api = {
    mode: 'companion',
    lastFallback: null,
    currentUrl,

    open(url) {
      return guarded('open', async () => {
        const r = await remote.cmd('navigate', { url });
        history.push(r.url || url);
        return { ok: true, url: r.url || url, title: r.title ?? null };
      }, fallback && (() => fallback.open(url)));
    },
    scroll(section) {
      return guarded('scroll', async () => { await remote.cmd('scroll', { section }); return { ok: true }; }, fallback && (() => fallback.scroll(section)));
    },
    highlight(section) {
      return guarded('highlight', async () => { await remote.cmd('highlight', { section: section ?? null }); return { ok: true }; }, fallback && (() => fallback.highlight(section)));
    },
    back() {
      return guarded('back', async () => {
        const r = await remote.cmd('back', {});
        if (history.length > 1) history.pop();
        if (r.url && history.length) history[history.length - 1] = r.url;
        return { ok: true, url: r.url || currentUrl() };
      }, fallback && (() => fallback.back()));
    },
    reload() {
      return guarded('reload', async () => { const r = await remote.cmd('reload', {}); return { ok: true, url: r.url || currentUrl() }; }, fallback && (() => fallback.reload()));
    },

    /** Same text/fields format as the controller: "## name\ntext" per [data-section], fields "<section>.<key>". */
    snapshot(section = 'all', opts = {}) {
      const name = section || 'all';
      return guarded('snapshot', async () => {
        const r = await remote.cmd('snapshot', { section: name === 'all' ? null : name });
        const parts = Array.isArray(r.parts) ? r.parts : [];
        if (name !== 'all' && !parts.length) throw Object.assign(new Error(`section not found on this page: ${name}`), { refused: true });
        const pageUrl = stripHash(r.url || currentUrl());
        let text; let fields;
        if (name === 'all') {
          text = parts.map((p) => `## ${p.name}\n${p.text}`).join('\n\n');
          fields = {};
          for (const p of parts) for (const [k, v] of Object.entries(p.attrs || {})) fields[`${p.name}.${fieldKey(k)}`] = typed(v);
        } else {
          text = parts[0].text;
          fields = Object.fromEntries(Object.entries(parts[0].attrs || {}).map(([k, v]) => [fieldKey(k), typed(v)]));
        }
        const snap = { snapshot_id: `snap_c${String(++snapCounter).padStart(4, '0')}` };
        if (opts && opts.session_id) snap.session_id = opts.session_id;
        Object.assign(snap, { url: name === 'all' ? pageUrl : `${pageUrl}#${name}`, section: name, taken_at: new Date().toISOString(), text, fields, sha256: sha256Hex(text), via: 'companion' });
        return snap;
      }, fallback && (() => fallback.snapshot(name, opts)));
    },

    /**
     * Cart → shipping → payment page in the user's tab, then the human clicks "Place order". Never falls back to the
     * server checkout: the order may be placed in the tab at any moment, and a second checkout would buy twice.
     */
    async checkout({ url, sku, qty = 1 } = {}) {
      api.lastFallback = null;
      const steps = [];
      const t = Date.now();
      const fail = (msg) => Object.assign(new Error(msg), { noFallback: true, steps });
      if (url) {
        const r = await remote.cmd('navigate', { url });
        history.push(r.url || url);
      }
      const state = await remote.cmd('query', { selector: '[data-section="price"][data-sku], [data-sku]', limit: 1 });
      const el = (state.items || [])[0];
      if (sku && el && el.attrs['data-sku'] && el.attrs['data-sku'] !== sku) throw fail(`the open page sells ${el.attrs['data-sku']}, not ${sku}`);
      if (el && String(el.attrs['data-in-stock'] || '').toLowerCase() === 'false') throw fail(`${sku} is out of stock on the page`);
      if (Number(qty) > 1) { try { await remote.cmd('fill', { selector: QTY_SELECTOR, value: String(qty), label: 'quantity' }); } catch { /* the cart step re-checks */ } }
      for (const st of AGENT_STEPS) {
        const t0 = Date.now();
        try {
          await remote.cmd('click', { selector: st.click, wait_for: st.until, label: st.step.replace(/_/g, ' ') });
          steps.push({ step: st.step, ok: true, ms: Date.now() - t0, executor: 'companion' });
        } catch (err) {
          steps.push({ step: st.step, ok: false, ms: Date.now() - t0, executor: 'companion', error: String(err.message).slice(0, 120) });
          throw fail(`checkout step ${st.step} failed in your browser: ${err.message}`);
        }
      }
      const pay = await remote.cmd('read', {});
      const t1 = Date.now();
      const turn = await remote.yourTurn({ kind: 'payment', url: pay.url || null, reason: 'place order', timeoutMs: turnTimeoutMs });
      steps.push({ step: 'place_order', ok: Boolean(turn.ok), ms: Date.now() - t1, executor: 'you', resumed_by: turn.resumed_by });
      if (!turn.ok) throw fail(turn.resumed_by === 'timeout' ? 'nobody placed the order in the Shopz tab' : `the hand-off ended (${turn.resumed_by})`);
      // The confirmation page: data attributes only, as the controller reads them.
      let conf = null;
      for (let i = 0; i < 10; i += 1) {
        try { conf = await remote.cmd('query', { selector: '[data-order-id]', limit: 1 }); } catch { conf = null; }
        if (conf && conf.items && conf.items.length) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      const c = conf && conf.items && conf.items[0];
      if (!c || !c.attrs['data-order-id']) throw fail('the Shopz tab does not show an order confirmation');
      const a = c.attrs;
      history.push(conf.url || currentUrl());
      return {
        order_id: a['data-order-id'],
        totals: { subtotal: money(a['data-subtotal']), tax: money(a['data-tax']), shipping: money(a['data-shipping']), total: money(a['data-total']), currency: a['data-currency'] || 'USD' },
        delivery_eta: a['data-eta'] || null,
        confirmation_text: `Order ${a['data-order-id']} confirmed`,
        executor: 'companion',
        placed_by: 'you',
        steps,
        ms: Date.now() - t,
      };
    },
  };
  return api;
}

/**
 * The browser the demo orchestrator talks to: the user's paired browser when there is one (most recent pairing of a
 * demo session – one presenter laptop, like the controller), else the normal controller / http browser.
 */
export function createSwitchBrowser(base, hub, { isDemoSession = () => true } = {}) {
  let cache = null; // { key, adapter }
  function current() {
    const r = hub ? hub.latest(isDemoSession) : null;
    if (!r) { cache = null; return base; }
    const key = `${r.session_id}|${hub.status(r.session_id).since}`;
    if (!cache || cache.key !== key) cache = { key, adapter: createCompanionBrowser(r, { fallback: base }) };
    return cache.adapter;
  }
  const sw = {
    get mode() { return current().mode; },
    get lastFallback() { return current().lastFallback; },
    currentUrl: () => current().currentUrl(),
    base,
  };
  for (const op of ['open', 'scroll', 'highlight', 'back', 'reload', 'snapshot', 'checkout']) sw[op] = (...args) => current()[op](...args);
  return sw;
}
