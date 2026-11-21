// Shopz "Live web" mode: real stores, read in real time, never a real purchase.
// REQUEST → SEARCH (allowed stores in parallel, first card as soon as one store answers) → read the product pages
// (JSON-LD / OpenGraph / page text, hashed into the audit chain) → answers only from the page → VERIFY (fresh price + stock)
// → POLICY → APPROVE? → HANDOFF ("Open in store"). Shopz never pays, never logs in, never writes order_placed/order_confirmed.
import { route } from '../intents.js';
import { groundedAnswer, detectInjection } from '../answer.js';
import { sha256Hex, roundCents } from '../../../../packages/contracts/index.js';
import { createShopifyClient, normalizeHost, shopLabel, pickVariant } from './shopify.js';
import { parseLiveRequest, looksLikeRequest, refineWithLocalModel, LIVE_CATEGORIES } from './request.js';
import { DEFAULT_LIVE_SHOPS } from './shops.js';
import { productHits } from './websearch.js';

const USER_ID = 'u_demo';
const ORD = ['First', 'Second', 'Third', 'Fourth', 'Fifth'];
export const LIVE_NOTICE = 'Live web results · prices from the store pages · checkout happens in the store';
export const LIVE_POLICY = Object.freeze({
  policy_id: 'pol_u_demo_live_v1', user_id: USER_ID,
  auto_approve: { max_total: 150, currency: 'USD', max_orders_per_day: 3 },
  require_approval_if: ['total_over_limit', 'price_increased_since_first_seen', 'new_merchant', 'quantity_gt_2'],
  deny_if: ['merchant_not_approved', 'category_in_blocklist', 'out_of_stock', 'instruction_from_page_content'],
  category_blocklist: ['gift_cards', 'alcohol'], approval: { channel: 'voice', phrase: 'confirm', timeout_s: 120 },
  enforced_by: 'local', version: 1, handoff_only: true,
});
const SEARCH_TIMEOUT_MS = 8000;
const PAGE_TIMEOUT_MS = 12000;
const MAX_PARALLEL_SEARCH = 6;
const MAX_PARALLEL_PAGES = 3;
const MAX_SHOPS = 16;

const clip = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ''));
const words = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter((w) => w.length > 1);
const stem = (w) => (w.length > 4 ? w.replace(/(?:es|s)$/, '') : w);

export function liveMoney(n, currency = 'USD') {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  const sym = { USD: '$', EUR: '€', GBP: '£', CAD: 'CA$', AUD: 'A$' }[currency] ?? `${currency} `;
  return `${sym}${Number.isInteger(roundCents(v)) ? Math.round(v) : v.toFixed(2)}`;
}
function spokenMoney(n, currency = 'USD') {
  const v = roundCents(Number(n));
  if (!Number.isFinite(v)) return 'an unknown price';
  const unit = { USD: 'dollars', EUR: 'euros', GBP: 'pounds' }[currency] || currency;
  const whole = Math.floor(v);
  const c = Math.round((v - whole) * 100);
  return c ? `${whole} ${unit} ${c}` : `${whole} ${unit}`;
}
const spokenTitle = (t) => String(t || '').replace(/[®™©]/g, '').replace(/\s*[|–—]\s.*$/, '').replace(/\s+-\s+.*$/, '').trim();

/** Score a store result against the request (pure, exported for tests). */
export function scoreProduct(p, req) {
  const q = words(req.query).map(stem);
  const hay = new Set(words(`${p.title} ${p.type || ''} ${(p.tags || []).join(' ')} ${p.vendor || ''}`).map(stem));
  const hits = q.filter((w) => hay.has(w)).length;
  let score = q.length ? hits / q.length : 0.5;
  if (p.available === false) score -= 1;
  if (Number.isFinite(req.budget) && Number.isFinite(p.price) && p.price > req.budget) score -= 2;
  if (/gift\s?card|e-?gift|subscription|bundle|sample|sticker|mug|merch/i.test(p.title)) score -= 0.6;
  return Math.round(score * 1000) / 1000;
}

/** Best three, at most one per store first, then fill (pure). */
export function pickTop(cands, n = 3) {
  const sorted = [...cands].sort((a, b) => b.score - a.score || a.price - b.price);
  const out = [];
  const used = new Set();
  for (const c of sorted) { if (out.length >= n) break; if (!used.has(c.host) && c.score > -0.5) { out.push(c); used.add(c.host); } }
  for (const c of sorted) { if (out.length >= n) break; if (!out.includes(c) && c.score > -0.5) out.push(c); }
  return out;
}

