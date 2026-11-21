// Shared constants and helpers for every Shopz component. See docs/CONTRACTS.md.
import { createHash } from 'node:crypto';

export const PORTS = Object.freeze({ agent: 3000, runhub: 4001, dailycart: 4002, controller: 4100 });

export const STORES = Object.freeze({
  runhub: { id: 'runhub', name: 'RunHub', port: 4001, orderPrefix: 'RH-', firstOrder: 10482 },
  dailycart: { id: 'dailycart', name: 'DailyCart', port: 4002, orderPrefix: 'DC-', firstOrder: 20731 },
});

export const TAX_RATE = 0.08625;
export const DEMO_ZIP = '94103';

export const SECTIONS = Object.freeze(['gallery', 'price', 'delivery', 'specs', 'reviews', 'returns', 'seller']);

export const STATES = Object.freeze([
  'IDLE', 'CLARIFY', 'SEARCH', 'NARRATE', 'AWAIT_CHOICE', 'VERIFY', 'POLICY', 'APPROVE', 'CHECKOUT', 'DONE',
]);

export const INTENTS = Object.freeze([
  'request', 'answer_clarify', 'next', 'back', 'goto_option', 'show_section', 'ask', 'select', 'confirm', 'cancel', 'reorder', 'alternative',
  'cart_add', 'cart_remove', 'cart_qty', 'cart_show', 'cart_checkout',
]);

export const AUDIT_TYPES = Object.freeze([
  'session_started', 'utterance', 'clarify_question', 'preference_used', 'preference_saved', 'search_issued', 'search_result',
  'product_filtered', 'ranking', 'options_presented', 'page_opened', 'page_navigate', 'page_reload', 'page_read', 'answer_given',
  'answer_not_on_page', 'user_interrupt', 'barge_in', 'injection_ignored', 'option_selected', 'price_observed', 'stock_checked',
  'policy_decision', 'approval_requested', 'approval_granted', 'approval_denied', 'checkout_started', 'checkout_step',
  'order_confirmed', 'error', 'fallback_used',
  // live web mode: optional web search, and the hand-off to the store's own checkout (never an order by Shopz)
  'web_search', 'handoff',
  // cart: every change and the checkout of the whole cart are part of the chain
  'cart_item_added', 'cart_item_removed', 'cart_quantity_changed', 'cart_checkout_started', 'cart_checkout_done',
]);

export const SSE_TYPES = Object.freeze([
  'state', 'user.utterance', 'agent.say', 'speech.cancel', 'memory', 'constraints', 'options', 'policy', 'price_diff', 'order', 'audit', 'error', 'handoff', 'cart', 'cart_order',
]);

export const POLICY_DECISIONS = Object.freeze(['AUTO_APPROVE', 'REQUIRE_APPROVAL', 'DENY']);
export const APPROVAL_PHRASE = 'confirm purchase';
export const GENESIS_HASH = '0'.repeat(64);

/** Keys sorted recursively, no whitespace. Used for the audit hash chain. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

export function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** hash = sha256(prev_hash + canonicalJson(event without "hash")) */
export function hashEvent(event) {
  const { hash, ...rest } = event; // eslint-disable-line no-unused-vars
  return sha256Hex((rest.prev_hash || GENESIS_HASH) + canonicalJson(rest));
}

export function roundCents(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export function computeTotals(unitPrice, qty = 1, shipping = 0) {
  const subtotal = roundCents(unitPrice * qty);
  const tax = roundCents(subtotal * TAX_RATE);
  const ship = roundCents(shipping);
  return { subtotal, tax, shipping: ship, total: roundCents(subtotal + tax + ship), currency: 'USD' };
}

/** "Today" for every server: DEMO_TODAY=YYYY-MM-DD or the real local date (time stripped). */
export function today() {
  const fixed = process.env.DEMO_TODAY;
  if (fixed && /^\d{4}-\d{2}-\d{2}$/.test(fixed)) return new Date(fixed + 'T12:00:00');
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d;
}

export function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(d, n) {
  const c = new Date(d.getTime());
  c.setDate(c.getDate() + n);
  return c;
}

export function weekdayName(isoOrDate) {
  const d = typeof isoOrDate === 'string' ? new Date(isoOrDate + 'T12:00:00') : isoOrDate;
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()];
}

/** Minimal .env loader (no dependency). Does not override variables that are already set. */
export async function loadEnv(path = '.env') {
  const { readFile } = await import('node:fs/promises');
  let text;
  try { text = await readFile(path, 'utf8'); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined || process.env[m[1]] === '') process.env[m[1]] = v;
  }
}
