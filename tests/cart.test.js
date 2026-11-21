// Cart: pure model (totals, quantities, lines from other sources), cart intents, the real policy at the cart
// level, and the audit chain with cart events. The orchestrator flow lives in orchestrator.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCart, addItem, setQty, removeLine, clearLines, cartTotals, cartView, findLine, lineTotals, MAX_LINE_QTY,
} from '../apps/agent/src/cart.js';
import { route, matchCart } from '../apps/agent/src/intents.js';
import { evaluate, DEFAULT_POLICY } from '../apps/agent/src/policy.js';
import { createStore } from '../apps/agent/src/store.js';
import { createAudit } from '../apps/agent/src/audit.js';
import { hashEvent } from '../packages/contracts/index.js';
import { computeTotals } from '../packages/contracts/index.js';

const SHOES = { sku: 'RH-STW-GL5-W', title: "Stridewell Glide 5 – Men's Wide", brand: 'Stridewell', category: 'running_shoes', merchant_id: 'runhub', store_name: 'RunHub', url: 'http://x/p/RH-STW-GL5-W', unit_price: 129.95, seen_at: '2026-11-20T10:00:00.000Z', snapshot_id: 'snap_0001' };
const KESTREL = { sku: 'DC-KST-TP2-W', title: 'Kestrel Tempo 2 Wide', brand: 'Kestrel', category: 'running_shoes', merchant_id: 'dailycart', store_name: 'DailyCart', url: 'http://x/p/DC-KST-TP2-W', unit_price: 119 };
const COFFEE = { sku: 'DC-MRW-HB-12', title: 'Morrow House Blend – 12 oz whole bean', brand: 'Morrow Roasters', category: 'coffee', merchant_id: 'dailycart', store_name: 'DailyCart', url: 'http://x/p/DC-MRW-HB-12', unit_price: 18.4 };

test('cart totals: per line like one order, per store, grand total = sum of the orders', () => {
  const c = createCart();
  addItem(c, SHOES, 1);
  addItem(c, COFFEE, 2);
  addItem(c, KESTREL, 1);
  const t = cartTotals(c);
  assert.equal(t.item_count, 4);
  assert.deepEqual(t.stores.map((x) => [x.merchant_id, x.item_count, x.subtotal, x.tax, x.shipping, x.total]), [
    ['runhub', 1, 129.95, 11.21, 0, 141.16],
    ['dailycart', 3, 155.8, 13.43, 0, 169.23],
  ]);
  const orders = c.lines.map((l) => computeTotals(l.unit_price, l.qty, 0).total);
  assert.equal(t.total, Math.round(orders.reduce((a, b) => a + b, 0) * 100) / 100);
  assert.equal(t.total, 310.39);
  assert.equal(t.subtotal, 285.75);
  assert.equal(t.tax, 24.64);
  assert.equal(cartView(c).lines[1].line_total, 36.8);
});

test('cart totals: shipping from the catalog is added, re-checked prices replace the added ones', () => {
  const c = createCart();
  const { line } = addItem(c, { ...SHOES, shipping_cost: 6.5 }, 1);
  assert.deepEqual(lineTotals(line), { subtotal: 129.95, tax: 11.21, shipping: 6.5, total: 147.66, currency: 'USD' });
  assert.equal(cartTotals(c).shipping, 6.5);
  assert.equal(cartTotals(c, { [line.line_id]: 139.95 }).total, 158.52);
  assert.equal(cartTotals(c).total, 147.66, 'the cart itself is unchanged');
});

test('cart: same sku adds up (capped), quantity set / 0 removes, clear', () => {
  const c = createCart();
  const a = addItem(c, COFFEE, 1);
  const b = addItem(c, { ...COFFEE, unit_price: 18.9, seen_at: '2026-11-20T11:00:00.000Z' }, 2);
  assert.equal(c.lines.length, 1);
  assert.equal(a.line, b.line);
  assert.deepEqual([b.added, b.qty_before, b.line.qty, b.line.unit_price], [2, 1, 3, 18.9]);
  const cap = addItem(c, COFFEE, 50);
  assert.equal(cap.line.qty, MAX_LINE_QTY);
  assert.equal(addItem(c, COFFEE, 1).added, 0);
  assert.equal(setQty(c, a.line.line_id, 4).qty_before, MAX_LINE_QTY);
  assert.equal(c.lines[0].qty, 4);
  assert.equal(setQty(c, 'line_nope', 1), null);
  assert.equal(setQty(c, a.line.line_id, 0).removed, true);
  assert.equal(c.lines.length, 0);
  addItem(c, SHOES); addItem(c, KESTREL);
  assert.equal(removeLine(c, c.lines[0].line_id).line.sku, SHOES.sku);
  clearLines(c, c.lines.map((l) => l.line_id));
  assert.equal(cartTotals(c).total, 0);
  assert.throws(() => addItem(c, { ...SHOES, unit_price: null }), /seen price/);
});

