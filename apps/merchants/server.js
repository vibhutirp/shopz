// Shopz demo merchants: RunHub (RUNHUB_PORT, default 4001) and DailyCart (DAILYCART_PORT, default 4002)
// from one process. Plain Node (>= 18), no dependencies. All products, ratings and reviews are fictional.
// Contract: docs/CONTRACTS.md §1.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { STORES, SECTIONS, DEMO_ZIP, computeTotals, roundCents, loadEnv } from '../../packages/contracts/index.js';
import { freshProducts, returnsFor, CATEGORY_KEYWORDS, SELLERS, DEFAULT_SIZE } from './catalog.js';
import * as V from './views.js';

const MAX_QTY = 10;
const TEST_CARD_DIGITS = '4242424242424242';

const CORS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '600',
});

// ------------------------------------------------------------------ store state

function parsePort(v, fallback) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

function createStore(id, { port, publicUrl } = {}) {
  const meta = STORES[id];
  const envPrefix = id.toUpperCase();
  const p = parsePort(port ?? process.env[`${envPrefix}_PORT`], meta.port);
  const baseUrl = String(publicUrl || process.env[`${envPrefix}_PUBLIC_URL`] || `http://localhost:${p}`).replace(/\/+$/, '');
  const ctx = { id, name: meta.name, meta, port: p, baseUrl, state: null };
  ctx.reset = () => {
    ctx.state = { products: freshProducts(id), nextOrder: meta.firstOrder, orders: new Map(), tokens: new Map() };
  };
  ctx.reset();
  return ctx;
}

function httpError(status, code, message) {
  const err = new Error(message || code);
  err.status = status;
  err.code = code;
  return err;
}

function sizeFromCode(d) {
  let s;
  if (d.length === 3) s = `${d.slice(0, 2)}.${d[2]}`;
  else if (d[0] === '8' || d[0] === '9') s = `${d[0]}.${d[1]}`;
  else s = d;
  return s.replace(/\.0$/, '');
}

/** Exact sku, or a size-suffixed variant like RH-STW-GL5-W-105 (→ size 10.5). Only this store's products. */
function findProduct(ctx, raw) {
  let sku = '';
  try { sku = decodeURIComponent(String(raw ?? '')).trim().toUpperCase(); } catch { sku = String(raw ?? '').trim().toUpperCase(); }
  if (!sku) return { p: null, sku };
  const exact = ctx.state.products.find((x) => x.sku === sku);
  if (exact) return { p: exact, sku };
  const m = sku.match(/^(.+)-(\d{2,3})$/);
  if (m) {
    const base = ctx.state.products.find((x) => x.sku === m[1]);
    if (base) return { p: base, sku, size: sizeFromCode(m[2]) };
  }
  return { p: null, sku };
}

function productUrl(ctx, p) {
  return `${ctx.baseUrl}/p/${p.sku}`;
}

function summary(ctx, p) {
  const eta = V.etaFor(p.delivery_days);
  return {
    sku: p.sku,
    store: ctx.id,
    store_name: ctx.name,
    brand: p.brand,
    title: p.title,
    category: p.category,
    price: p.price,
    currency: 'USD',
    rating: { stars: p.rating.stars, count: p.rating.count },
    in_stock: p.in_stock,
    eta_date: eta.iso,
    shipping_cost: 0,
    widths: [...p.widths],
    sizes: [...p.sizes],
    url: productUrl(ctx, p),
    delivery_days: p.delivery_days,
  };
}

function detail(ctx, p) {
  const eta = V.etaFor(p.delivery_days);
  const ret = returnsFor(ctx.id, p.category);
  const crit = V.criticalReview(p);
  const seller = SELLERS[ctx.id];
  const specs = p.category === 'running_shoes' ? { cushion: p.specs.cushion } : { roast: p.specs.roast };
  return {
    ...summary(ctx, p),
    demo_data: true,
    description: p.description,
    ...(p.colorway ? { colorway: p.colorway } : {}),
    ...(p.pack ? { pack: p.pack } : {}),
    delivery: { eta_date: eta.iso, eta_text: eta.long, shipping_cost: 0, zip: DEMO_ZIP, delivery_days: p.delivery_days },
    specs: { ...specs, items: p.specs.items.map(([label, value]) => ({ label, value })) },
    reviews: {
      avg: p.rating.stars,
      count: p.rating.count,
      distribution: [5, 4, 3, 2, 1].map((stars, i) => ({ stars, percent: p.distribution[i] })),
      critical_quote: crit ? crit.text : null,
      critical_review_id: crit ? crit.id : null,
      items: [...p.reviews]
        .sort((a, b) => b.helpful - a.helpful)
        .map((r) => ({ id: r.id, author: r.author, date: r.date, stars: r.stars, title: r.title, text: r.text, helpful: r.helpful, verified: r.verified, variant: r.variant, critical: Boolean(crit && r.id === crit.id) })),
    },
    returns: { window_days: ret.window_days, policy_text: ret.policy_text, summary: ret.summary },
    seller: { ...seller },
    sections: [...SECTIONS],
    simulated: {
      price_changed: Math.abs(p.price - p.base.price) > 0.0001,
      base_price: p.base.price,
      in_stock_changed: p.in_stock !== p.base.in_stock,
      delivery_changed: p.delivery_days !== p.base.delivery_days,
    },
  };
}

