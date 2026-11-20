import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBrowser } from '../apps/agent/src/browser.js';
import { SECTIONS, computeTotals, sha256Hex } from '../packages/contracts/index.js';

// ---- stub merchant (RunHub) with /api/products/:sku[/sections] and /api/checkout ----------------------------
const PRODUCTS = {
  'RH-STW-GL5-W': { title: "Stridewell Glide 5 – Men's Wide", price: 129.95, eta: '2026-11-24' },
  'RH-OND-CP-W': { title: 'Ondra Cloudpath Wide', price: 138.0, eta: '2026-11-23' },
};
const RETURNS_TEXT = '30-day free returns on unworn items in the original box. Return shipping is free.';

function sectionsFor(sku) {
  const p = PRODUCTS[sku];
  // key order deliberately differs from the page order: 'all' must follow SECTIONS
  return {
    reviews: { text: `${p.title} · 4.6 out of 5 · 1,240 reviews · "Upper is not waterproof, my feet got wet." – Demo reviewer`, fields: { avg: 4.6, count: 1240, critical_quote: 'Upper is not waterproof, my feet got wet.' } },
    gallery: { text: 'Gallery · 4 images', fields: {} },
    price: { text: `${p.title} Stridewell $${p.price.toFixed(2)} 4.6 (1,240) In stock Sold by RunHub Size 10.5 Width 4E Qty 1 Add to cart`, fields: { price: p.price, currency: 'USD', in_stock: true, sku } },
    delivery: { text: `Arrives ${p.eta} to 94103 · Free shipping`, fields: { eta: p.eta, shipping: 0 } },
    specs: { text: 'Upper: engineered mesh (not waterproof) · Drop: 8 mm · Cushion: medium', fields: { cushion: 'medium' } },
    returns: { text: RETURNS_TEXT, fields: { window_days: 30, policy_text: RETURNS_TEXT } },
    seller: { text: 'Sold and shipped by RunHub · Demo store', fields: {} },
  };
}