test('cart: a line from another source (real store / price comparison) is listed, never totalled or checked out', () => {
  const c = createCart();
  addItem(c, COFFEE, 1);
  const ext = addItem(c, { sku: 'shop.example/products/x', title: 'Trail shoe', merchant_id: 'shop.example', store_name: 'shop.example', url: 'https://shop.example/products/x', unit_price: 99, source: 'external' }, 1);
  assert.equal(ext.line.source, 'external');
  const t = cartTotals(c);
  assert.equal(t.total, 19.99);
  assert.equal(t.external_count, 1);
  assert.equal(t.line_count, 1);
  assert.equal(cartView(c).lines[1].line_total, null);
});

test('cart: findLine by brand, title word, category word, ordinal, pronoun', () => {
  const c = createCart();
  addItem(c, SHOES); addItem(c, COFFEE); addItem(c, KESTREL);
  assert.equal(findLine(c, 'the kestrel').sku, KESTREL.sku);
  assert.equal(findLine(c, 'the glide').sku, SHOES.sku);
  assert.equal(findLine(c, 'the coffee').sku, COFFEE.sku);
  assert.equal(findLine(c, 'the shoes').sku, KESTREL.sku, 'newest matching line');
  assert.equal(findLine(c, 'the first item').sku, SHOES.sku);
  assert.equal(findLine(c, 'it').sku, KESTREL.sku);
  assert.equal(findLine(c, 'the umbrella'), null);
  assert.equal(findLine(createCart(), 'it'), null);
});

test('cart intents: add / show / remove / quantity / checkout, and what stays a direct purchase', () => {
  const opts = { state: 'AWAIT_CHOICE', optionCount: 3, options: [{ brand: 'Stridewell', title: 'Stridewell Glide 5' }, { brand: 'Kestrel', title: 'Kestrel Tempo 2' }, { brand: 'Ondra', title: 'Ondra Cloudpath' }] };
  const full = { ...opts, cartCount: 2 };
  const one = (text, ctx) => route(text, ctx);
  assert.deepEqual(one('Add this to my cart.', opts), [{ intent: 'cart_add', args: { target: 'this', qty: 1 } }]);
  assert.deepEqual(one('add to cart', opts), [{ intent: 'cart_add', args: { target: 'this', qty: 1 } }]);
  assert.deepEqual(one('Put the coffee in the cart too.', opts), [{ intent: 'cart_add', args: { target: 'the coffee', qty: 1 } }]);
  assert.deepEqual(one('Add two of these to the cart', opts), [{ intent: 'cart_add', args: { target: 'these', qty: 2 } }]);
  assert.deepEqual(one("What's in my cart?", opts), [{ intent: 'cart_show', args: {} }]);
  assert.deepEqual(one('show me my cart', { state: 'IDLE' }), [{ intent: 'cart_show', args: {} }]);
  assert.deepEqual(one('Remove the shoes.', opts), [{ intent: 'cart_remove', args: { target: 'the shoes' } }]);
  assert.deepEqual(one('take the shoes out', full), [{ intent: 'cart_remove', args: { target: 'the shoes' } }]);
  assert.deepEqual(one('empty my cart', full), [{ intent: 'cart_remove', args: { all: true } }]);
  assert.deepEqual(one('Make it two.', full), [{ intent: 'cart_qty', args: { target: 'it', qty: 2 } }]);
  assert.deepEqual(one('change the coffee to 3', full), [{ intent: 'cart_qty', args: { target: 'the coffee', qty: 3 } }]);
  assert.deepEqual(one('Check out.', full), [{ intent: 'cart_checkout', args: {} }]);
  assert.deepEqual(one('Buy everything.', full), [{ intent: 'cart_checkout', args: {} }]);
  assert.deepEqual(one('buy everything in my cart', { state: 'DONE' }), [{ intent: 'cart_checkout', args: {} }]);
  assert.deepEqual(one('add the coffee to my cart and check out', { state: 'DONE', cartCount: 1 }), [
    { intent: 'cart_add', args: { target: 'the coffee', qty: 1 } }, { intent: 'cart_checkout', args: {} }]);
  // unchanged: with an empty cart "check out" buys the current option; picks and buys stay picks and buys
  assert.deepEqual(one('Check out.', opts), [{ intent: 'select', args: {} }]);
  assert.deepEqual(one('Take the first one.', full), [{ intent: 'select', args: { index: 0 } }]);
  assert.deepEqual(one('Buy this one.', full), [{ intent: 'select', args: {} }]);
  assert.deepEqual(one('Another one', full), [{ intent: 'next', args: {} }]);
  assert.deepEqual(one('by next friday', { state: 'CLARIFY' }), [{ intent: 'answer_clarify', args: { text: 'by next friday' } }]);
  assert.deepEqual(one('Reorder my usual coffee.', { state: 'DONE', cartCount: 1 }), [{ intent: 'reorder', args: { category: 'coffee' } }]);
  assert.equal(matchCart('i need running shoes for a half marathon', {}), null);
});