// ------------------------------------------------------------------ search

const STOP = new Set(['a', 'an', 'the', 'for', 'and', 'or', 'with', 'in', 'on', 'of', 'to', 'my', 'me', 'i', 'some', 'any', 'need', 'want', 'looking', 'buy', 'find', 'show', 'get', 'pair', 'please', 'new', 'good', 'best', 'size', 'men', 'women', 'under', 'below', 'by', 'from', 'at', 'that', 'this', 'is', 'are', 'it', 'be', 'something', 'usual']);

function stem(w) {
  return w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
}

function tokens(s) {
  return String(s ?? '').toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9]+/).filter(Boolean).map(stem);
}

const CATEGORY_ALIASES = { shoes: 'running_shoes', shoe: 'running_shoes', running: 'running_shoes', running_shoe: 'running_shoes', sneakers: 'running_shoes', coffee_beans: 'coffee', beans: 'coffee' };

function normCategory(c) {
  const k = String(c ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!k) return '';
  return CATEGORY_ALIASES[k] || k;
}

function haystack(p) {
  return tokens([p.title, p.brand, p.category.replace(/_/g, ' '), (CATEGORY_KEYWORDS[p.category] || []).join(' '), p.colorway || ''].join(' '));
}

/** Words of q matched against title/brand/category words (any word counts, more matches rank first). Empty q = all. */
function search(ctx, q, category) {
  const cat = normCategory(category);
  const list = ctx.state.products.filter((p) => !cat || p.category === cat);
  const words = tokens(q).filter((t) => !STOP.has(t) && !/^\d+$/.test(t));
  if (!words.length) return list;
  return list
    .map((p, i) => {
      const hay = haystack(p);
      const score = words.filter((w) => hay.some((h) => h === w || (w.length >= 4 && h.startsWith(w)))).length;
      return { p, i, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.p);
}

// ------------------------------------------------------------------ orders

function parseBool(v) {
  if (v === true || v === false) return v;
  const s = String(v).trim().toLowerCase();
  if (['true', '1', 'yes'].includes(s)) return true;
  if (['false', '0', 'no'].includes(s)) return false;
  return null;
}

function strictQty(v) {
  if (v === undefined || v === null || v === '') return 1;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= MAX_QTY ? n : null;
}

function clampQty(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_QTY);
}

function lineFor(p, { qty, size, width }) {
  if (p.category !== 'running_shoes') return { qty };
  const s = String(size ?? '').trim();
  const w = String(width ?? '').trim().toUpperCase();
  return { qty, size: p.sizes.includes(s) ? s : DEFAULT_SIZE, width: p.widths.includes(w) ? w : p.widths[0] };
}

function clip(v, fallback, max = 120) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  return s || fallback;
}

function shipFrom(src) {
  const get = (k) => (typeof src.get === 'function' ? src.get(k) : src[k]);
  const d = V.DEMO_ADDRESS;
  return { name: clip(get('name'), d.name), address: clip(get('address'), d.address), city: clip(get('city'), d.city), state: clip(get('state'), d.state, 20), zip: clip(get('zip'), d.zip, 10) };
}