const checkouts = [];
let nextOrder = 10482;

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function startMerchant() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://stub');
    const base = `http://127.0.0.1:${server.address().port}`;
    let m = url.pathname.match(/^\/api\/products\/([^/]+)\/sections$/);
    if (m && PRODUCTS[m[1]]) return json(res, 200, { sku: m[1], url: `${base}/p/${m[1]}`, sections: sectionsFor(m[1]) });
    m = url.pathname.match(/^\/api\/products\/([^/]+)$/);
    if (m && PRODUCTS[m[1]]) return json(res, 200, { sku: m[1], title: PRODUCTS[m[1]].title, price: PRODUCTS[m[1]].price });
    if (url.pathname === '/api/checkout' && req.method === 'POST') {
      const { sku, qty } = await readBody(req);
      const p = PRODUCTS[sku];
      if (!p) return json(res, 404, { error: 'unknown sku' });
      checkouts.push({ sku, qty });
      const order_id = `RH-${nextOrder++}`;
      return json(res, 200, { order_id, merchant_id: 'runhub', items: [{ sku, title: p.title, qty, unit_price: p.price }], totals: computeTotals(p.price, qty),
        delivery_eta: p.eta, return_policy: RETURNS_TEXT, executor: 'api', demo_data: true, status: 'confirmed', placed_at: new Date().toISOString() });
    }
    return json(res, 404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---- fake browser controller: health + open work, snapshot fails, checkout behavior switchable ----------------
const ctrlCalls = [];
let ctrlCheckout = 'error';
function startController() {
  const server = http.createServer(async (req, res) => {
    ctrlCalls.push(`${req.method} ${req.url}`);
    if (req.url === '/health') return json(res, 200, { ok: true, mode: 'headless' });
    if (req.url === '/open') { const { url } = await readBody(req); return json(res, 200, { ok: true, url, title: 'via controller' }); }
    if (req.url === '/scroll' || req.url === '/highlight') return json(res, 200, { ok: true });
    if (req.url.startsWith('/snapshot')) return json(res, 500, { error: 'page crashed' });
    if (req.url === '/checkout') return ctrlCheckout === 'error' ? json(res, 500, { error: 'checkout failed' }) : json(res, 200, { steps: [] });
    return json(res, 404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function closedPort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

let merchant;
let controller;
let port;
let merchants;
before(async () => {
  merchant = await startMerchant();
  controller = await startController();
  port = merchant.address().port;
  merchants = [{ id: 'runhub', name: 'RunHub', base: `http://127.0.0.1:${port}` }];
});
after(() => Promise.all([merchant, controller].map((s) => new Promise((r) => { s.close(r); s.closeAllConnections(); }))));

const pageUrl = (sku) => `http://127.0.0.1:${port}/p/${sku}`;

test('http mode: open/back history, exact section text, all-sections layout, checkout via API', async () => {
  const browser = await createBrowser({ controllerUrl: `http://127.0.0.1:${await closedPort()}`, merchants });
  assert.equal(browser.mode, 'http');
  assert.equal(browser.currentUrl(), null);
  await assert.rejects(browser.snapshot('price'), /no product page/);

  const o1 = await browser.open(pageUrl('RH-STW-GL5-W'));
  assert.deepEqual(o1, { ok: true, url: pageUrl('RH-STW-GL5-W'), title: PRODUCTS['RH-STW-GL5-W'].title });
  // a localhost URL maps to the configured merchant base (by port)
  await browser.open(`http://localhost:${port}/p/RH-OND-CP-W`);
  assert.equal(browser.currentUrl(), `http://localhost:${port}/p/RH-OND-CP-W`);
  const ondraPrice = await browser.snapshot('price');
  assert.equal(ondraPrice.text, sectionsFor('RH-OND-CP-W').price.text);
  assert.deepEqual(await browser.back(), { ok: true, url: pageUrl('RH-STW-GL5-W') });
  assert.deepEqual(await browser.scroll('reviews'), { ok: true });
  assert.deepEqual(await browser.highlight('reviews'), { ok: true });
  assert.deepEqual(await browser.reload(), { ok: true, url: pageUrl('RH-STW-GL5-W') });

  const rev = await browser.snapshot('reviews', { session_id: 'ses_b' });
  const expected = sectionsFor('RH-STW-GL5-W').reviews;
  assert.equal(rev.text, expected.text);
  assert.deepEqual(rev.fields, expected.fields);
  assert.equal(rev.sha256, sha256Hex(expected.text));
  assert.equal(rev.snapshot_id, 'snap_0002');
  assert.equal(rev.session_id, 'ses_b');
  assert.equal(rev.section, 'reviews');
  assert.equal(rev.url, `${pageUrl('RH-STW-GL5-W')}#reviews`);
  assert.ok(!Number.isNaN(Date.parse(rev.taken_at)));
  assert.deepEqual(Object.keys(rev), ['snapshot_id', 'session_id', 'url', 'section', 'taken_at', 'text', 'fields', 'sha256']);

  const all = await browser.snapshot('all');
  const secs = sectionsFor('RH-STW-GL5-W');
  const expectedText = SECTIONS.map((n) => `## ${n}\n${secs[n].text}`).join('\n\n');
  assert.equal(all.text, expectedText);
  assert.equal(all.sha256, sha256Hex(expectedText));
  assert.equal(all.url, pageUrl('RH-STW-GL5-W'));
  assert.equal(all.fields['price.price'], 129.95);
  assert.equal(all.fields['returns.window_days'], 30);
  assert.equal(all.fields['reviews.critical_quote'], 'Upper is not waterproof, my feet got wet.');
  assert.equal(all.snapshot_id, 'snap_0003');

  const empty = await browser.snapshot('nonexistent');
  assert.equal(empty.text, '');

  // a simulated price change shows up on the next read (no caching)
  PRODUCTS['RH-STW-GL5-W'].price = 139.95;
  await browser.reload();
  const bumped = await browser.snapshot('price');
  assert.equal(bumped.fields.price, 139.95);
  assert.match(bumped.text, /\$139\.95/);

  const result = await browser.checkout({ url: pageUrl('RH-STW-GL5-W'), sku: 'RH-STW-GL5-W', qty: 1 });
  assert.equal(result.order_id, 'RH-10482');
  assert.equal(result.executor, 'api');
  assert.equal(result.confirmation_text, 'Order RH-10482 confirmed');
  assert.deepEqual(result.totals, computeTotals(139.95, 1));
  assert.equal(result.totals.total, 152.02);
  assert.equal(result.delivery_eta, '2026-11-24');
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].step, 'api_checkout');
  assert.equal(result.steps[0].ok, true);
  assert.equal(typeof result.steps[0].ms, 'number');
  assert.deepEqual(checkouts.at(-1), { sku: 'RH-STW-GL5-W', qty: 1 });
  assert.equal(browser.lastFallback, null);
  PRODUCTS['RH-STW-GL5-W'].price = 129.95;
});

test('controller mode: failed controller call is retried in http mode and reported in lastFallback', async () => {
  const browser = await createBrowser({ controllerUrl: `http://127.0.0.1:${controller.address().port}`, merchants });
  assert.equal(browser.mode, 'controller');

  const opened = await browser.open(pageUrl('RH-OND-CP-W'));
  assert.equal(opened.title, 'via controller');
  assert.equal(browser.lastFallback, null);
  assert.equal(browser.currentUrl(), pageUrl('RH-OND-CP-W'));

  const snap = await browser.snapshot('returns');
  assert.equal(snap.text, RETURNS_TEXT);
  assert.equal(snap.sha256, sha256Hex(RETURNS_TEXT));
  assert.match(browser.lastFallback, /^snapshot: controller failed \(page crashed\)/);

  await browser.scroll('returns');
  assert.equal(browser.lastFallback, null); // reflects the latest call
  assert.ok(ctrlCalls.includes('POST /scroll'));

  ctrlCheckout = 'error';
  const before = checkouts.length;
  const order = await browser.checkout({ url: pageUrl('RH-OND-CP-W'), sku: 'RH-OND-CP-W', qty: 1 });
  assert.equal(order.executor, 'api');
  assert.match(browser.lastFallback, /^checkout:/);
  assert.equal(checkouts.length, before + 1);

  // controller answered but without an order id: the browser may have bought → no second (API) purchase
  ctrlCheckout = 'no-order-id';
  await assert.rejects(browser.checkout({ url: pageUrl('RH-OND-CP-W'), sku: 'RH-OND-CP-W', qty: 1 }), /no order id/);
  assert.equal(checkouts.length, before + 1);
});
