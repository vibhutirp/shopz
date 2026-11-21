// Shopz cart (pure, no I/O). One cart per session, lines from any store.
// A line keeps the price "as seen" when it was added; checkout re-checks every line on its page and runs the policy.
// Lines from the fictional demo stores can be checked out; lines from elsewhere (source "external", e.g. a real
// store or a price-comparison hit) only ever get "Open at store" – they are listed, never paid for, never in the total.
import { computeTotals, roundCents, TAX_RATE } from '../../../packages/contracts/index.js';

export const MAX_LINE_QTY = 10; // same cap as the demo stores' checkout API

const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
const clampQty = (q) => Math.max(0, Math.min(MAX_LINE_QTY, Math.floor(num(q))));

export function createCart() {
  return { lines: [], seq: 0, updated_at: null };
}

/** Totals of one line: the same rounding as one demo-store order (computeTotals per line). */
export function lineTotals(line, unitPrice = line.unit_price) {
  return computeTotals(num(unitPrice), line.qty, num(line.shipping_cost) || 0);
}

/**
 * Totals of the whole cart. Each demo-store line is one order, so the cart total is the exact sum of those orders.
 * stores: [{ merchant_id, store_name, lines, item_count, subtotal, tax, shipping, total }] in the order first added.
 * external lines are listed apart and never counted.
 * prices: optional { line_id → price now } to total the cart at re-checked prices.
 */
export function cartTotals(cart, prices = null) {
  const stores = [];
  const byStore = new Map();
  const external = [];
  let subtotal = 0; let tax = 0; let shipping = 0; let total = 0; let items = 0;
  for (const line of (cart && cart.lines) || []) {
    if (line.source === 'external') { external.push(line); continue; }
    const price = prices && prices[line.line_id] !== undefined ? prices[line.line_id] : line.unit_price;
    const t = lineTotals(line, price);
    let st = byStore.get(line.merchant_id);
    if (!st) {
      st = { merchant_id: line.merchant_id, store_name: line.store_name, line_ids: [], item_count: 0, subtotal: 0, tax: 0, shipping: 0, total: 0 };
      byStore.set(line.merchant_id, st);
      stores.push(st);
    }
    st.line_ids.push(line.line_id);
    st.item_count += line.qty;
    st.subtotal = roundCents(st.subtotal + t.subtotal);
    st.tax = roundCents(st.tax + t.tax);
    st.shipping = roundCents(st.shipping + t.shipping);
    st.total = roundCents(st.total + t.total);
    subtotal = roundCents(subtotal + t.subtotal);
    tax = roundCents(tax + t.tax);
    shipping = roundCents(shipping + t.shipping);
    total = roundCents(total + t.total);
    items += line.qty;
  }
  return {
    stores, external_count: external.length, item_count: items, line_count: (cart?.lines || []).length - external.length,
    subtotal, tax, shipping, total, currency: 'USD', tax_rate: TAX_RATE,
  };
}

/** Read-only view for the panel and the API (lines + totals). */
export function cartView(cart) {
  const totals = cartTotals(cart);
  return {
    lines: (cart?.lines || []).map((l) => ({ ...l, line_total: l.source === 'external' ? null : lineTotals(l).subtotal })),
    totals,
    updated_at: cart?.updated_at ?? null,
  };
}

/**
 * Add an item. The same sku again raises the quantity (capped at MAX_LINE_QTY).
 * item: { sku, title, brand, category, merchant_id, store_name, url, unit_price, currency, seen_at, snapshot_id,
 *         first_seen_price, shipping_cost, source ('demo' | 'external'), image_url }
 * → { line, added, qty_before }
 */