function placeOrder(ctx, p, line, { executor, ship, session_id, user_id }) {
  const order_id = `${ctx.meta.orderPrefix}${ctx.state.nextOrder++}`;
  const ret = returnsFor(ctx.id, p.category);
  const eta = V.etaFor(p.delivery_days);
  const item = { sku: p.sku, title: p.title, qty: line.qty, unit_price: p.price };
  if (line.size) Object.assign(item, { size: line.size, width: line.width });
  const order = {
    order_id,
    session_id: typeof session_id === 'string' ? session_id.slice(0, 200) : null,
    user_id: typeof user_id === 'string' ? user_id.slice(0, 200) : null,
    merchant_id: ctx.id,
    items: [item],
    totals: computeTotals(p.price, line.qty, 0),
    delivery_eta: eta.iso,
    return_policy: ret.policy_text,
    price_change: null,
    policy_decision_event_id: null,
    approval: null,
    executor,
    demo_data: true,
    status: 'confirmed',
    placed_at: new Date().toISOString(),
    audit_head_hash: null,
    store_name: ctx.name,
    ship_to: { ...ship },
    confirmation_text: `Order ${order_id} confirmed`,
  };
  ctx.state.orders.set(order_id, order);
  console.log(`[${ctx.id}] order ${order_id}: ${p.sku} x${line.qty}, total ${order.totals.total.toFixed(2)} USD (${executor})`);
  return order;
}

// ------------------------------------------------------------------ http plumbing

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw httpError(413, 'body_too_large');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    if (type.includes('json')) throw httpError(400, 'invalid_json', 'Body is not valid JSON.');
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function send(res, status, body, type, extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}

const json = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', CORS);
const html = (res, status, page) => send(res, status, page, 'text/html; charset=utf-8');