test('real policy at the cart level: $150.00 is auto, $150.01 needs approval, deny rules still win', () => {
  const at = (total) => evaluate({ policy: DEFAULT_POLICY, merchant_id: 'runhub', category: 'running_shoes', qty: 1, totals: { total, currency: 'USD' } });
  assert.equal(at(150).decision, 'AUTO_APPROVE');
  assert.equal(at(150.01).decision, 'REQUIRE_APPROVAL');
  assert.deepEqual(at(150.01).rules, ['total_over_limit']);
  const two = evaluate({ policy: DEFAULT_POLICY, merchant_id: 'dailycart', qty: 1, totals: { total: 20 }, orders_today: 2 });
  assert.equal(two.decision, 'AUTO_APPROVE', 'one more order today is fine');
  const three = evaluate({ policy: DEFAULT_POLICY, merchant_id: 'dailycart', qty: 1, totals: { total: 20 }, orders_today: 3 });
  assert.deepEqual(three.rules, ['daily_order_limit'], 'the cart passes orders_today + orders to place - 1');
  assert.equal(evaluate({ policy: DEFAULT_POLICY, merchant_id: 'runhub', qty: 1, totals: { total: 20 }, in_stock: false }).decision, 'DENY');
});

test('audit chain with cart events: verifies, and a changed cart total in one event breaks it there', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'shopz-cart-audit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await createStore({ uri: '', dataDir: dir });
  const audit = createAudit(store);
  const sid = 'ses_cart_chain';
  await audit.append(sid, 'session_started', 'system', 'Session started', {});
  await audit.append(sid, 'cart_item_added', 'agent', 'Added 1 × Stridewell', { sku: SHOES.sku, qty: 1, unit_price: 129.95, cart_total: 141.16 });
  await audit.append(sid, 'cart_quantity_changed', 'user', 'Changed coffee from 1 to 2', { sku: COFFEE.sku, qty_before: 1, qty: 2, cart_total: 181.13 });
  await audit.append(sid, 'cart_checkout_started', 'agent', 'Checking out the cart', { total_as_added: 181.13 });
  await audit.append(sid, 'cart_checkout_done', 'agent', 'Cart checked out', { total: 181.13 });
  await assert.rejects(audit.append(sid, 'cart_teleported', 'agent', 'x', {}), /unknown event type/);
  let v = await audit.verify(sid);
  assert.deepEqual([v.ok, v.count], [true, 5]);
  store._mem.audit.get(sid)[2].data.cart_total = 99.99; // somebody edits the stored total afterwards
  v = await audit.verify(sid);
  assert.deepEqual([v.ok, v.bad_seq, v.reason], [false, 3, 'hash_mismatch']);
  store._mem.audit.get(sid)[2].data.cart_total = 181.13;
  const forged = store._mem.audit.get(sid)[2]; // or edits it AND recomputes its own hash: the next event no longer points to it
  forged.data.cart_total = 99.99;
  forged.hash = hashEvent(forged);
  v = await audit.verify(sid);
  assert.deepEqual([v.ok, v.bad_seq, v.reason], [false, 4, 'prev_hash_mismatch']);
  forged.data.cart_total = 181.13;
  forged.hash = hashEvent(forged);
  assert.equal((await audit.verify(sid)).ok, true);
  store._mem.audit.get(sid).splice(1, 1); // or drops an event
  v = await audit.verify(sid);
  assert.deepEqual([v.ok, v.bad_seq, v.reason], [false, 2, 'seq_gap']);
});