export function createLiveOrchestrator({
  audit, emit = () => {}, browser = null, evaluate, client = createShopifyClient(), shops = DEFAULT_LIVE_SHOPS,
  llm = null, refine = refineWithLocalModel, webSearch = null, now = () => Date.now(),
} = {}) {
  const sessions = new Map();
  let browserLock = Promise.resolve();

  function newSession(id) {
    return {
      id, state: 'IDLE', chain: Promise.resolve(), started: false, mode: 'sync', replies: null, sayCounter: 0, lastSayId: null,
      shops: shops.map((s) => ({ ...s, enabled: s.enabled !== false })), request: null, options: [], current: -1,
      pages: new Map(), firstSeen: {}, pending: null, gen: 0,
    };
  }
  const getSession = (id) => { const k = String(id || 'default'); let s = sessions.get(k); if (!s) { s = newSession(k); sessions.set(k, s); } return s; };
  const enqueue = (s, fn) => { const run = s.chain.then(() => fn()); s.chain = run.then(() => {}, () => {}); return run; };

  async function log(s, type, actor, summary, data = {}, refs = {}) {
    try { return await audit.append(s.id, type, actor, summary, data, refs); } catch (err) {
      try { emit(s.id, 'error', { message: `audit: ${err.message}` }); } catch { /* ignore */ }
      return null;
    }
  }
  function setState(s, state, option_index = s.current >= 0 ? s.current : null) { s.state = state; emit(s.id, 'state', { state, option_index, live: true }); }
  function say(s, text, option_index = null) {
    const t = String(text || '').trim();
    if (!t) return null;
    s.sayCounter += 1;
    const say_id = `say_${String(s.sayCounter).padStart(4, '0')}`;
    if (s.replies) s.replies.push(t);
    s.lastSayId = say_id;
    emit(s.id, 'agent.say', { say_id, text: t, section: null, option_index });
    return say_id;
  }
  const enabledShops = (s) => s.shops.filter((x) => x.enabled);
  const shopName = (s, host) => s.shops.find((x) => x.host === host)?.name || shopLabel(host);

  /** The visible browser (controller on the presenter's laptop) follows along; on a server without one this is a no-op. */
  function showInBrowser(url) {
    if (!browser || browser.mode !== 'controller' || typeof browser.open !== 'function') return;
    const run = browserLock.then(() => browser.open(url));
    browserLock = run.then(() => {}, () => {});
  }

  // ---------------------------------------------------------------- public API (same shape as the demo orchestrator)
  function handle(session_id, text, { sync = false } = {}) {
    const s = getSession(session_id);
    const t = String(text ?? '').trim();
    return enqueue(s, async () => {
      s.mode = sync ? 'sync' : 'voice';
      const replies = [];
      s.replies = replies;
      try {
        if (!s.started) {
          s.started = true;
          await log(s, 'session_started', 'system', 'Session started (live web)', { user_id: USER_ID, mode: 'live', merchants: enabledShops(s).map((x) => x.host) });
        }
        await log(s, 'utterance', 'user', `User: "${clip(t, 140)}"`, { text: t, mode: s.mode });
        emit(s.id, 'user.utterance', { text: t });
        if (t) await processText(s, t);
      } catch (err) {
        await log(s, 'error', 'system', `Error: ${clip(err.message, 140)}`, { message: err.message, state: s.state });
        emit(s.id, 'error', { message: err.message });
        say(s, 'Sorry, something went wrong on my side. Please try again.');
        setState(s, s.options.length ? 'AWAIT_CHOICE' : 'IDLE');
      } finally {
        s.replies = null;
      }
      return { replies, state: s.state };
    });
  }

  async function processText(s, text) {
    if (s.state === 'APPROVE' && s.pending) {
      const r = route(text, { state: 'APPROVE', optionCount: s.options.length, options: s.options })[0];
      if (r && r.intent === 'confirm' || /^(?:yes|yeah|yep|ok(?:ay)?|sure|confirm(?:ed)?|go ahead|do it)\b/i.test(text.trim())) return confirm(s, text);
      if (r && r.intent === 'cancel') return cancel(s, text);
      await log(s, 'approval_denied', 'user', 'User moved on without confirming', { reason: 'moved_on', sku: s.pending.opt.sku });
      s.pending = null;
      setState(s, 'AWAIT_CHOICE');
    }
    const hasOptions = s.options.length > 0;
    const state = hasOptions ? 'AWAIT_CHOICE' : 'IDLE';
    const intents = route(text, { state, optionCount: s.options.length, options: s.options });
    const first = intents[0];
    if (!hasOptions || !first || first.intent === 'request' || first.intent === 'answer_clarify' || first.intent === 'alternative') {
      if (looksLikeRequest(text) || !hasOptions) {
        if (first && first.intent === 'reorder') { say(s, "In live mode I can't see your past orders. Tell me what to look for, for example running shoes under 150 dollars."); return; }
        if (!looksLikeRequest(text) && !parseLiveRequest(text).query) { say(s, 'What would you like me to find? For example: wireless headphones under 100 dollars.'); setState(s, 'IDLE'); return; }
        return request(s, text);
      }
    }
    if (looksLikeRequest(text) && !['ask', 'show_section', 'select', 'next', 'back', 'goto_option'].includes(first?.intent)) return request(s, text);
    for (const it of intents.length ? intents : [{ intent: /\?\s*$/.test(text) ? 'ask' : 'unknown', args: { question: text } }]) {
      switch (it.intent) {
        case 'next': await goto(s, Math.min(s.current + 1, s.options.length - 1), 'next'); break;
        case 'back': await goto(s, Math.max(s.current - 1, 0), 'back'); break;
        case 'goto_option': await goto(s, clampIndex(s, it.args.index), 'goto'); break;
        case 'show_section': await showSection(s, it.args.section); break;
        case 'ask': await ask(s, it.args.question || text); break;
        case 'select': await select(s, it.args.index != null ? clampIndex(s, it.args.index) : s.current); break;
        case 'confirm': say(s, 'There is nothing waiting for your confirmation. Say buy this one when you have picked something.'); break;
        case 'cancel': say(s, 'Okay. Nothing was bought.'); break;
        case 'reorder': say(s, "In live mode I can't see your past orders. Tell me what to look for."); break;
        default: say(s, 'You can say next, show me the reviews, ask a question about this product, or buy this one.');
      }
    }
  }
  const clampIndex = (s, i) => Math.max(0, Math.min(Number(i) === -1 ? s.options.length - 1 : Number(i) || 0, s.options.length - 1));

  // ---------------------------------------------------------------- search
  async function request(s, text) {
    s.gen += 1;
    const gen = s.gen;
    const t0 = now();
    let req = parseLiveRequest(text);
    const refined = await refine(text).catch(() => null);
    if (refined && gen === s.gen) req = { ...req, ...Object.fromEntries(Object.entries(refined).filter(([, v]) => v !== null && v !== undefined)), source: 'local_model' };
    s.request = req;
    s.options = []; s.current = -1; s.pages = new Map(); s.firstSeen = {}; s.pending = null;
    setState(s, 'SEARCH', null);
    const chips = [{ label: `“${req.query}”` }];
    if (req.budget) chips.push({ label: `under ${liveMoney(req.budget)}` });
    if (req.size) chips.push({ label: `size ${req.size}` });
    emit(s.id, 'constraints', { chips });

    const all = enabledShops(s);
    if (!all.length) { say(s, 'There are no stores in your allowed list. Add one in the Activity panel under Stores.'); setState(s, 'IDLE'); return; }
    const byCat = req.category ? all.filter((x) => (x.categories || []).includes(req.category)) : [];
    const targets = (byCat.length ? byCat : all).slice(0, MAX_SHOPS);

    // Optional discovery through a configured web search (off by default). Failures never stop the flow.
    // Runs next to the store search; it may only point at product pages on allowed stores.
    const webPart = webSearch ? (async () => {
      try {
        const hits = await webSearch(req.query, { timeoutMs: 4000 });
        const found = productHits(hits, targets.map((x) => x.host)).slice(0, 3);
        await log(s, 'web_search', 'agent', `Searched the web for "${req.query}" (${hits.length} results, ${found.length} on your stores)`, { query: req.query, results: hits.slice(0, 10), product_pages: found });
        return found;
      } catch (err) {
        await log(s, 'web_search', 'agent', 'Web search unavailable – searched your stores directly', { query: req.query, error: clip(err.message, 120) });
        return [];
      }
    })() : Promise.resolve([]);

    for (const shop of targets) {
      await log(s, 'search_issued', 'agent', `Searched ${shopLabel(shop.host)} for "${req.query}"`, {
        store: shop.host, store_name: shop.name, query: req.query, category: req.category, budget: req.budget, size: req.size, live: true,
        url: `https://${shop.host}/search/suggest.json?q=${encodeURIComponent(req.query)}`,
      });
    }
    const cands = [];
    const perStore = [];
    let relevant = 0;
    let firstCardMs = null;
    let shown = '';
    const publish = (partial) => {
      if (gen !== s.gen) return;
      const top = pickTop(cands, 3);
      const sig = top.map((c) => c.sku).join('|');
      if (!top.length || (partial && sig === shown)) return;
      shown = sig;
      s.options = top.map((c, i) => toOption(s, c, i));
      if (firstCardMs === null) firstCardMs = now() - t0;
      emit(s.id, 'options', { options: s.options, live: true, partial, update: s.optionsShown === gen });
      s.optionsShown = gen;
    };
    let next = 0;
    async function worker() {
      while (next < targets.length) {
        const shop = targets[next++];
        const t1 = now();
        let list = [];
        let error = null;
        try {
          let r = await client.search(shop.host, req.query, { timeoutMs: SEARCH_TIMEOUT_MS });
          list = r.products;
          const core = req.category ? LIVE_CATEGORIES[req.category].core : null;
          if (!list.some((p) => scoreProduct(p, req) > 0) && core && core !== req.query) {
            r = await client.search(shop.host, core, { timeoutMs: SEARCH_TIMEOUT_MS });
            list = r.products;
          }
        } catch (err) { error = clip(err.message, 120); }
        const scored = list.map((p) => ({ ...p, host: shop.host, store_name: shop.name, sku: `${shop.host}/${p.handle}`, score: scoreProduct(p, req) }));
        const matched = scored.filter((p) => p.score > 0);
        relevant += scoreless(scored, req);
        perStore.push({ store: shop.host, count: list.length, matched: matched.length, ms: now() - t1, ...(error ? { error } : {}) });
        cands.push(...matched);
        if (matched.length) publish(true);
      }
    }
    await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_SEARCH, targets.length) }, worker));
    for (const hit of await webPart) {
      if (cands.some((c) => c.host === hit.host && c.handle === hit.handle)) continue;
      try {
        const p = await client.product(hit.host, hit.handle, { timeoutMs: SEARCH_TIMEOUT_MS });
        const shop = targets.find((x) => x.host === hit.host);
        const c = { handle: p.handle, title: p.title, vendor: p.vendor, type: p.type, tags: [], price: p.price, available: p.available, image: p.image,
          url: `https://${hit.host}/products/${encodeURIComponent(p.handle)}`, description: p.description, host: hit.host, store_name: shop.name, sku: `${hit.host}/${p.handle}`, via: 'web_search' };
        c.score = scoreProduct(c, req);
        if (c.score > 0) cands.push(c);
      } catch { /* a web hit that does not open is simply skipped */ }
    }
    if (gen !== s.gen) return;
    const seen = perStore.reduce((a, p) => a + p.count, 0);
    await log(s, 'search_result', 'agent', `${seen} seen · ${cands.length} match`, { seen, matched: cands.length, per_store: perStore, live: true, first_card_ms: firstCardMs });
    for (const p of perStore.filter((x) => x.error)) {
      await log(s, 'fallback_used', 'system', `${shopLabel(p.store)} did not answer (${p.error}) – skipped`, { store: p.store, detail: p.error });
    }
    const overBudget = Boolean(req.budget) && cands.length === 0 && relevant > 0;
    if (!cands.length) {
      say(s, overBudget ? `I searched ${targets.length} stores live but found nothing under ${spokenMoney(req.budget)}. Try a higher budget or other words.`
        : `I searched ${targets.length} store${targets.length === 1 ? '' : 's'} live but found nothing for ${req.query}. Try other words, or add a store in the Activity panel.`);
      setState(s, 'IDLE', null);
      return;
    }
    publish(false);
    await log(s, 'ranking', 'agent', `Ranked ${s.options.length}: ${s.options.map((o) => spokenTitle(o.title)).join(' → ')}`, {
      skus: s.options.map((o) => o.sku), scores: s.options.map((o) => o.rank.score), live: true,
    });
    await log(s, 'options_presented', 'agent', `Presented ${s.options.length} options`, { option_ids: s.options.map((o) => o.option_id), skus: s.options.map((o) => o.sku), first_card_ms: firstCardMs, live: true });

    // Read the product pages (max 3 in parallel, 12 s each) – the answers come only from what these pages say.
    await Promise.all(s.options.map((o) => readPage(s, o, gen)));
    if (gen !== s.gen) return;
    emit(s.id, 'options', { options: s.options, live: true, partial: false, update: true });
    s.current = 0;
    showInBrowser(s.options[0].url);
    const stores = [...new Set(s.options.map((o) => o.store_name))];
    setState(s, 'NARRATE', 0);
    say(s, `I searched ${targets.length} stores live and found ${cands.length} matching product${cands.length === 1 ? '' : 's'}. Here are the top ${s.options.length}, from ${joinAnd(stores)}.`);
    s.options.forEach((o, i) => say(s, optionLine(o, i), i));
    say(s, 'Tap a card, ask me anything about it, or say buy the first one.');
    setState(s, 'AWAIT_CHOICE', 0);
    await log(s, 'ranking', 'agent', `Live search done in ${((now() - t0) / 1000).toFixed(1)} s (first card ${((firstCardMs ?? 0) / 1000).toFixed(1)} s)`, { total_ms: now() - t0, first_card_ms: firstCardMs, live: true });
  }

  function toOption(s, c, i) {
    const prev = s.options.find((o) => o.sku === c.sku);
    if (prev) { prev.rank = { position: i + 1, score: c.score }; return prev; }
    const shopCur = s.shops.find((x) => x.host === c.host)?.currency || 'USD';
    return {
      option_id: `opt_${c.sku}`, sku: c.sku, handle: c.handle, title: c.title, vendor: c.vendor, store: c.host, merchant_id: c.host, store_name: c.store_name,
      url: c.url, image_url: c.image, price: { amount: c.price, currency: shopCur, source: 'store search' }, compare_at: c.compare_at,
      available: c.available, rating: {}, delivery: null, live: true, search_description: c.description,
      rank: { position: i + 1, score: c.score }, why: c.available ? null : 'Store shows it as sold out',
    };
  }

  function optionLine(o, i) {
    const bits = [`${ORD[i] || 'Next'}: ${spokenTitle(o.title)} from ${o.store_name}, ${spokenMoney(o.price.amount, o.price.currency)}`];
    if (Number.isFinite(o.rating.stars)) bits.push(`rated ${o.rating.stars} out of 5${o.rating.count ? ` by ${Number(o.rating.count).toLocaleString('en-US')} reviewers` : ''}`);
    if (o.available === false) bits.push('but the page says it is sold out');
    return bits.join(', ') + '.';
  }

  /** Read one product page: JSON-LD first, then OpenGraph, then the page text. Every read is hashed into the audit chain. */
  async function readPage(s, o, gen = s.gen) {
    if (s.pages.has(o.sku)) return s.pages.get(o.sku);
    await log(s, 'page_opened', 'agent', `Opened ${spokenTitle(o.title)} at ${shopLabel(o.store)}`, {
      url: o.url, sku: o.sku, title: o.title, merchant_id: o.store, store_name: o.store_name, option_index: s.options.indexOf(o), live: true,
    }, { sku: o.sku, option_id: o.option_id });
    let page = null;
    try {
      page = await client.page(o.store, o.handle, { timeoutMs: PAGE_TIMEOUT_MS });
    } catch (err) {
      await log(s, 'fallback_used', 'system', `Could not read the page at ${shopLabel(o.store)} (${clip(err.message, 80)}) – using the store's search data`, { sku: o.sku, url: o.url, detail: err.message });
    }
    if (gen !== s.gen) return null;
    const ld = page?.jsonld || null;
    const og = page?.og || null;
    const fields = {
      name: ld?.name || og?.title || o.title,
      price: ld?.price ?? og?.price ?? o.price.amount,
      currency: ld?.currency || og?.currency || o.price.currency,
      availability: ld?.availability || (o.available ? 'in_stock' : 'out_of_stock'),
      rating: ld?.rating ?? null, rating_count: ld?.rating_count ?? null,
      brand: ld?.brand || o.vendor || null, image: ld?.image || og?.image || o.image_url,
      shipping: ld?.shipping || null, source: ld ? 'json-ld' : og?.title ? 'opengraph' : 'store search',
    };
    const text = pageText(o, page, fields);
    const snap = { snapshot_id: `snap_${s.id.slice(0, 8)}_${sha256Hex(o.sku).slice(0, 6)}_${now().toString(36)}`, sha256: sha256Hex(text), text, fields, url: page?.url || o.url, taken_at: new Date(now()).toISOString(), html_sha256: page?.html_sha256 || null };
    s.pages.set(o.sku, snap);
    // Card facts from the page.
    if (Number.isFinite(fields.rating)) o.rating = { stars: Math.round(fields.rating * 10) / 10, count: fields.rating_count ?? null };
    if (fields.currency) o.price = { ...o.price, currency: fields.currency };
    if (Number.isFinite(fields.price) && page) o.price = { ...o.price, page_amount: fields.price };
    if (!o.image_url && fields.image) o.image_url = fields.image;
    if (fields.availability === 'out_of_stock') { o.available = false; o.why = 'The page says sold out'; }
    o.page_source = fields.source;
    await log(s, 'page_read', 'agent', `Read ${spokenTitle(o.title)} on ${shopLabel(o.store)} (${snap.snapshot_id})`, {
      snapshot_id: snap.snapshot_id, snapshot_sha256: snap.sha256, sha256: snap.sha256, html_sha256: snap.html_sha256, section: 'all', url: snap.url,
      sku: o.sku, taken_at: snap.taken_at, fields, ms: page?.ms ?? null, bytes: page?.bytes ?? null, text: clip(text, 600), live: true,
    }, { snapshot_id: snap.snapshot_id, sku: o.sku });
    if (!s.firstSeen[o.sku]) {
      s.firstSeen[o.sku] = { price: o.price.amount, ts: snap.taken_at, snapshot_id: snap.snapshot_id };
      await log(s, 'price_observed', 'agent', `Saw ${liveMoney(o.price.amount, o.price.currency)} for ${spokenTitle(o.title)}`, {
        sku: o.sku, title: o.title, price: o.price.amount, currency: o.price.currency, page_price: fields.price, snapshot_id: snap.snapshot_id, snapshot_sha256: snap.sha256, observed_at: snap.taken_at, live: true,
      }, { snapshot_id: snap.snapshot_id, sku: o.sku });
    }
    // The whole page is checked (not only the parts kept for answers): instructions in it are logged and never obeyed.
    const inj = detectInjection(text) || detectInjection(page?.text || '') || detectInjection(page?.jsonld?.description || '');
    if (inj) await log(s, 'injection_ignored', 'agent', 'Ignored instructions found in page content', { quote: inj, snapshot_id: snap.snapshot_id, snapshot_sha256: snap.sha256, sku: o.sku, url: snap.url }, { snapshot_id: snap.snapshot_id, sku: o.sku });
    return snap;
  }

  /** Page text with "## section" headers so answers can name where they come from. Only text from the store. */
  function pageText(o, page, f) {
    const desc = page?.jsonld?.description || page?.og?.description || o.search_description || '';
    const visible = String(page?.text || '');
    const lines = visible.split('\n').map((l) => l.trim()).filter((l) => l.length > 3 && l.length < 400);
    const grab = (re, n = 6) => [...new Set(lines.filter((l) => re.test(l)))].slice(0, n).join('\n');
    const reviews = page?.jsonld?.reviews || [];
    const out = [
      `## price\n${f.name}: ${liveMoney(f.price, f.currency)} ${f.currency}. ${f.availability === 'in_stock' ? 'In stock.' : f.availability === 'out_of_stock' ? 'Sold out.' : ''}`,
      `## specs\n${desc}\n${grab(/\b(?:material|made (?:of|from|with)|weight|weighs|battery|hours|waterproof|water-resistant|water resistant|fit|fits|size|sizing|roast|origin|notes|bluetooth|noise|cushion|drop|recycled|organic|wool|cotton|polyester)\b/i, 10)}`,
      `## reviews\n${Number.isFinite(f.rating) ? `Rated ${f.rating} out of 5${f.rating_count ? ` from ${f.rating_count} reviews` : ''}.` : ''}\n${reviews.map((r) => r.text).join('\n')}`,
      `## delivery\n${grab(/\b(?:ship|shipping|deliver|delivery|dispatch|arrives?)\b/i)}`,
      `## returns\n${grab(/\b(?:return|returns|refund|exchange)\b/i)}`,
      `## seller\nSold by ${o.store_name} (${shopLabel(o.store)})${f.brand ? `. Brand: ${f.brand}` : ''}.`,
    ];
    return out.join('\n').replace(/\n{2,}/g, '\n');
  }

  // ---------------------------------------------------------------- browse + answer
  async function goto(s, i, reason) {
    const o = s.options[i];
    if (!o) { say(s, 'There is no option like that.'); return; }
    if (i === s.current && reason === 'next' && i === s.options.length - 1) { say(s, 'That was the last one. Say go back, or buy this one.'); return; }
    s.current = i;
    setState(s, 'AWAIT_CHOICE', i);
    showInBrowser(o.url);
    if (!s.pages.has(o.sku)) await readPage(s, o);
    else await log(s, 'page_opened', 'agent', `Went back to ${spokenTitle(o.title)}`, { url: o.url, sku: o.sku, option_index: i, reason, live: true }, { sku: o.sku });
    say(s, optionLine(o, i), i);
  }

  const SECTION_QUESTION = {
    reviews: 'reviews rating stars', delivery: 'shipping delivery ship arrives', returns: 'returns return refund exchange',
    specs: 'material made features', price: 'price', seller: 'sold by', gallery: 'photos',
  };
  async function showSection(s, section) {
    const o = s.options[s.current] || s.options[0];
    if (!o) return;
    const snap = s.pages.get(o.sku) || await readPage(s, o);
    await log(s, 'page_navigate', 'agent', `Scrolled to ${section} on ${spokenTitle(o.title)}`, { section, url: o.url, sku: o.sku, option_index: s.current, live: true }, { sku: o.sku });
    if (section === 'reviews') {
      const f = snap?.fields || {};
      if (Number.isFinite(f.rating)) {
        const line = `Rated ${f.rating} out of 5${f.rating_count ? ` from ${f.rating_count} reviews` : ''}.`;
        await log(s, 'answer_given', 'agent', clip(line, 160), { question: 'reviews', answer: line, quoted_span: line, span_verified: true, snapshot_id: snap.snapshot_id, snapshot_sha256: snap.sha256, sku: o.sku, section: 'reviews', source: 'json-ld' }, { snapshot_id: snap.snapshot_id, sku: o.sku });
        say(s, `The page says it is ${line.charAt(0).toLowerCase()}${line.slice(1)}`, s.current);
        return;
      }
    }
    if (section === 'price') {
      say(s, `${spokenTitle(o.title)} is ${spokenMoney(o.price.amount, o.price.currency)} on ${o.store_name}. Taxes and shipping are shown in the store's checkout.`, s.current);
      return;
    }
    return ask(s, SECTION_QUESTION[section] || section, { topic: section === 'delivery' ? 'shipping' : section === 'returns' ? 'the return policy' : section, section });
  }

  async function ask(s, question, { topic = null, section = null } = {}) {
    const o = s.options[s.current] || s.options[0];
    if (!o) { say(s, 'Ask me again once we have picked a product.'); return; }
    const snap = s.pages.get(o.sku) || await readPage(s, o);
    const text = section ? (snap.text.split(/##\s*/).find((p) => p.startsWith(section)) || '').replace(/^\w+\s*/, '') : snap.text;
    const res = await groundedAnswer({ question, snapshot: { text: section ? text : snap.text }, llm });
    if (res.not_on_page || !res.answer) {
      const t = topic || res.topic || 'that';
      const line = `The page for ${spokenTitle(o.title)} doesn't say anything about ${t}, so I can't tell you.`;
      await log(s, 'answer_not_on_page', 'agent', line, { question, topic: t, snapshot_id: snap.snapshot_id, snapshot_sha256: snap.sha256, sku: o.sku, url: snap.url, live: true }, { snapshot_id: snap.snapshot_id, sku: o.sku });
      say(s, line, s.current);
      return;
    }
    await log(s, 'answer_given', 'agent', clip(res.answer, 160), {
      question, answer: { answer: res.answer, quoted_span: res.quoted_span, span_verified: res.span_verified, section: res.section ?? section },
      quoted_span: res.quoted_span, snapshot_id: snap.snapshot_id, snapshot_sha256: snap.sha256, sku: o.sku, url: snap.url, source: res.source, live: true,
    }, { snapshot_id: snap.snapshot_id, sku: o.sku });
    say(s, res.answer, s.current);
  }

  // ---------------------------------------------------------------- verify → policy → handoff
  async function select(s, i) {
    const o = s.options[i];
    if (!o) { say(s, 'Pick one of the cards first.'); return; }
    s.current = i;
    await log(s, 'option_selected', 'user', `User chose ${spokenTitle(o.title)}`, { option_index: i, option_id: o.option_id, sku: o.sku, title: o.title, live: true }, { sku: o.sku, option_id: o.option_id });
    setState(s, 'VERIFY', i);
    // Fresh price + stock straight from the store (never from the cached search result).
    await log(s, 'page_reload', 'agent', `Reloaded ${spokenTitle(o.title)} to re-check price and stock`, { url: o.url, sku: o.sku, live: true }, { sku: o.sku });
    let prod = null;
    try { prod = await client.product(o.store, o.handle, { timeoutMs: PAGE_TIMEOUT_MS }); } catch (err) {
      await log(s, 'error', 'system', `Could not re-check ${shopLabel(o.store)}: ${clip(err.message, 100)}`, { stage: 'verify', message: err.message, sku: o.sku });
      say(s, `I couldn't re-check the price at ${o.store_name} right now, so I won't hand this one off. Please try again in a minute.`, i);
      setState(s, 'AWAIT_CHOICE', i);
      return;
    }
    const size = s.request?.size || null;
    const variant = pickVariant(prod.variants, size);
    const price = variant?.price ?? prod.price;
    const inStock = variant ? variant.available : prod.available;
    const currency = s.pages.get(o.sku)?.fields?.currency || o.price.currency || 'USD';
    const taken = new Date(now()).toISOString();
    const verSnapText = JSON.stringify({ handle: prod.handle, price, available: inStock, variant: variant?.id ?? null });
    const vsha = sha256Hex(verSnapText);
    const first = s.firstSeen[o.sku] || { price: o.price.amount, ts: taken };
    if (!s.firstSeen[o.sku]) s.firstSeen[o.sku] = first;
    await log(s, 'price_observed', 'agent', `Saw ${liveMoney(price, currency)} for ${spokenTitle(o.title)}`, {
      sku: o.sku, title: o.title, price, currency, snapshot_sha256: vsha, observed_at: taken, variant_id: variant?.id ?? null, variant: variant?.title ?? null, source: 'products/<handle>.js', live: true,
    }, { sku: o.sku });
    await log(s, 'stock_checked', 'agent', inStock ? `${spokenTitle(o.title)} is in stock${variant && size ? ` in size ${size}` : ''}` : `${spokenTitle(o.title)} is out of stock${size ? ` in size ${size}` : ''}`, {
      sku: o.sku, in_stock: inStock, size, variant_id: variant?.id ?? null, snapshot_sha256: vsha, live: true,
    }, { sku: o.sku });
    if (size && !variant) {
      say(s, `The store doesn't list ${spokenTitle(o.title)} in size ${size}. Pick another one, or ask for a different size.`, i);
      setState(s, 'AWAIT_CHOICE', i);
      return;
    }
    if (Number.isFinite(first.price) && Math.abs(price - first.price) >= 0.005) {
      emit(s.id, 'price_diff', { sku: o.sku, title: o.title, before: first.price, after: price, before_ts: first.ts, after_ts: taken, currency });
    }
    o.price = { ...o.price, amount: price, currency };
    setState(s, 'POLICY', i);
    const known = s.shops.some((x) => x.host === o.store && x.enabled);
    const policy = { ...LIVE_POLICY, approved_merchants: enabledShops(s).map((x) => x.host) };
    // Taxes and shipping are only known in the store's checkout: the total is the item price; foreign currency = unknown total (fails closed).
    const totals = currency === policy.auto_approve.currency ? { subtotal: price, tax: null, shipping: null, total: price, currency } : { subtotal: price, total: null, currency };
    const pageInstruction = detectInjection(s.pages.get(o.sku)?.text || '');
    const decision = evaluate({
      policy, merchant_id: o.store, category: s.request?.category || null, qty: 1, totals, first_seen_price: first.price, current_price: price,
      in_stock: inStock, orders_today: 0, instruction_from_page: false, known_merchant: known,
    });
    const limit = policy.auto_approve.max_total;
    await log(s, 'policy_decision', 'policy', `${decision.decision}${decision.rules.length ? ` (${decision.rules.join(', ')})` : ''}: item ${liveMoney(price, currency)}, hand-off ≤ ${liveMoney(limit)} without asking`, {
      decision: decision.decision, rules: decision.rules, inputs: { ...decision.inputs, merchant_name: o.store_name, page_instruction_ignored: Boolean(pageInstruction) }, live: true, handoff_only: true,
    }, { sku: o.sku });
    emit(s.id, 'policy', { decision: decision.decision, rules: decision.rules, inputs: { ...decision.inputs, merchant_name: o.store_name }, total: price, currency, limit, live: true });
    if (decision.decision === 'DENY') {
      const why = decision.rules.includes('out_of_stock') ? 'the store shows it as sold out' : decision.rules.includes('merchant_not_approved') ? `${o.store_name} is not in your allowed stores` : 'your rules do not allow it';
      say(s, `I can't get this one ready: ${why}.`, i);
      setState(s, 'AWAIT_CHOICE', i);
      return;
    }
    const pending = { opt: o, price, currency, variant, decision, at: taken };
    if (decision.decision === 'REQUIRE_APPROVAL') {
      s.pending = pending;
      setState(s, 'APPROVE', i);
      const reasons = decision.rules.map((r) => ({
        total_over_limit: currency !== 'USD' ? 'the price is not in dollars' : `it is over your ${liveMoney(limit)} limit`,
        price_increased_since_first_seen: 'the price went up since I first saw it', new_merchant: 'it is a new store', daily_order_limit: 'you reached your daily limit',
      }[r] || r.replace(/_/g, ' ')));
      await log(s, 'approval_requested', 'agent', `Asked to confirm the hand-off (${liveMoney(price, currency)})`, { sku: o.sku, total: price, currency, rules: decision.rules, phrase: 'confirm', handoff_only: true }, { sku: o.sku });
      say(s, `${spokenTitle(o.title)} is ${spokenMoney(price, currency)} and ${inStock ? 'in stock' : 'not in stock'}. This needs your OK because ${joinAnd(reasons)}. Say confirm and I'll get it ready in the store, or say cancel.`, i);
      return;
    }
    await handoff(s, pending, { mode: 'auto' });
  }

  async function confirm(s, transcript) {
    const p = s.pending;
    s.pending = null;
    await log(s, 'approval_granted', 'user', `User said "${clip(transcript, 80)}"`, { transcript, sku: p.opt.sku, total: p.price, currency: p.currency, handoff_only: true }, { sku: p.opt.sku });
    await handoff(s, p, { mode: 'user_explicit', transcript });
  }
  async function cancel(s, transcript) {
    const p = s.pending;
    s.pending = null;
    await log(s, 'approval_denied', 'user', `User declined: "${clip(transcript, 80)}"`, { reason: 'user_cancelled', transcript, sku: p.opt.sku }, { sku: p.opt.sku });
    say(s, 'Okay, nothing is handed off. Pick another one or ask me something.');
    setState(s, 'AWAIT_CHOICE', s.current);
  }

  async function handoff(s, p, approval) {
    const o = p.opt;
    let url = o.url;
    if (p.variant?.id) { const u = new URL(o.url); u.searchParams.set('variant', String(p.variant.id)); url = u.href; }
    const ev = await log(s, 'handoff', 'agent', `Ready to buy: handed off to ${shopLabel(o.store)} – Shopz does not pay`, {
      sku: o.sku, title: o.title, store: o.store, store_name: o.store_name, url, price: p.price, currency: p.currency,
      variant_id: p.variant?.id ?? null, variant: p.variant?.title ?? null, approval, paid_by_shopz: false, logged_in: false, live: true,
    }, { sku: o.sku });
    emit(s.id, 'handoff', {
      handoff: { title: o.title, store_name: o.store_name, store: o.store, url, price: p.price, currency: p.currency, image_url: o.image_url, variant: p.variant?.title ?? null, approval, event_id: ev?.event_id ?? null },
    });
    setState(s, 'DONE', s.current);
    say(s, `Ready to buy. ${spokenTitle(o.title)} is ${spokenMoney(p.price, p.currency)} and in stock. Shopz never pays for you, so tap Open in store to check out at ${o.store_name}.`, s.current);
  }

  // ---------------------------------------------------------------- stores
  function listShops(session_id) {
    return getSession(session_id).shops.map(({ host, name, categories, enabled, added }) => ({ host, name, label: shopLabel(host), categories: categories || [], enabled, added: Boolean(added) }));
  }
  async function updateShops(session_id, { enable = [], disable = [], add = null, remove = null } = {}) {
    const s = getSession(session_id);
    for (const h of [].concat(enable)) { const x = s.shops.find((y) => y.host === normalizeHost(h)); if (x) x.enabled = true; }
    for (const h of [].concat(disable)) { const x = s.shops.find((y) => y.host === normalizeHost(h)); if (x) x.enabled = false; }
    if (remove) s.shops = s.shops.filter((y) => y.host !== normalizeHost(remove) || !y.added);
    if (add) {
      const host = normalizeHost(add);
      if (!host) throw Object.assign(new Error('Enter a store address like www.example.com'), { status: 400 });
      if (s.shops.length >= MAX_SHOPS) throw Object.assign(new Error(`At most ${MAX_SHOPS} stores`), { status: 400 });
      if (!s.shops.some((y) => y.host === host)) {
        // Only stores that answer the public storefront search can be used (no login, no bot wall).
        try { await client.search(host, 'a', { limit: 1, timeoutMs: 6000 }); } catch (err) {
          throw Object.assign(new Error(`${shopLabel(host)} can't be searched by Shopz (${clip(err.message, 60)})`), { status: 422 });
        }
        s.shops.push({ host, name: shopLabel(host), categories: [], enabled: true, added: true });
      }
    }
    await log(s, 'preference_saved', 'user', `Allowed stores: ${enabledShops(s).map((x) => shopLabel(x.host)).join(', ') || 'none'}`, { stores: enabledShops(s).map((x) => x.host), live: true });
    return listShops(session_id);
  }

  function session(session_id) {
    const s = getSession(session_id);
    return { session_id: s.id, state: s.state, option_index: s.current >= 0 ? s.current : null, mode: 'live', options: s.options, first_seen: { ...s.firstSeen } };
  }
  function reset(session_id) { sessions.delete(String(session_id || 'default')); emit(String(session_id), 'state', { state: 'IDLE', option_index: null, live: true }); return { ok: true }; }
  const bargeIn = async (session_id) => { emit(String(session_id), 'speech.cancel', {}); return { ok: true, interrupted: false }; };
  const speaking = async () => {};
  const speechDone = async () => {};
  const has = (session_id) => sessions.has(String(session_id));

  return { handle, session, reset, bargeIn, speaking, speechDone, listShops, updateShops, has, notice: LIVE_NOTICE };
}

/** Results that would match without the budget (to tell "nothing under $X" from "nothing at all"). */
function scoreless(list, req) {
  return list.filter((p) => scoreProduct(p, { ...req, budget: null }) > 0).length;
}

function joinAnd(list) {
  const l = list.filter(Boolean);
  if (l.length <= 1) return l.join('');
  return `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`;
}