export function addItem(cart, item, qty = 1, nowIso = new Date().toISOString()) {
  const q = clampQty(qty) || 1;
  const price = num(item.unit_price);
  if (!item || !item.sku) throw new TypeError('cart.addItem: sku is required');
  if (!Number.isFinite(price) || price < 0) throw new TypeError('cart.addItem: a seen price is required');
  const existing = cart.lines.find((l) => l.sku === item.sku && l.merchant_id === item.merchant_id);
  if (existing) {
    const before = existing.qty;
    existing.qty = Math.min(MAX_LINE_QTY, existing.qty + q);
    existing.unit_price = price; // the newest price seen
    existing.seen_at = item.seen_at || nowIso;
    existing.snapshot_id = item.snapshot_id ?? existing.snapshot_id ?? null;
    cart.updated_at = nowIso;
    return { line: existing, added: existing.qty - before, qty_before: before };
  }
  cart.seq += 1;
  const line = {
    line_id: `line_${String(cart.seq).padStart(3, '0')}`,
    sku: String(item.sku), title: item.title || String(item.sku), brand: item.brand ?? null, category: item.category ?? null,
    merchant_id: item.merchant_id ?? null, store_name: item.store_name ?? item.merchant_id ?? null,
    url: item.url ?? null, image_url: item.image_url ?? null,
    unit_price: price, currency: item.currency || 'USD', seen_at: item.seen_at || nowIso, snapshot_id: item.snapshot_id ?? null,
    first_seen_price: Number.isFinite(num(item.first_seen_price)) ? num(item.first_seen_price) : price,
    shipping_cost: Number.isFinite(num(item.shipping_cost)) ? num(item.shipping_cost) : 0,
    source: item.source === 'external' ? 'external' : 'demo',
    qty: q, added_at: nowIso,
  };
  cart.lines.push(line);
  cart.updated_at = nowIso;
  return { line, added: q, qty_before: 0 };
}

/** Set a line's quantity; 0 removes it. → { line, qty_before, removed } | null */
export function setQty(cart, lineId, qty, nowIso = new Date().toISOString()) {
  const line = cart.lines.find((l) => l.line_id === lineId);
  if (!line) return null;
  const q = clampQty(qty);
  if (!Number.isFinite(q)) return null;
  const before = line.qty;
  if (q <= 0) {
    cart.lines = cart.lines.filter((l) => l !== line);
    cart.updated_at = nowIso;
    return { line, qty_before: before, removed: true };
  }
  line.qty = q;
  cart.updated_at = nowIso;
  return { line, qty_before: before, removed: false };
}

export function removeLine(cart, lineId, nowIso = new Date().toISOString()) {
  return setQty(cart, lineId, 0, nowIso);
}

export function clearLines(cart, lineIds, nowIso = new Date().toISOString()) {
  const ids = new Set(lineIds);
  cart.lines = cart.lines.filter((l) => !ids.has(l.line_id));
  cart.updated_at = nowIso;
}

const CATEGORY_WORDS = [
  ['running_shoes', /\b(?:shoes?|sneakers?|runners?|trainers?|pair)\b/],
  ['coffee', /\b(?:coffee|beans?|espresso|blend|bag)\b/],
];
const ORDINAL = { first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2, fourth: 3, '4th': 3, fifth: 4, '5th': 4 };

/**
 * Which cart line does a phrase mean? Brand / title word, category word ("the shoes"), ordinal ("the second item"),
 * "last" or a pronoun (→ the newest line). → line | null. Ambiguous category words pick the newest matching line.
 */
export function findLine(cart, phrase) {
  const lines = (cart && cart.lines) || [];
  if (!lines.length) return null;
  const n = String(phrase || '').toLowerCase();
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const brand = String(lines[i].brand || '').toLowerCase().split(/\s+/)[0];
    if (brand && brand.length > 2 && new RegExp(`\\b${brand.replace(/[^a-z0-9]/g, '')}\\b`).test(n)) return lines[i];
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const words = String(lines[i].title || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !['wide', "men's", 'mens', 'whole', 'bean'].includes(w));
    if (words.some((w) => new RegExp(`\\b${w}\\b`).test(n))) return lines[i];
  }
  for (const [category, re] of CATEGORY_WORDS) {
    if (re.test(n)) {
      for (let i = lines.length - 1; i >= 0; i -= 1) if (lines[i].category === category) return lines[i];
    }
  }
  const m = n.match(/\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|last)\b/);
  if (m) return m[1] === 'last' ? lines[lines.length - 1] : lines[ORDINAL[m[1]]] || null;
  if (/\b(?:it|that|this|them|those|these|one)\b/.test(n) || !n.trim()) return lines[lines.length - 1];
  return null;
}

/** Short spoken list: "1 Stridewell Glide 5 from RunHub and 2 Morrow House Blend from DailyCart". */
export function spokenLines(cart, nameOf = (l) => l.title) {
  const parts = ((cart && cart.lines) || []).map((l) => `${l.qty} ${nameOf(l)}${l.store_name ? ` from ${l.store_name}` : ''}`);
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