function redirect(res, location) {
  res.writeHead(303, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function requireMethod(method, ...allowed) {
  if (!allowed.includes(method)) throw httpError(405, 'method_not_allowed', `Use ${allowed.join(' or ')}.`);
}

// ------------------------------------------------------------------ JSON API + admin

async function routeApi(ctx, req, res, method, path, url) {
  let m;
  if (path === '/health' || path === '/api/health') {
    return json(res, 200, { ok: true, store: ctx.id, name: ctx.name, demo_data: true, products: ctx.state.products.length });
  }

  if (path === '/api/search') {
    requireMethod(method, 'GET');
    const q = url.searchParams.get('q') || '';
    const category = url.searchParams.get('category') || '';
    const results = search(ctx, q, category).map((p) => summary(ctx, p));
    return json(res, 200, { store: ctx.id, store_name: ctx.name, query: q, category: normCategory(category) || null, count: results.length, results });
  }

  if (path === '/api/products') {
    requireMethod(method, 'GET');
    return json(res, 200, { store: ctx.id, results: ctx.state.products.map((p) => summary(ctx, p)) });
  }

  if ((m = path.match(/^\/api\/products\/([^/]+)(\/sections)?$/))) {
    requireMethod(method, 'GET');
    const { p, sku } = findProduct(ctx, m[1]);
    if (!p) return json(res, 404, { error: 'not_found', sku, store: ctx.id });
    if (m[2]) return json(res, 200, { sku: p.sku, url: productUrl(ctx, p), sections: V.sectionsPayload(ctx, p) });
    return json(res, 200, detail(ctx, p));
  }

  if (path === '/api/checkout') {
    requireMethod(method, 'POST');
    const body = await readBody(req);
    const { p, sku, size } = findProduct(ctx, body.sku);
    if (!p) return json(res, 404, { error: 'unknown_sku', sku: sku || null, store: ctx.id });
    const qty = strictQty(body.qty);
    if (qty === null) return json(res, 400, { error: 'invalid_qty', message: `qty must be an integer from 1 to ${MAX_QTY}` });
    if (!p.in_stock) return json(res, 409, { error: 'out_of_stock', sku: p.sku });
    const key = typeof body.idempotency_key === 'string' && body.idempotency_key ? `api:${body.idempotency_key}` : null;
    if (key && ctx.state.tokens.has(key)) return json(res, 200, ctx.state.orders.get(ctx.state.tokens.get(key)));
    const line = lineFor(p, { qty, size: body.size ?? size, width: body.width });
    const order = placeOrder(ctx, p, line, { executor: 'api', ship: { ...V.DEMO_ADDRESS }, session_id: body.session_id, user_id: body.user_id });
    if (key) ctx.state.tokens.set(key, order.order_id);
    return json(res, 200, order);
  }

  if ((m = path.match(/^\/api\/orders\/([^/]+)$/))) {
    requireMethod(method, 'GET');
    const order = ctx.state.orders.get(decodeURIComponent(m[1]).toUpperCase());
    if (!order) return json(res, 404, { error: 'not_found', order_id: m[1] });
    return json(res, 200, order);
  }

  if (path === '/admin/scenario') {
    requireMethod(method, 'POST');
    const body = await readBody(req);
    const { p, sku } = findProduct(ctx, body.sku);
    if (!p) return json(res, 404, { ok: false, error: 'unknown_sku', sku: sku || null, store: ctx.id });
    const has = (k) => body[k] !== undefined && body[k] !== null && body[k] !== '';
    const next = {};
    if (has('price')) {
      const n = Number(body.price);
      if (!Number.isFinite(n) || n <= 0 || n > 100000) return json(res, 400, { ok: false, error: 'invalid_price' });
      next.price = roundCents(n);
    }
    if (has('in_stock')) {
      const b = parseBool(body.in_stock);
      if (b === null) return json(res, 400, { ok: false, error: 'invalid_in_stock' });
      next.in_stock = b;
    }
    if (has('delivery_days')) {
      const d = Number(body.delivery_days);
      if (!Number.isInteger(d) || d < 0 || d > 60) return json(res, 400, { ok: false, error: 'invalid_delivery_days' });
      next.delivery_days = d;
    }
    const changes = Object.entries(next).map(([k, v]) => `${k} ${p[k]} -> ${v}`);
    Object.assign(p, next);
    console.log(`[${ctx.id}] scenario ${p.sku}: ${changes.join(', ') || 'no change'} (simulated)`);
    const d = detail(ctx, p);
    return json(res, 200, { ok: true, product: summary(ctx, p), simulated: d.simulated });
  }

  if (path === '/admin/reset') {
    requireMethod(method, 'POST');
    ctx.reset();
    console.log(`[${ctx.id}] reset: catalog and order counter restored (next order ${ctx.meta.orderPrefix}${ctx.state.nextOrder})`);
    return json(res, 200, { ok: true, store: ctx.id, next_order_id: `${ctx.meta.orderPrefix}${ctx.state.nextOrder}` });
  }

  return json(res, 404, { error: 'not_found', path });
}

// ------------------------------------------------------------------ HTML pages

function notFound(ctx, res, what = 'Page not found', message = 'We could not find that page.') {
  return html(res, 404, V.renderMessage(ctx, { title: what, message, status: 404 }));
}

function productFromQuery(ctx, sp) {
  const { p, size } = findProduct(ctx, sp.get('sku'));
  if (!p) return { p: null };
  const line = lineFor(p, { qty: clampQty(sp.get('qty') ?? 1), size: sp.get('size') || size, width: sp.get('width') });
  return { p, line };
}

async function routePage(ctx, req, res, method, path, url) {
  const sp = url.searchParams;
  let m;
  if (path === '/favicon.ico') {
    res.writeHead(204, { 'Cache-Control': 'max-age=3600' });
    return res.end();
  }

  if (path === '/checkout/place') {
    if (method !== 'POST') {
      const back = productFromQuery(ctx, sp);
      return redirect(res, back.p ? `/checkout?${new URLSearchParams({ sku: back.p.sku, qty: String(back.line.qty) })}` : '/cart');
    }
    const body = await readBody(req);
    const token = typeof body.token === 'string' ? body.token : '';
    if (token && ctx.state.tokens.has(token)) return redirect(res, `/order/${ctx.state.tokens.get(token)}`);
    const { p, size } = findProduct(ctx, body.sku);
    if (!p) return notFound(ctx, res, 'Product not found', 'This item is not sold here.');
    if (!p.in_stock) return html(res, 409, V.renderMessage(ctx, { title: 'Out of stock', message: `${p.title} is out of stock, so the order was not placed.`, status: 409 }));
    if (body.card !== undefined && String(body.card).replace(/\D/g, '') !== TEST_CARD_DIGITS) {
      return html(res, 402, V.renderMessage(ctx, { title: 'Test card only', message: 'This demo store only accepts the test card 4242 4242 4242 4242. Nothing was charged.', status: 402 }));
    }
    const line = lineFor(p, { qty: clampQty(body.qty ?? 1), size: body.size || size, width: body.width });
    const order = placeOrder(ctx, p, line, { executor: 'web', ship: shipFrom(body) });
    if (token) ctx.state.tokens.set(token, order.order_id);
    return redirect(res, `/order/${order.order_id}`);
  }

  if (method !== 'GET') return html(res, 405, V.renderMessage(ctx, { title: 'Method not allowed', message: 'Use the links and buttons on the page.', status: 405 }));

  if (path === '/') return html(res, 200, V.renderHome(ctx, ctx.state.products));

  if (path === '/search') {
    const q = (sp.get('q') || '').slice(0, 200);
    const category = normCategory(sp.get('category'));
    const categories = [...new Set(ctx.state.products.map((p) => p.category))];
    return html(res, 200, V.renderSearch(ctx, { q, category, results: search(ctx, q, category), categories }));
  }

  if ((m = path.match(/^\/p\/([^/]+)$/))) {
    const { p, size } = findProduct(ctx, m[1]);
    if (!p) return notFound(ctx, res, 'Product not found', `${ctx.name} does not sell this item.`);
    return html(res, 200, V.renderProduct(ctx, p, { size: sp.get('size') || size }));
  }

  if (path === '/cart') {
    if (!sp.get('sku')) return html(res, 200, V.renderCart(ctx, null));
    const { p, line } = productFromQuery(ctx, sp);
    if (!p) return notFound(ctx, res, 'Product not found', `${ctx.name} does not sell this item.`);
    return html(res, 200, V.renderCart(ctx, p, line));
  }

  if (path === '/checkout') {
    const { p, line } = productFromQuery(ctx, sp);
    if (!p) return sp.get('sku') ? notFound(ctx, res, 'Product not found', `${ctx.name} does not sell this item.`) : redirect(res, '/cart');
    return html(res, 200, V.renderShipping(ctx, p, line));
  }

  if (path === '/checkout/payment') {
    const { p, line } = productFromQuery(ctx, sp);
    if (!p) return sp.get('sku') ? notFound(ctx, res, 'Product not found', `${ctx.name} does not sell this item.`) : redirect(res, '/cart');
    return html(res, 200, V.renderPayment(ctx, p, line, shipFrom(sp), randomUUID()));
  }

  if ((m = path.match(/^\/order\/([^/]+)$/))) {
    let id = m[1];
    try { id = decodeURIComponent(id); } catch { /* keep raw */ }
    const order = ctx.state.orders.get(id.toUpperCase());
    if (!order) return notFound(ctx, res, 'Order not found', 'We could not find that order. Orders reset when the demo store resets.');
    return html(res, 200, V.renderConfirmation(ctx, order));
  }

  return notFound(ctx, res);
}

function handler(ctx) {
  return async (req, res) => {
    let url;
    try { url = new URL(req.url || '/', 'http://localhost'); } catch { url = new URL('http://localhost/'); }
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const isApi = path === '/health' || path === '/api' || path.startsWith('/api/') || path.startsWith('/admin');
    try {
      if (method === 'OPTIONS') {
        res.writeHead(204, { ...CORS, 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (isApi) return await routeApi(ctx, req, res, method, path, url);
      return await routePage(ctx, req, res, method, path, url);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(`[${ctx.id}] ${req.method} ${req.url} failed:`, err);
      if (res.headersSent) return res.end();
      if (isApi) return json(res, status, { error: err.code || 'internal_error', message: status >= 500 ? 'Internal error' : err.message });
      return html(res, status, V.renderMessage(ctx, { title: status >= 500 ? 'Something went wrong' : 'Request problem', message: status >= 500 ? 'Please try again.' : err.message, status }));
    }
  };
}

// ------------------------------------------------------------------ start

/** Starts both stores. Options override env ports (RUNHUB_PORT / DAILYCART_PORT). Resolves once both listen. */
export async function startMerchants({ runhubPort, dailycartPort, host = process.env.MERCHANTS_HOST, quiet = false } = {}) {
  await loadEnv();
  await loadEnv(fileURLToPath(new URL('../../.env', import.meta.url)));
  const stores = [createStore('runhub', { port: runhubPort }), createStore('dailycart', { port: dailycartPort })];
  const servers = await Promise.all(stores.map((ctx) => new Promise((resolve, reject) => {
    const server = http.createServer(handler(ctx));
    server.once('error', (err) => reject(new Error(`${ctx.name}: cannot listen on port ${ctx.port} (${err.code || err.message})`)));
    const onListen = () => {
      if (!quiet) console.log(`${ctx.name} (${ctx.id}) listening on ${ctx.baseUrl}  · demo store, fictional data`);
      resolve(server);
    };
    if (host) server.listen(ctx.port, host, onListen);
    else server.listen(ctx.port, onListen);
  })));
  const close = () => Promise.all(servers.map((s) => new Promise((r) => { s.close(() => r()); s.closeAllConnections?.(); })));
  return { stores, servers, close };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  startMerchants()
    .then(({ close }) => {
      const stop = () => { close().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 1000).unref(); };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
