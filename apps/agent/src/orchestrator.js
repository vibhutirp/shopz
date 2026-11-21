// Shopz orchestrator: one state machine per session (docs/PRD.md §2 demo script).
// CLARIFY → SEARCH → NARRATE ⇄ NAVIGATE/ANSWER → AWAIT_CHOICE → VERIFY → POLICY → APPROVE → CHECKOUT → DONE.
// Only user intents trigger actions. Page content is read, quoted and audited, never obeyed.
import { route, detectCategory, isFillerOnly, parseTarget, normalize } from './intents.js';
import {
  createCart, addItem, setQty, clearLines, cartTotals, cartView, findLine, lineTotals,
} from './cart.js';
import { parseDeadline, parseBudget, shortDate, daysUntil } from './dates.js';
import { groundedAnswer, detectInjection, verifySpan } from './answer.js';
import {
  SECTIONS, STORES, APPROVAL_PHRASE, computeTotals, today, isoDate, addDays, weekdayName, sha256Hex,
} from '../../../packages/contracts/index.js';

const USER_ID = 'u_demo';
const ORDINALS = ['First', 'Second', 'Third', 'Fourth', 'Fifth'];
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CATEGORY_QUERY = { running_shoes: 'running shoes', coffee: 'coffee' };
const CATEGORY_LABEL = { running_shoes: 'running shoes', coffee: 'coffee' };
const FILTER_REASON = {
  avoided_brand: 'a brand you avoid', over_budget: 'over budget', arrives_after_deadline: 'arrives after your date',
  out_of_stock: 'out of stock', size_unavailable: 'your size is not available', no_wide_fit: 'no wide fit',
};
const SECTION_LABEL = {
  specs: ['specs', "don't"], reviews: ['reviews', "don't"], returns: ['return policy', "doesn't"],
  delivery: ['delivery details', "don't"], price: ['price details', "don't"], seller: ['seller details', "don't"],
  gallery: ['photos', "don't"],
};
const RELATED_SECTION = [
  [/waterproof|water|rain|material|upper|weigh|heavy|light|drop|cushion|fit|width|wide|narrow|size|sizing|sole|stack|breath|vegan|insole|arch|support/i, 'specs'],
  [/arriv|deliver|ship|when will|how long|eta/i, 'delivery'],
  [/return|refund|exchange/i, 'returns'],
  [/review|rating|stars|people say|complain/i, 'reviews'],
  [/price|cost|how much|expensive|cheap|discount|deal|sale/i, 'price'],
  [/seller|sold by|who sells|warrant/i, 'seller'],
  [/photo|picture|image|colou?r|look like/i, 'gallery'],
];
const BROWSER_OPS = ['open', 'scroll', 'highlight', 'back', 'reload', 'snapshot', 'checkout'];
// A store named after on/from/at/via is unapproved unless it is one of ours. These words are not stores.
const NOT_STORE = new Set(`the a an my your our their his her its it them this that these those me you us some any each every
one two three first second third last next sale time least most all once home work school night noon midnight budget size top
best hand stock average max maximum foot feet trail trails road roads track treadmill pavement grass weekend weekends tomorrow
today tonight black cyber christmas thanksgiving easter halloween new memorial labor independence valentine valentines
monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october
november december jan feb mar apr jun jul aug sep sept oct nov dec least around about under below over half marathon race
morning evening afternoon checkout purchase discount price sizes width wide please once`.split(/\s+/));

const clip = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ''));
const ensurePeriod = (s) => { const t = String(s || '').trim(); return /[.!?…]$/.test(t) ? t : `${t}.`; };
const sayNum = (id) => Number(String(id || '').replace(/\D/g, '')) || 0;
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

export function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return Number.isInteger(Math.round(v * 100) / 100) ? `$${Math.round(v)}` : `$${v.toFixed(2)}`;
}
const fmtCount = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString('en-US') : String(n ?? ''));
const fmtStars = (n) => String(Math.round(Number(n) * 10) / 10);
const fmtNum = (n) => (Number.isInteger(Number(n)) ? String(Number(n)) : Number(n).toFixed(2));

/** "Stridewell Glide 5 – Men's Wide" → "Stridewell Glide 5 Wide"; "Morrow House Blend – 12 oz whole bean" → "Morrow House Blend". */
export function spokenTitle(title) {
  const t = String(title || '').trim();
  const m = t.match(/^(.*?)\s+[–—-]\s+(.*)$/);
  if (!m) return t;
  return /\bwide\b/i.test(m[2]) && !/\bwide\b/i.test(m[1]) ? `${m[1]} Wide` : m[1];
}

function joinAnd(list) {
  const l = list.filter(Boolean);
  if (l.length <= 1) return l.join('');
  return `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`;
}

function field(snap, ...keys) {
  const f = (snap && snap.fields) || {};
  for (const k of keys) {
    for (const key of [k, k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())]) {
      const v = f[key];
      if (v !== undefined && v !== null && v !== '') return v;
    }
  }
  return undefined;
}
function fieldNum(snap, ...keys) {
  const v = field(snap, ...keys);
  const n = typeof v === 'string' ? Number(v.replace(/[$,]/g, '')) : Number(v);
  return v === undefined || !Number.isFinite(n) ? undefined : n;
}
function fieldBool(snap, ...keys) {
  const v = field(snap, ...keys);
  if (v === undefined) return undefined;
  if (typeof v === 'boolean') return v;
  return !/^(false|0|no)$/i.test(String(v));
}

/** First sentence of a section text (≤ ~25 words), verbatim so it can serve as the quoted span. */
function leadText(text, maxWords = 25) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const first = t.match(/^.+?[.!?](?=\s|$)/);
  if (first && first[0].split(' ').length <= maxWords + 5) return first[0];
  return t.split(' ').slice(0, maxWords).join(' ');
}

function relatedSection(question) {
  for (const [re, section] of RELATED_SECTION) if (re.test(String(question || ''))) return section;
  return null;
}

function sectionOfSpan(text, span) {
  if (!span) return null;
  const t = String(text || '');
  const idx = t.toLowerCase().indexOf(String(span).toLowerCase().slice(0, 30));
  if (idx < 0) return null;
  const before = t.slice(0, idx);
  const m = [...before.matchAll(/##\s*([a-z_]+)/gi)].pop();
  return m && SECTIONS.includes(m[1].toLowerCase()) ? m[1].toLowerCase() : null;
}

function criticalGist(quote) {
  const q = String(quote || '').trim();
  const m = q.match(/,?\s+but\s+(.+)$/i);
  if (m) return ensurePeriod(m[1]);
  return `"${ensurePeriod(q)}"`;
}

function notOnPageLine(section, topic) {
  const t = topic || 'that';
  if (!section || !SECTION_LABEL[section]) return `This page doesn't mention ${t}, so I can't tell you.`;
  const [label, verb] = SECTION_LABEL[section];
  return `The ${label} on this page ${verb} mention ${t}, so I can't tell you.`;
}

export function createOrchestrator({
  audit, prefs, store, browser, merchants = [], emit = () => {}, llm = null,
  now = today, searchMerchants, filterAndRank, evaluate, policy,
} = {}) {
  const sessions = new Map();
  const deps = { searchMerchants, filterAndRank, evaluate, policy };
  let browserLock = Promise.resolve(); // one browser for every session: one operation at a time

  async function getSearch() {
    if (!deps.searchMerchants) deps.searchMerchants = (await import('./search.js')).searchMerchants;
    return deps.searchMerchants;
  }
  async function getRank() {
    if (!deps.filterAndRank) deps.filterAndRank = (await import('./rank.js')).filterAndRank;
    return deps.filterAndRank;
  }
  async function getPolicy() {
    if (!deps.evaluate || !deps.policy) {
      const m = await import('./policy.js');
      deps.evaluate = deps.evaluate || m.evaluate;
      deps.policy = deps.policy || m.DEFAULT_POLICY;
    }
    return { evaluate: deps.evaluate, policy: deps.policy };
  }

  // ---------------------------------------------------------------- session plumbing
  function newSession(id) {
    return {
      id, state: 'IDLE', mode: 'sync', chain: Promise.resolve(), started: false, turn: 0,
      generation: 0, autoAdvance: false, narration: null, pendingSay: new Set(), sayCounter: 0,
      sentences: new Map(), replies: null, lastSayId: null, bargePromise: null,
      request: null, clarify: null, options: [], current: -1, openUrl: null, history: [],
      firstSeen: {}, lastSeen: {}, pending: null, offeredIndex: null, chips: [], constraintChips: [], lastOrder: null,
      cart: createCart(),
    };
  }
  function getSession(id) {
    const key = String(id || 'default');
    let s = sessions.get(key);
    if (!s) { s = newSession(key); sessions.set(key, s); }
    return s;
  }
  function enqueue(s, fn) {
    const run = s.chain.then(() => fn());
    s.chain = run.then(() => {}, () => {});
    return run;
  }
  const n = () => (typeof now === 'function' ? now() : now);

  async function log(s, type, actor, summary, data = {}, refs = {}) {
    try {
      return await audit.append(s.id, type, actor, summary, data, refs);
    } catch (err) {
      try { emit(s.id, 'error', { message: `audit: ${err.message}` }); } catch { /* ignore */ }
      return null;
    }
  }

  function setState(s, state, option_index = s.current >= 0 ? s.current : null) {
    s.state = state;
    emit(s.id, 'state', { state, option_index });
  }

  function say(s, text, section = null, option_index = null) {
    const t = String(text || '').trim();
    if (!t) return null;
    s.sayCounter += 1;
    const say_id = `say_${String(s.sayCounter).padStart(4, '0')}`;
    s.sentences.set(say_id, { text: t, section, option_index });
    if (s.sentences.size > 400) s.sentences.delete(s.sentences.keys().next().value);
    if (s.mode === 'voice') s.pendingSay.add(say_id);
    if (s.replies) s.replies.push(t);
    s.lastSayId = say_id;
    emit(s.id, 'agent.say', { say_id, text: t, section, option_index });
    return say_id;
  }

  const isSpeaking = (s) => s.mode === 'voice' && (s.autoAdvance || s.pendingSay.size > 0);

  // ---------------------------------------------------------------- browser helpers
  async function withBrowser(fn) {
    const run = browserLock.then(fn);
    browserLock = run.then(() => {}, () => {});
    return run;
  }
  async function checkFallback(s, detail) {
    const fb = detail || browser.lastFallback;
    if (!fb) return;
    await log(s, 'fallback_used', 'system', 'Browser controller failed, used the direct page API instead', { detail: fb });
  }
  async function callBrowser(s, op, ...args) {
    if (!BROWSER_OPS.includes(op) || typeof browser[op] !== 'function') throw new Error(`browser.${op} is not available`);
    let fb = null;
    try {
      return await withBrowser(async () => {
        try { return await browser[op](...args); } finally { fb = browser.lastFallback || null; }
      });
    } finally {
      if (fb) await checkFallback(s, fb);
    }
  }
  async function quiet(s, op, ...args) {
    try { return await callBrowser(s, op, ...args); } catch { return null; }
  }
  async function scrollTo(s, section) {
    await quiet(s, 'scroll', section);
    await quiet(s, 'highlight', section);
  }

  function normalizeSnap(snap, section, s) {
    const out = { ...(snap || {}) };
    out.section = out.section || section;
    out.text = typeof out.text === 'string' ? out.text : '';
    out.fields = out.fields && typeof out.fields === 'object' ? out.fields : {};
    out.sha256 = out.sha256 || sha256Hex(out.text);
    out.snapshot_id = out.snapshot_id || `snap_${s.id}_${Date.now()}`;
    out.taken_at = out.taken_at || new Date().toISOString();
    out.url = out.url || s.openUrl;
    return out;
  }

  /** Snapshot one section of the open page (re-opening this session's page if another session moved the browser). */
  async function readSection(s, section, opt) {
    let snap = null;
    let fb = null;
    try {
      snap = await withBrowser(async () => {
        const cur = typeof browser.currentUrl === 'function' ? await browser.currentUrl() : null;
        if (s.openUrl && cur && String(cur).split('#')[0] !== String(s.openUrl).split('#')[0]) {
          await browser.open(s.openUrl);
          fb = fb || browser.lastFallback || null;
        }
        try { return await browser.snapshot(section, { session_id: s.id }); } finally { fb = fb || browser.lastFallback || null; }
      });
    } catch (err) {
      if (fb) await checkFallback(s, fb);
      await log(s, 'error', 'system', `Could not read the ${section} section: ${clip(err.message, 100)}`, { stage: 'snapshot', section, message: err.message, sku: opt?.sku ?? null });
      return null;
    }
    if (fb) await checkFallback(s, fb);
    snap = normalizeSnap(snap, section, s);
    await log(s, 'page_read', 'agent', `Read ${section} on ${spokenTitle(opt?.title) || 'the page'} (${snap.snapshot_id})`, {
      snapshot_id: snap.snapshot_id, snapshot_sha256: snap.sha256, sha256: snap.sha256, section, url: snap.url,
      sku: opt?.sku ?? null, taken_at: snap.taken_at, fields: snap.fields, text: clip(snap.text, section === 'all' ? 600 : 1500),
    }, { snapshot_id: snap.snapshot_id, sku: opt?.sku ?? null });
    return snap;
  }

  async function openPage(s, opt, index, reason) {
    const res = await callBrowser(s, 'open', opt.url);
    s.openUrl = opt.url;
    s.history.push(opt.url);
    if (index != null) s.current = index;
    await log(s, 'page_opened', 'agent', `Opened ${spokenTitle(opt.title)} at ${opt.store_name}`, {
      url: opt.url, sku: opt.sku, title: opt.title, merchant_id: opt.merchant_id, option_index: index ?? null, reason, page_title: res?.title ?? null,
    }, { sku: opt.sku, option_id: opt.option_id ?? null });
  }

  async function checkInjection(s, snap, opt) {
    const quote = detectInjection(snap.text);
    if (!quote) return;
    await log(s, 'injection_ignored', 'agent', 'Ignored instructions found in page content', {
      quote, snapshot_id: snap.snapshot_id, snapshot_sha256: snap.sha256, section: snap.section, sku: opt?.sku ?? null, url: snap.url,
    }, { snapshot_id: snap.snapshot_id, sku: opt?.sku ?? null });
  }

  async function observePrice(s, opt, price, snap, extra = {}) {
    const ts = snap?.taken_at || new Date().toISOString();
    const rec = { price, ts, snapshot_id: snap?.snapshot_id ?? null };
    if (!s.firstSeen[opt.sku]) s.firstSeen[opt.sku] = rec;
    s.lastSeen[opt.sku] = rec;
    opt.price = { ...(opt.price || {}), amount: price, currency: 'USD', observed_at: ts, snapshot_id: rec.snapshot_id };
    return log(s, 'price_observed', 'agent', `Saw ${money(price)} for ${spokenTitle(opt.title)}`, {
      sku: opt.sku, title: opt.title, price, currency: 'USD', snapshot_id: rec.snapshot_id, snapshot_sha256: snap?.sha256 ?? null,
      observed_at: ts, ...extra,
    }, { snapshot_id: rec.snapshot_id, sku: opt.sku });
  }

  function etaPhrase(iso) {
    if (!iso) return 'soon';
    const d = new Date(`${String(iso).slice(0, 10)}T12:00:00`);
    if (Number.isNaN(d.getTime())) return String(iso);
    const days = daysUntil(String(iso).slice(0, 10), n());
    if (days === 0) return 'today';
    if (days > 0 && days < 7) return weekdayName(d);
    return `${weekdayName(d)}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
  }

  function currentOption(s) {
    return s.current >= 0 ? s.options[s.current] || null : null;
  }

  function helpLine(s) {
    if (s.state === 'APPROVE') return "Say 'confirm purchase' to buy, or 'cancel'.";
    if (s.options.length) return 'Sorry, I didn\'t catch that. You can say next, go back, show me the reviews, or buy this one.';
    return 'What would you like to shop for?';
  }

  function approvedStoreNames(pol) {
    const ids = (pol && pol.approved_merchants) || merchants.map((m) => m.id);
    return ids.map((id) => merchants.find((m) => m.id === id)?.name || STORES[id]?.name || id);
  }

  function unapprovedStore(text) {
    const t = String(text || '');
    const ours = new Set();
    for (const m of merchants) { ours.add(slug(m.id)); ours.add(slug(m.name)); }
    for (const st of Object.values(STORES)) { ours.add(slug(st.id)); ours.add(slug(st.name)); }
    const domain = t.match(/\b([a-z0-9][a-z0-9-]*)\.(?:com|net|org|shop|store|co)\b/i);
    if (domain && !ours.has(slug(domain[1]))) return { id: slug(domain[1]), name: domain[0] };
    for (const m of t.matchAll(/\b(?:on|from|at|via|through)\s+([A-Za-z][\w&'-]*(?:\s+[A-Z][\w&'-]*)?)/g)) {
      const name = m[1].replace(/'s$/i, '');
      const first = name.split(/\s+/)[0];
      if (NOT_STORE.has(first.toLowerCase()) || ours.has(slug(name)) || ours.has(slug(first))) continue;
      const tail = t.slice(m.index + m[0].length);
      const atEnd = /^\s*(?:instead|please|for me|today|now|right now)?\s*[.!?]?\s*$/i.test(tail);
      if (!/[A-Z]/.test(name) && !atEnd) continue;
      return { id: slug(name), name };
    }
    return null;
  }

  // ---------------------------------------------------------------- public API
  function handle(session_id, text, { sync = false } = {}) {
    const s = getSession(session_id);
    const t = String(text ?? '').trim();
    if (!sync && isSpeaking(s)) interrupt(s, 'utterance');
    return enqueue(s, async () => {
      s.mode = sync ? 'sync' : 'voice';
      s.turn += 1;
      const replies = [];
      s.replies = replies;
      try {
        if (s.bargePromise) { const p = s.bargePromise; s.bargePromise = null; await p; }
        await ensureStarted(s);
        await log(s, 'utterance', 'user', `User: "${clip(t, 140)}"`, { text: t, mode: s.mode });
        emit(s.id, 'user.utterance', { text: t });
        if (t) await processText(s, t);
      } catch (err) {
        await fail(s, err);
      } finally {
        s.replies = null;
      }
      return { replies, state: s.state };
    });
  }

  async function ensureStarted(s) {
    if (s.started) return;
    s.started = true;
    await log(s, 'session_started', 'system', 'Session started', { user_id: USER_ID, browser_mode: browser?.mode ?? null, merchants: merchants.map((m) => m.id) });
  }

  function interrupt(s, via) {
    s.generation += 1;
    s.autoAdvance = false;
    s.pendingSay.clear();
    emit(s.id, 'speech.cancel', {});
    const optionIndex = s.current >= 0 ? s.current : null;
    if (s.state === 'NARRATE') setState(s, 'AWAIT_CHOICE', optionIndex);
    const p = (async () => {
      await log(s, 'barge_in', 'user', 'User interrupted the agent', { via, option_index: optionIndex, last_say_id: s.lastSayId });
      await log(s, 'user_interrupt', 'agent', optionIndex != null
        ? `Stopped talking; the next command applies to option ${optionIndex + 1}`
        : 'Stopped talking', { option_index: optionIndex, sku: s.options[optionIndex]?.sku ?? null });
    })();
    s.bargePromise = (s.bargePromise || Promise.resolve()).then(() => p);
    return p;
  }

  async function bargeIn(session_id) {
    const s = getSession(session_id);
    if (!isSpeaking(s)) { emit(s.id, 'speech.cancel', {}); return { ok: true, interrupted: false }; }
    await interrupt(s, 'push_to_talk');
    return { ok: true, interrupted: true };
  }

  function speaking(session_id, say_id) {
    const s = getSession(session_id);
    const info = s.sentences.get(say_id);
    if (!info || !info.section) return Promise.resolve();
    return enqueue(s, async () => {
      if (info.option_index != null && info.option_index !== s.current) return;
      await scrollTo(s, info.section);
    });
  }

  function speechDone(session_id, say_id) {
    const s = getSession(session_id);
    const num = sayNum(say_id);
    for (const id of [...s.pendingSay]) if (sayNum(id) <= num) s.pendingSay.delete(id);
    if (s.pending && s.pending.lastSayId && num >= sayNum(s.pending.lastSayId)) s.pending.requestedAt = Date.now();
    if (!s.autoAdvance || !s.narration || num < sayNum(s.narration.lastSayId)) return Promise.resolve();
    const gen = s.generation;
    return enqueue(s, async () => {
      if (gen !== s.generation || !s.autoAdvance || !s.narration) return;
      try {
        const next = s.narration.index + 1;
        if (next < s.options.length) await narrateOption(s, next, { flow: true });
        else closingQuestion(s);
      } catch (err) {
        await fail(s, err);
      }
    });
  }

  function reset(session_id) {
    const key = String(session_id || 'default');
    sessions.delete(key);
    emit(key, 'state', { state: 'IDLE', option_index: null });
    return { ok: true };
  }

  function session(session_id) {
    const s = getSession(session_id);
    return {
      session_id: s.id, state: s.state, option_index: s.current >= 0 ? s.current : null, mode: s.mode,
      options: s.options, first_seen: { ...s.firstSeen }, last_seen: { ...s.lastSeen },
      request: s.request ? { category: s.request.category, budget: s.request.budget ?? null, deadline_iso: s.request.deadline_iso ?? null } : null,
      pending: s.pending ? { kind: s.pending.kind || 'item', sku: s.pending.opt?.sku ?? null, total: s.pending.totals.total } : null,
      chips: s.chips, constraints: s.constraintChips, last_order: s.lastOrder, cart: cartView(s.cart),
    };
  }

  // ---------------------------------------------------------------- routing
  async function processText(s, text) {
    const ctx = { state: s.state, optionCount: s.options.length || 3, options: s.options.map((o) => ({ brand: o.brand, title: o.title })), cartCount: s.cart.lines.length };
    let intents = route(text, ctx);
    if (!intents.length) {
      if (isFillerOnly(text)) return; // "Wait." – speech already stopped, nothing to do
      if (!['IDLE', 'CLARIFY'].includes(s.state)) intents = await llmRoute(s, text, ctx);
    }
    if (!intents.length) { say(s, helpLine(s)); return; }
    for (let k = 0; k < intents.length; k += 1) await dispatch(s, intents[k], intents[k + 1] || null, text);
  }

  async function llmRoute(s, text, ctx) {
    if (!llm || typeof llm.complete !== 'function') return [];
    let raw = null;
    try {
      raw = await llm.complete({
        system: 'You map a shopper\'s utterance to one navigation intent for a voice shopping assistant. '
          + 'Allowed intents: next, back, goto_option {index: 0-based}, show_section {section: gallery|price|delivery|specs|reviews|returns|seller}, '
          + 'ask {question}, cancel. Reply with JSON only: {"intent": "...", "args": {...}}. If nothing fits, reply {"intent": "none"}.',
        user: JSON.stringify({ state: ctx.state, options: ctx.options.map((o) => o.title), current_option_index: s.current, utterance: text }),
        maxTokens: 120, json: true, timeoutMs: 4000,
      });
    } catch { raw = null; }
    let obj = null;
    try { obj = raw ? JSON.parse(String(raw).match(/\{[\s\S]*\}/)?.[0] || 'null') : null; } catch { obj = null; }
    if (!obj || typeof obj.intent !== 'string') return [];
    const args = obj.args && typeof obj.args === 'object' ? obj.args : {};
    let intent = obj.intent;
    // An LLM guess never buys anything: a "select" becomes plain navigation.
    if (intent === 'select' && Number.isInteger(args.index)) intent = 'goto_option';
    if (intent === 'goto_option') return Number.isInteger(args.index) && args.index >= 0 && args.index < s.options.length ? [{ intent, args: { index: args.index } }] : [];
    if (intent === 'show_section') return SECTIONS.includes(args.section) ? [{ intent, args: { section: args.section } }] : [];
    if (intent === 'ask') return [{ intent, args: { question: typeof args.question === 'string' && args.question ? args.question : text } }];
    if (['next', 'back', 'cancel'].includes(intent)) return [{ intent, args: {} }];
    return [];
  }

  async function dispatch(s, it, next, text) {
    const a = it.args || {};
    switch (it.intent) {
      case 'request': return startRequest(s, a.text ?? text);
      case 'answer_clarify': return clarifyAnswer(s, a.text ?? text);
      case 'reorder': return reorder(s, a.category ?? null);
      case 'next': return nextOption(s);
      case 'back': return backOption(s);
      case 'goto_option': {
        const silent = next && next.intent === 'select' && (next.args?.index == null || next.args.index === a.index) && !next.args?.affirm;
        return gotoOption(s, a.index, { silent });
      }
      case 'show_section': return showSection(s, a.section, text);
      case 'ask': return ask(s, a.question ?? text);
      case 'select': return select(s, a);
      case 'confirm': return confirm(s, a.transcript ?? text);
      case 'cancel': return cancel(s, text);
      case 'alternative': return alternative(s, a);
      case 'cart_add': return cartAdd(s, a);
      case 'cart_remove': return cartRemove(s, a);
      case 'cart_qty': return cartQty(s, a);
      case 'cart_show': return cartShow(s);
      case 'cart_checkout': return cartCheckout(s);
      default: say(s, helpLine(s)); return undefined;
    }
  }

  // ---------------------------------------------------------------- request → clarify → search
  function resetShopping(s) {
    s.request = null; s.clarify = null; s.options = []; s.current = -1; s.firstSeen = {}; s.lastSeen = {};
    s.pending = null; s.offeredIndex = null; s.autoAdvance = false; s.narration = null;
  }

  async function denyStore(s, shop, text) {
    const { evaluate: evalFn, policy: pol } = await getPolicy();
    let decision = null;
    try {
      decision = await evalFn({
        policy: pol, merchant_id: shop.id, category: detectCategory(text), qty: 1, totals: computeTotals(0),
        first_seen_price: null, current_price: null, in_stock: true, orders_today: 0, instruction_from_page: false, known_merchant: false,
      });
    } catch { decision = null; }
    if (!decision || decision.decision !== 'DENY') {
      decision = { decision: 'DENY', rules: ['merchant_not_approved', ...((decision && decision.rules) || [])].filter((r, i, l) => l.indexOf(r) === i), inputs: { ...((decision && decision.inputs) || {}), merchant_id: shop.id, approved_merchants: pol?.approved_merchants ?? null } };
    }
    await log(s, 'policy_decision', 'policy', `DENY: ${shop.name} is not an approved store`, {
      decision: 'DENY', rules: decision.rules, inputs: decision.inputs, merchant_id: shop.id, store_name: shop.name,
      policy_id: pol?.policy_id ?? null, policy_version: pol?.version ?? null, total: null, currency: 'USD',
    });
    emit(s.id, 'policy', { decision: 'DENY', rules: decision.rules, inputs: decision.inputs, total: null, currency: 'USD' });
    say(s, `I can only shop at your approved stores, ${joinAnd(approvedStoreNames(pol))}.`);
    setState(s, 'IDLE', null);
  }

  function prefChip(p) {
    const v = p.value || {};
    const source = p.seeded || p.source === 'seeded_for_demo' ? 'seeded profile' : 'learned';
    let label;
    if (p.key === 'size') label = `Size ${v.size}${v.width ? ` ${v.width}` : ''}`;
    else if (p.kind === 'avoid' || p.key === 'brand') label = `Avoid: ${v.brand ?? JSON.stringify(v)}`;
    else if (p.key === 'budget') label = `Budget ≈ $${fmtNum(v.max)}`;
    else if (p.key === 'usual') label = `Usual: ${v.title ?? v.sku}`;
    else if (p.key === 'last_purchase') label = `Last bought: ${spokenTitle(v.title ?? v.sku)}`;
    else if (p.key === 'address') label = `Ships to ${v.zip}`;
    else label = `${p.key}: ${Object.values(v).join(' ')}`;
    return { label, source };
  }

  async function startRequest(s, text, { clarified = false } = {}) {
    resetShopping(s);
    const shop = unapprovedStore(text);
    if (shop) return denyStore(s, shop, text);
    const category = detectCategory(text);
    if (!category) {
      if (clarified) {
        say(s, 'I can shop for running shoes or coffee at your approved stores. Tell me which one you need.');
        setState(s, 'IDLE', null);
        return undefined;
      }
      const q = 'Happy to help. What are you shopping for, and roughly what budget?';
      s.clarify = { kind: 'category', text };
      await log(s, 'clarify_question', 'agent', q, { question: q, reason: 'no_category', missing: ['category', 'budget'] });
      say(s, q);
      setState(s, 'CLARIFY', null);
      return undefined;
    }

    const req = { text, category, budget: parseBudget(text), userBudget: parseBudget(text) != null,
      deadline_iso: parseDeadline(text, n(), { ignoreEventDates: true }), event_iso: parseDeadline(text, n()) };
    s.request = req;
    const list = ((await prefs.forCategory(USER_ID, category)) || []).filter((p) => p && p.category === category && p.key !== 'last_purchase');
    req.prefs = list;
    const sizePref = list.find((p) => p.key === 'size');
    const avoid = list.filter((p) => p.kind === 'avoid' && p.value?.brand);
    const budgetPref = list.find((p) => p.key === 'budget');
    const usualPref = list.find((p) => p.key === 'usual');
    req.size = sizePref?.value?.size ?? (category === 'running_shoes' ? '10.5' : null);
    req.width = sizePref?.value?.width ?? (category === 'running_shoes' ? 'wide' : null);
    req.avoid = avoid.map((p) => p.value.brand);
    if (req.budget == null && budgetPref?.value?.max != null) req.budget = Number(budgetPref.value.max);

    s.chips = list.map(prefChip);
    if (s.chips.length) emit(s.id, 'memory', { chips: s.chips });
    for (const p of list) {
      const chip = prefChip(p);
      await log(s, 'preference_used', 'agent', `Used saved preference: ${chip.label} (${chip.source})`, {
        pref_id: p.pref_id, category: p.category, key: p.key, value: p.value, kind: p.kind, source: p.source, seeded: Boolean(p.seeded),
      }, { pref_id: p.pref_id });
    }

    if (!req.deadline_iso) {
      if (clarified) {
        req.deadline_iso = isoDate(addDays(n(), 14));
        return runSearch(s);
      }
      const parts = [];
      if (sizePref) parts.push(`size ${sizePref.value.size}${sizePref.value.width ? ` ${sizePref.value.width}` : ''}`);
      for (const p of avoid) parts.push(`no ${p.value.brand}${p.value.reason ? ` because of ${p.value.reason}` : ''}`);
      if (req.userBudget) parts.push(`budget under ${fmtNum(req.budget)}`);
      else if (budgetPref) parts.push(`budget around ${fmtNum(budgetPref.value.max)}`);
      if (usualPref) parts.push(`your usual is ${usualPref.value.title}`);
      const pronoun = category === 'running_shoes' ? 'them' : 'it';
      const q = parts.length
        ? `Your saved profile says ${parts.join(', ')}. When do you need ${pronoun}?`
        : `When do you need ${pronoun}?`;
      s.clarify = { kind: 'deadline' };
      await log(s, 'clarify_question', 'agent', q, { question: q, reason: 'no_deadline', missing: ['deadline'], prefs_used: list.map((p) => p.pref_id) });
      say(s, q);
      setState(s, 'CLARIFY', null);
      return undefined;
    }
    return runSearch(s);
  }

  async function clarifyAnswer(s, text) {
    const c = s.clarify;
    s.clarify = null;
    const shop = unapprovedStore(text);
    if (shop) return denyStore(s, shop, text);
    if (!c || c.kind === 'category' || !s.request) return startRequest(s, `${c?.text || ''} ${text}`.trim(), { clarified: true });
    const req = s.request;
    const b = parseBudget(text);
    if (b != null) { req.budget = b; req.userBudget = true; }
    const d = parseDeadline(text, n());
    if (d) req.deadline_iso = d;
    else if (c.kind !== 'refine' || !req.deadline_iso) req.deadline_iso = isoDate(addDays(n(), 14));
    return runSearch(s);
  }

  async function runSearch(s) {
    const req = s.request;
    s.constraintChips = [];
    if (req.budget != null) s.constraintChips.push({ label: `≤ $${fmtNum(req.budget)}` });
    if (req.deadline_iso) s.constraintChips.push({ label: `by ${shortDate(req.deadline_iso)}` });
    emit(s.id, 'constraints', { chips: s.constraintChips });
    setState(s, 'SEARCH', null);
    const { policy: pol } = await getPolicy();
    const approved = (pol?.approved_merchants || merchants.map((m) => m.id));
    const stores = merchants.filter((m) => approved.includes(m.id));
    say(s, stores.length === 1 ? 'Searching your approved store.' : `Searching your ${NUMBER_WORDS[stores.length] || stores.length} approved stores.`);
    const query = CATEGORY_QUERY[req.category] || req.category;
    for (const m of stores) {
      await log(s, 'search_issued', 'agent', `Searched ${m.name} for "${query}"`, {
        store: m.id, store_name: m.name, query, category: req.category,
        url: `${m.base}/api/search?q=${encodeURIComponent(query)}&category=${encodeURIComponent(req.category)}`,
      });
    }
    const searchFn = await getSearch();
    let res = await searchFn({ query, category: req.category, merchants: stores });
    if (!res?.results?.length) {
      const again = await searchFn({ query: '', category: req.category, merchants: stores });
      if (again?.results?.length) res = again;
    }
    const results = res?.results || [];
    const rankFn = await getRank();
    const ranked = rankFn(results, { budget: req.budget, deadline_iso: req.deadline_iso, size: req.size, width: req.width, avoid_brands: req.avoid || [] }) || {};
    const options = Array.isArray(ranked.ranked) ? ranked.ranked : [];
    const filtered = Array.isArray(ranked.filtered) ? ranked.filtered : [];
    const matched = results.length;
    await log(s, 'search_result', 'agent', `${res?.seen ?? results.length} seen · ${matched} match`, {
      seen: res?.seen ?? results.length, matched, shown: options.length, perStore: res?.perStore ?? [], query, category: req.category,
    });
    for (const f of filtered) {
      await log(s, 'product_filtered', 'agent', `Filtered out ${f.title || f.sku}: ${FILTER_REASON[f.reason] || f.reason}`, { sku: f.sku, title: f.title, reason: f.reason }, { sku: f.sku });
    }
    if (!options.length) {
      say(s, "I couldn't find anything at your approved stores that fits. Want me to try a higher budget or a later date?");
      s.clarify = { kind: 'refine' };
      setState(s, 'CLARIFY', null);
      return;
    }
    await log(s, 'ranking', 'agent', `Ranked ${options.length}: ${options.map((o) => spokenTitle(o.title)).join(' → ')}`, {
      weights: { rating: 0.3, pref_fit: 0.25, price: 0.3, delivery: 0.15 },
      options: options.map((o) => ({ sku: o.sku, title: o.title, position: o.rank?.position ?? null, score: o.rank?.score ?? null, components: o.rank?.components ?? null, why: o.why })),
    });
    s.options = options;
    emit(s.id, 'options', { options });
    await log(s, 'options_presented', 'agent', `Presented ${options.length} options`, {
      count: options.length, options: options.map((o) => ({ option_id: o.option_id, sku: o.sku, title: o.title, price: o.price?.amount ?? null, store: o.merchant_id })),
    });
    if (s.mode === 'voice') {
      await narrateOption(s, 0, { flow: true });
      return;
    }
    const gen = s.generation;
    for (let i = 0; i < options.length; i += 1) {
      if (gen !== s.generation) return;
      await narrateOption(s, i, { flow: false });
    }
    closingQuestion(s);
  }

  // ---------------------------------------------------------------- narration + navigation
  async function narrateOption(s, i, { flow = false } = {}) {
    const gen = s.generation;
    const opt = s.options[i];
    if (!opt) return false;
    s.offeredIndex = null;
    s.current = i;
    setState(s, 'NARRATE', i);
    await openPage(s, opt, i, 'narrate');
    if (gen !== s.generation) return false;
    const priceSnap = await readSection(s, 'price', opt);
    const delSnap = await readSection(s, 'delivery', opt);
    const revSnap = await readSection(s, 'reviews', opt);
    if (gen !== s.generation) return false;
    const price = fieldNum(priceSnap, 'price') ?? opt.price?.amount;
    if (price != null) await observePrice(s, opt, price, priceSnap);
    const eta = field(delSnap, 'eta', 'eta_date') ?? opt.delivery?.eta_date;
    const avg = fieldNum(revSnap, 'avg', 'average') ?? opt.rating?.stars;
    const count = fieldNum(revSnap, 'count', 'review_count') ?? opt.rating?.count;
    if (gen !== s.generation) return false;
    const rating = avg != null ? `, ${fmtStars(avg)} stars${count != null ? ` from ${fmtCount(count)} reviews` : ''}` : '';
    say(s, `${ORDINALS[i] || `Option ${i + 1}`}: ${spokenTitle(opt.title)} at ${opt.store_name}, ${money(price)}${rating}.`, 'price', i);
    if (eta) say(s, `The page says it arrives ${etaPhrase(eta)}.`, 'delivery', i);
    const last = say(s, ensurePeriod(opt.why || 'Solid all-round pick inside your budget.'), null, i);
    s.narration = { index: i, lastSayId: last };
    s.autoAdvance = Boolean(flow) && s.mode === 'voice';
    return true;
  }

  function closingQuestion(s) {
    s.autoAdvance = false;
    say(s, 'Which one would you like? You can also ask about reviews, specs or returns.');
    setState(s, 'AWAIT_CHOICE');
  }

  async function dropApproval(s, reason) {
    const p = s.pending;
    if (!p) return;
    s.pending = null;
    if (p.kind === 'cart') {
      await log(s, 'approval_denied', 'user', reason === 'cart_changed' ? 'Cart changed, so the pending approval no longer applies' : 'User moved on without approving the cart', {
        reason, scope: 'cart', total: p.totals.total, channel: 'voice', line_ids: p.lines.map((l) => l.line_id),
      });
      return;
    }
    await log(s, 'approval_denied', 'user', reason === 'user_chose_alternative' ? 'User chose a different option instead' : 'User moved on without approving', {
      reason, sku: p.opt.sku, total: p.totals.total, channel: 'voice',
    }, { sku: p.opt.sku });
  }

  const noOptions = (s) => { say(s, 'Tell me what you need first, and I will find three options.'); };

  async function nextOption(s) {
    if (!s.options.length) return noOptions(s);
    if (s.state === 'APPROVE') await dropApproval(s, 'user_navigated_away');
    const i = s.current + 1;
    if (i >= s.options.length) {
      say(s, 'That was the last one. Which one would you like?');
      setState(s, 'AWAIT_CHOICE');
      return undefined;
    }
    s.autoAdvance = false;
    await narrateOption(s, i, { flow: false });
    setState(s, 'AWAIT_CHOICE', i);
    return undefined;
  }

  async function showAgain(s, i, { silent = false } = {}) {
    const opt = s.options[i];
    const prev = s.history.length >= 2 ? s.history[s.history.length - 2] : null;
    if (s.openUrl !== opt.url) {
      if (prev === opt.url && i === s.current - 1) {
        await callBrowser(s, 'back');
        s.history.pop();
        s.openUrl = opt.url;
        s.current = i;
        await log(s, 'page_opened', 'agent', `Went back to ${spokenTitle(opt.title)}`, { url: opt.url, sku: opt.sku, option_index: i, reason: 'back' }, { sku: opt.sku });
      } else {
        await openPage(s, opt, i, 'navigate');
      }
    }
    s.current = i;
    if (!silent) say(s, `Here's the ${spokenTitle(opt.title)} again.`, 'price', i);
    setState(s, 'AWAIT_CHOICE', i);
  }

  async function backOption(s) {
    if (!s.options.length) return noOptions(s);
    if (s.state === 'APPROVE') await dropApproval(s, 'user_navigated_away');
    const i = s.current - 1;
    if (i < 0) { say(s, 'This is the first one.'); return undefined; }
    s.autoAdvance = false;
    return showAgain(s, i);
  }

  async function gotoOption(s, index, { silent = false } = {}) {
    if (!s.options.length) return noOptions(s);
    if (!Number.isInteger(index) || index < 0 || index >= s.options.length) {
      say(s, `I only have ${NUMBER_WORDS[s.options.length] || s.options.length} options. Say first, second or third.`);
      return undefined;
    }
    if (s.state === 'APPROVE' && !(silent && s.pending && s.pending.index === index)) await dropApproval(s, 'user_navigated_away');
    s.autoAdvance = false;
    if (!silent && !s.firstSeen[s.options[index].sku]) {
      await narrateOption(s, index, { flow: false });
      setState(s, 'AWAIT_CHOICE', index);
      return undefined;
    }
    return showAgain(s, index, { silent });
  }

  // ---------------------------------------------------------------- answers (page only)
  async function showSection(s, section, question) {
    const opt = currentOption(s);
    if (!opt) return noOptions(s);
    s.autoAdvance = false;
    await scrollTo(s, section);
    await log(s, 'page_navigate', 'agent', `Scrolled to ${section} on ${spokenTitle(opt.title)}`, { section, url: s.openUrl, sku: opt.sku, option_index: s.current }, { sku: opt.sku });
    const snap = await readSection(s, section, opt);
    if (!snap) { say(s, `I couldn't read the ${section} section right now.`); return undefined; }
    await checkInjection(s, snap, opt);
    let sentences = [];
    let span = '';
    if (section === 'reviews') {
      const avg = fieldNum(snap, 'avg', 'average');
      const count = fieldNum(snap, 'count', 'review_count');
      const crit = field(snap, 'critical_quote');
      if (avg != null) sentences.push(`Average ${fmtStars(avg)} from ${fmtCount(count)} reviews.`);
      if (crit) sentences.push(`The most helpful critical one says ${criticalGist(crit)}`);
      span = crit || leadText(snap.text);
    } else if (section === 'returns') {
      const policyText = field(snap, 'policy_text') || leadText(snap.text);
      sentences.push(`The page says: ${ensurePeriod(policyText)}`);
      span = policyText;
    } else if (section === 'price' && fieldNum(snap, 'price') != null) {
      const inStock = fieldBool(snap, 'in_stock');
      sentences.push(`The page says ${money(fieldNum(snap, 'price'))}${inStock === false ? ', and it is out of stock' : ', in stock'}, sold by ${opt.seller || opt.store_name}.`);
      span = leadText(snap.text);
    } else if (section === 'delivery' && field(snap, 'eta')) {
      const ship = fieldNum(snap, 'shipping', 'shipping_cost');
      sentences.push(`The page says it arrives ${etaPhrase(field(snap, 'eta'))}${ship === 0 ? ', with free shipping' : ''}.`);
      span = leadText(snap.text);
    }
    if (!sentences.length) {
      span = leadText(snap.text);
      sentences = [span ? `The page says: ${ensurePeriod(span)}` : `The ${section} section on this page is empty.`];
    }
    for (const t of sentences) say(s, t, section, s.current);
    const answer = sentences.join(' ');
    await log(s, 'answer_given', 'agent', clip(answer, 160), {
      question: question || `show me the ${section}`, section, snapshot_id: snap.snapshot_id, snapshot_sha256: snap.sha256,
      answer, quoted_span: span || null, span_verified: span ? verifySpan(span, snap.text) : false, sku: opt.sku,
    }, { snapshot_id: snap.snapshot_id, sku: opt.sku });
    return undefined;
  }

  async function ask(s, question) {
    const opt = currentOption(s);
    if (!opt) return noOptions(s);
    s.autoAdvance = false;
    const snap = await readSection(s, 'all', opt);
    if (!snap) { say(s, "I couldn't read the page right now, so I can't answer that."); return undefined; }
    await checkInjection(s, snap, opt);
    const res = await groundedAnswer({ question, snapshot: snap, llm });
    if (res.not_on_page) {
      const section = relatedSection(question);
      if (section) {
        await scrollTo(s, section);
        await log(s, 'page_navigate', 'agent', `Scrolled to ${section} on ${spokenTitle(opt.title)}`, { section, url: s.openUrl, sku: opt.sku, option_index: s.current, reason: 'answer_not_on_page' }, { sku: opt.sku });
      }
      const line = notOnPageLine(section, res.topic);
      say(s, line, section, s.current);
      await log(s, 'answer_not_on_page', 'agent', line, {
        question, topic: res.topic, section, snapshot_id: snap.snapshot_id, snapshot_sha256: snap.sha256, sku: opt.sku,
        rejected_span: res.rejected_span ?? null,
      }, { snapshot_id: snap.snapshot_id, sku: opt.sku });
      return undefined;
    }
    const section = res.section || sectionOfSpan(snap.text, res.quoted_span) || relatedSection(question);
    if (section) {
      await scrollTo(s, section);
      await log(s, 'page_navigate', 'agent', `Scrolled to ${section} on ${spokenTitle(opt.title)}`, { section, url: s.openUrl, sku: opt.sku, option_index: s.current }, { sku: opt.sku });
    }
    say(s, res.answer, section, s.current);
    await log(s, 'answer_given', 'agent', clip(res.answer, 160), {
      question, section, snapshot_id: snap.snapshot_id, snapshot_sha256: snap.sha256, answer: res.answer,
      quoted_span: res.quoted_span, span_verified: Boolean(res.span_verified), source: res.source ?? null, sku: opt.sku,
    }, { snapshot_id: snap.snapshot_id, sku: opt.sku });
    return undefined;
  }

  // ---------------------------------------------------------------- select → verify → policy → approve
  async function select(s, { index, affirm } = {}) {
    if (s.state === 'APPROVE' && s.pending) {
      if (index == null || index === s.pending.index) { say(s, `To buy, please say '${APPROVAL_PHRASE}'.`); return undefined; }
      await dropApproval(s, 'user_chose_alternative');
      return selectOption(s, index);
    }
    if (affirm) {
      if (s.offeredIndex != null && s.options[s.offeredIndex]) return selectOption(s, s.offeredIndex);
      say(s, s.options.length ? 'Which one would you like? Say first, second or third.' : 'What would you like to shop for?');
      return undefined;
    }
    const idx = index ?? s.current;
    if (!s.options.length) return noOptions(s);
    if (!Number.isInteger(idx) || idx < 0 || !s.options[idx]) { say(s, 'Which one would you like? Say first, second or third.'); return undefined; }
    return selectOption(s, idx);
  }

  async function selectOption(s, idx) {
    const opt = s.options[idx];
    s.autoAdvance = false;
    s.offeredIndex = null;
    await log(s, 'option_selected', 'user', `User chose ${spokenTitle(opt.title)}`, { option_index: idx, option_id: opt.option_id ?? null, sku: opt.sku, title: opt.title }, { sku: opt.sku, option_id: opt.option_id ?? null });
    say(s, `Checking the ${opt.brand || spokenTitle(opt.title)} page again before I buy.`, 'price', idx);
    return verify(s, opt, idx, {});
  }

  function returnsShort(snap) {
    if (!snap) return null;
    const days = fieldNum(snap, 'window_days');
    const text = `${field(snap, 'policy_text') || ''} ${snap.text || ''}`;
    const free = /return shipping is free|free returns|free return shipping/i.test(text);
    return days ? `${days}-day ${free ? 'free ' : ''}returns` : null;
  }

  function cheapestAlternative(s, opt, limit) {
    let best = null;
    s.options.forEach((o, i) => {
      if (o.sku === opt.sku || o.in_stock === false) return;
      const p = (s.lastSeen[o.sku] || s.firstSeen[o.sku])?.price ?? o.price?.amount;
      if (!Number.isFinite(Number(p))) return;
      const total = computeTotals(Number(p), 1, Number(o.delivery?.shipping_cost) || 0).total;
      if (limit != null && total > limit) return;
      if (!best || Number(p) < best.price) best = { opt: o, index: i, price: Number(p), total };
    });
    return best;
  }

  async function verify(s, opt, idx, { reorder = false, first = null } = {}) {
    s.pending = null;
    setState(s, 'VERIFY', idx);
    if (s.openUrl !== opt.url) await openPage(s, opt, idx, 'verify');
    s.current = idx;
    await callBrowser(s, 'reload');
    await log(s, 'page_reload', 'agent', `Reloaded ${spokenTitle(opt.title)} to re-check price and stock`, { url: opt.url, sku: opt.sku }, { sku: opt.sku });
    const priceSnap = await readSection(s, 'price', opt);
    const price = fieldNum(priceSnap, 'price');
    if (price == null) {
      say(s, "I couldn't re-check the price on the page, so I won't buy it right now.");
      setState(s, s.options.length > 1 ? 'AWAIT_CHOICE' : 'IDLE', idx);
      return undefined;
    }
    const delSnap = await readSection(s, 'delivery', opt);
    const retSnap = await readSection(s, 'returns', opt);
    const inStock = fieldBool(priceSnap, 'in_stock') ?? true;
    const seen = first || s.firstSeen[opt.sku] || null;
    const changed = Boolean(seen) && Math.abs(Number(seen.price) - price) >= 0.005;
    await observePrice(s, opt, price, priceSnap, {
      previous_price: seen?.price ?? null, previous_observed_at: seen?.ts ?? null, previous_snapshot_id: seen?.snapshot_id ?? null,
      changed, at: 'verify',
    });
    await log(s, 'stock_checked', 'agent', inStock ? `${spokenTitle(opt.title)} is in stock` : `${spokenTitle(opt.title)} is out of stock`, {
      sku: opt.sku, in_stock: inStock, snapshot_id: priceSnap.snapshot_id, snapshot_sha256: priceSnap.sha256,
    }, { snapshot_id: priceSnap.snapshot_id, sku: opt.sku });
    const eta = field(delSnap, 'eta', 'eta_date') || opt.delivery?.eta_date || null;
    const shipping = fieldNum(delSnap, 'shipping', 'shipping_cost') ?? Number(opt.delivery?.shipping_cost ?? 0);
    const totals = computeTotals(price, 1, shipping);

    setState(s, 'POLICY', idx);
    const { evaluate: evalFn, policy: pol } = await getPolicy();
    const ordersToday = await store.orders.countToday(USER_ID);
    const decision = await evalFn({
      policy: pol, merchant_id: opt.merchant_id, category: opt.category || s.request?.category || null, qty: 1, totals,
      first_seen_price: seen?.price ?? price, current_price: price, in_stock: inStock, orders_today: ordersToday,
      instruction_from_page: false, known_merchant: true,
    });
    const limit = decision.limit ?? pol?.auto_approve?.max_total ?? null;
    const polEvent = await log(s, 'policy_decision', 'policy', `${decision.decision}${decision.rules.length ? ` (${decision.rules.join(', ')})` : ''}: total ${money(totals.total)}, auto-buy ≤ ${money(limit)}`, {
      decision: decision.decision, rules: decision.rules, inputs: decision.inputs, limit, total: totals.total, currency: totals.currency,
      policy_id: pol?.policy_id ?? null, policy_version: pol?.version ?? null, sku: opt.sku,
    }, { sku: opt.sku });
    emit(s.id, 'policy', { decision: decision.decision, rules: decision.rules, inputs: decision.inputs, total: totals.total, currency: totals.currency, limit });
    if (changed) {
      emit(s.id, 'price_diff', { sku: opt.sku, title: opt.title, before: seen.price, after: price, before_ts: seen.ts, after_ts: priceSnap.taken_at });
      say(s, `The price changed since I first looked: ${money(seen.price)} then, ${money(price)} now.`, 'price', idx);
    }

    if (decision.decision === 'DENY') {
      if (decision.rules.includes('out_of_stock')) {
        say(s, "It's out of stock now, so I can't buy it.", 'price', idx);
        const others = s.options.map((o, i) => ({ o, i })).filter(({ o, i }) => i !== idx && o.in_stock !== false);
        const alt = others.find(({ i }) => i > idx) || others[0];
        if (alt) {
          const p = (s.lastSeen[alt.o.sku] || s.firstSeen[alt.o.sku])?.price ?? alt.o.price?.amount;
          say(s, `The ${spokenTitle(alt.o.title)} is ${money(p)}. Want that one instead?`);
          s.offeredIndex = alt.i;
        }
      } else {
        say(s, `My spending policy blocks this purchase (${decision.rules.join(', ').replace(/_/g, ' ')}), so I won't buy it.`);
      }
      setState(s, s.options.length > 1 ? 'AWAIT_CHOICE' : 'IDLE', idx);
      return undefined;
    }

    const shortReturns = returnsShort(retSnap);
    const seller = opt.seller || opt.store_name;
    const summary = `Total is ${money(totals.total)} with tax, ${shipping === 0 ? 'free shipping' : `${money(shipping)} shipping`}`
      + `${eta ? `, arrives ${etaPhrase(eta)}` : ''}${shortReturns ? `, ${shortReturns}` : ''}, sold by ${seller}.`;
    const pending = {
      opt, index: idx, price, totals, eta, shipping, returnsShort: shortReturns,
      returnPolicyText: field(retSnap, 'policy_text') || null, firstSeen: seen, changed, polEvent, decision, reorder,
      requestedTurn: s.turn, requestedAt: Date.now(), lastSayId: null,
    };
    if (decision.decision === 'AUTO_APPROVE') {
      if (!reorder) {
        say(s, summary, null, idx);
        say(s, "That's under your limit, so I'm buying it now.");
      }
      return checkout(s, pending, { mode: 'auto' });
    }

    say(s, summary, null, idx);
    const rules = decision.rules;
    say(s, approvalReason(rules, limit));
    const alt = cheapestAlternative(s, opt, limit);
    pending.lastSayId = say(s, alt
      ? `Say '${APPROVAL_PHRASE}' to buy, or I can get the ${alt.opt.brand || spokenTitle(alt.opt.title)} at ${money(alt.price)} instead.`
      : `Say '${APPROVAL_PHRASE}' to buy.`);
    pending.alternativeIndex = alt ? alt.index : null;
    s.pending = pending;
    s.offeredIndex = alt ? alt.index : null;
    await log(s, 'approval_requested', 'agent', `Asked for "${APPROVAL_PHRASE}" (total ${money(totals.total)})`, {
      sku: opt.sku, total: totals.total, currency: totals.currency, rules, phrase: pol?.approval?.phrase || APPROVAL_PHRASE,
      channel: pol?.approval?.channel || 'voice', timeout_s: pol?.approval?.timeout_s ?? null,
      alternative_sku: alt ? alt.opt.sku : null, policy_decision_event_id: polEvent?.event_id ?? null,
    }, { sku: opt.sku, event_id: polEvent?.event_id ?? null });
    setState(s, 'APPROVE', idx);
    return undefined;
  }

  async function confirm(s, transcript) {
    if (s.state !== 'APPROVE' || !s.pending) { say(s, "There's nothing waiting for your approval right now."); return undefined; }
    if (s.pending.requestedTurn === s.turn) return undefined; // must come after the total was spoken, not in the same breath
    if (s.pending.kind === 'cart') return confirmCart(s, transcript);
    const { policy: pol } = await getPolicy();
    const timeout = Number(pol?.approval?.timeout_s) || 0;
    const p = s.pending;
    if (timeout && Date.now() - p.requestedAt > timeout * 1000) {
      s.pending = null;
      await log(s, 'approval_denied', 'system', 'Approval window expired', { reason: 'timeout', sku: p.opt.sku, total: p.totals.total, timeout_s: timeout }, { sku: p.opt.sku });
      say(s, 'That approval window expired, so let me check the page again.');
      return verify(s, p.opt, p.index, { reorder: p.reorder, first: p.firstSeen });
    }
    const ev = await log(s, 'approval_granted', 'user', `User said "${clip(transcript, 80)}"`, {
      channel: 'voice', transcript, phrase: APPROVAL_PHRASE, policy_version: pol?.version ?? null, policy_id: pol?.policy_id ?? null,
      sku: p.opt.sku, total: p.totals.total, policy_decision_event_id: p.polEvent?.event_id ?? null,
    }, { sku: p.opt.sku, event_id: p.polEvent?.event_id ?? null });
    s.pending = null;
    s.offeredIndex = null;
    say(s, 'Confirmed. Placing the order.');
    return checkout(s, p, { mode: 'user_explicit', channel: 'voice', transcript, event_id: ev?.event_id ?? null });
  }

  async function cancel(s, text) {
    if (s.state === 'APPROVE' && s.pending) {
      const p = s.pending;
      s.pending = null;
      if (p.kind === 'cart') {
        await log(s, 'approval_denied', 'user', `User declined the cart checkout: "${clip(text, 80)}"`, { reason: 'user_cancelled', scope: 'cart', channel: 'voice', transcript: text, total: p.totals.total, line_ids: p.lines.map((l) => l.line_id) });
        say(s, "Okay, I won't check out. Your cart is still there.");
        setState(s, s.options.length ? 'AWAIT_CHOICE' : 'IDLE');
        return undefined;
      }
      await log(s, 'approval_denied', 'user', `User declined: "${clip(text, 80)}"`, { reason: 'user_cancelled', channel: 'voice', transcript: text, sku: p.opt.sku, total: p.totals.total }, { sku: p.opt.sku });
      say(s, "Okay, I won't buy it.");
      setState(s, s.options.length > 1 ? 'AWAIT_CHOICE' : 'IDLE');
      return undefined;
    }
    if (s.state === 'CLARIFY') {
      s.clarify = null;
      say(s, 'Okay. Tell me whenever you need something.');
      setState(s, 'IDLE', null);
      return undefined;
    }
    s.offeredIndex = null;
    say(s, 'Okay.');
    return undefined;
  }

  async function alternative(s, { hint, index } = {}) {
    let idx = Number.isInteger(index) ? index : -1;
    if (idx < 0 && hint && !['cheaper', 'other'].includes(hint)) {
      idx = s.options.findIndex((o) => String(o.brand || '').toLowerCase() === hint || String(o.title || '').toLowerCase().includes(hint));
    }
    const base = s.pending && s.pending.opt ? s.pending.opt : currentOption(s);
    if (idx < 0) idx = s.pending?.alternativeIndex ?? s.offeredIndex ?? -1;
    if (idx < 0 && base) idx = cheapestAlternative(s, base, null)?.index ?? -1;
    if (idx < 0 || !s.options[idx]) { say(s, "I don't have another option that fits."); return undefined; }
    if (s.state === 'APPROVE' && s.pending) await dropApproval(s, 'user_chose_alternative');
    return selectOption(s, idx);
  }


  // ---------------------------------------------------------------- cart
  function approvalReason(rules, limit, { cart = false } = {}) {
    if (rules.includes('total_over_limit')) return `That's over your ${money(limit)} auto-buy limit.`;
    if (rules.includes('price_increased_since_first_seen')) return cart ? 'A price went up, so I need your OK.' : 'The price went up, so I need your OK.';
    if (rules.includes('daily_order_limit')) return cart ? "That would go past today's order limit, so I need your OK." : "You've reached today's order limit, so I need your OK.";
    if (rules.includes('new_merchant')) return 'This is a new store for you, so I need your OK.';
    if (rules.includes('quantity_gt_2')) return cart ? "That's more than two of one item, so I need your OK." : "That's more than two items, so I need your OK.";
    return cart ? 'This cart needs your OK.' : 'This one needs your OK.';
  }

  const itemWord = (n) => `${n} item${n === 1 ? '' : 's'}`;
  function emitCart(s, extra = {}) {
    emit(s.id, 'cart', { cart: cartView(s.cart), ...extra });
  }
  function cartLineFacts(line) {
    return {
      line_id: line.line_id, sku: line.sku, title: line.title, merchant_id: line.merchant_id, store_name: line.store_name, qty: line.qty,
      unit_price: line.unit_price, currency: line.currency, price_seen_at: line.seen_at, snapshot_id: line.snapshot_id, source: line.source,
    };
  }
  function cartSig(cart) {
    return cart.lines.map((l) => `${l.line_id}:${l.qty}`).join('|');
  }
  /** A pending cart approval is only valid for the cart it was asked for. */
  async function cartChanged(s) {
    if (s.pending && s.pending.kind === 'cart') {
      await dropApproval(s, 'cart_changed');
      if (s.state === 'APPROVE') setState(s, s.options.length ? 'AWAIT_CHOICE' : 'IDLE');
    }
  }

  /** The product a phrase means: an option ("the second one", "the Kestrel", "this"), or the usual item of a category ("the coffee"). */
  async function itemForTarget(s, target) {
    const t = normalize(target);
    const opts = s.options;
    const ctx = { optionCount: opts.length || 3, options: opts.map((o) => ({ brand: o.brand, title: o.title })) };
    const tg = opts.length ? parseTarget(t, ctx) : null;
    if (tg && tg.index != null && opts[tg.index]) return { opt: opts[tg.index], index: tg.index };
    const cur = currentOption(s);
    const category = detectCategory(t);
    if (category && !(cur && cur.category === category)) {
      const idx = opts.findIndex((o) => o.category === category);
      if (idx >= 0) return { opt: opts[idx], index: idx };
      const pref = await prefs.usual(USER_ID, category);
      const v = pref?.value || {};
      const merchant = merchants.find((m) => m.id === v.merchant_id);
      if (!pref || !merchant) return { missing: category };
      const base = String(merchant.base).replace(/\/+$/, '');
      return {
        usual: pref,
        opt: {
          option_id: 'opt_usual', sku: v.sku, merchant_id: merchant.id, store_name: merchant.name, title: v.title, brand: v.brand ?? null,
          category, demo_data: true, url: `${base}/p/${v.sku}`, seller: merchant.name, in_stock: true,
          price: { amount: Number(v.last_price ?? v.price), currency: 'USD', observed_at: null, snapshot_id: null },
          delivery: { eta_date: null, shipping_cost: 0 },
        },
        index: null,
      };
    }
    if (cur) return { opt: cur, index: s.current };
    if (opts.length === 1) return { opt: opts[0], index: 0 };
    return null;
  }

  /** The price to put on the line: the newest one read on the page; for an item never opened, read its page now. */
  async function seenPrice(s, found) {
    const { opt } = found;
    const seen = s.lastSeen[opt.sku];
    if (seen && Number.isFinite(Number(seen.price))) return { price: Number(seen.price), seen_at: seen.ts, snapshot_id: seen.snapshot_id, price_source: 'product_page' };
    const back = s.openUrl;
    await openPage(s, opt, null, 'cart_add');
    const snap = await readSection(s, 'price', opt);
    const price = fieldNum(snap, 'price');
    if (price != null) await observePrice(s, opt, price, snap, { at: 'cart_add' });
    if (back && back !== opt.url) {
      await quiet(s, 'open', back);
      s.openUrl = back;
      s.history.push(back);
    }
    if (price == null) {
      const p = Number(opt.price?.amount);
      return Number.isFinite(p) ? { price: p, seen_at: opt.price?.observed_at || new Date().toISOString(), snapshot_id: null, price_source: 'store_search' } : null;
    }
    return { price, seen_at: snap.taken_at, snapshot_id: snap.snapshot_id, price_source: 'product_page' };
  }

  async function cartAdd(s, { target = 'this', qty = 1 } = {}) {
    s.autoAdvance = false;
    const found = await itemForTarget(s, target);
    if (!found) {
      say(s, s.options.length ? 'Which one should I add? Say the first, second or third one.' : "Tell me what you're looking for first, then I can add it to your cart.");
      return undefined;
    }
    if (found.missing) {
      say(s, `I haven't found any ${CATEGORY_LABEL[found.missing] || found.missing} yet. Tell me what you need and I'll show you options to add.`);
      return undefined;
    }
    const { opt } = found;
    const seen = await seenPrice(s, found);
    if (!seen) { say(s, `I couldn't read the price of the ${spokenTitle(opt.title)}, so I didn't add it.`); return undefined; }
    await cartChanged(s);
    const first = s.firstSeen[opt.sku]?.price;
    const r = addItem(s.cart, {
      sku: opt.sku, title: opt.title, brand: opt.brand, category: opt.category || s.request?.category || null,
      merchant_id: opt.merchant_id, store_name: opt.store_name, url: opt.url, image_url: opt.image_url || null,
      unit_price: seen.price, currency: 'USD', seen_at: seen.seen_at, snapshot_id: seen.snapshot_id,
      first_seen_price: Number.isFinite(Number(first)) ? Number(first) : seen.price,
      shipping_cost: Number(opt.delivery?.shipping_cost) || 0, source: 'demo',
    }, qty);
    const totals = cartTotals(s.cart);
    const { line } = r;
    await log(s, 'cart_item_added', 'agent', `Added ${r.added} × ${spokenTitle(line.title)} at ${money(seen.price)} to the cart`, {
      ...cartLineFacts(line), qty_added: r.added, qty_before: r.qty_before, price_source: seen.price_source,
      option_index: found.index, from_usual: Boolean(found.usual), cart_items: totals.item_count, cart_total: totals.total, currency: 'USD',
    }, { sku: line.sku, snapshot_id: line.snapshot_id ?? null });
    emitCart(s, { change: 'added', line_id: line.line_id, added: r.added });
    if (!r.added) {
      say(s, `You already have ${line.qty} of the ${spokenTitle(line.title)}, that's the most I can add.`);
      return undefined;
    }
    const what = r.added > 1 ? `${r.added} of the ${spokenTitle(line.title)}` : `the ${spokenTitle(line.title)}`;
    say(s, `Added ${what}. Your cart has ${itemWord(totals.item_count)}, ${money(totals.total)} with tax.`);
    return undefined;
  }

  function cartSummaryLine(s) {
    const t = cartTotals(s.cart);
    const parts = s.cart.lines.map((l) => `${l.qty} ${spokenTitle(l.title)} from ${l.store_name}`);
    const list = parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
    return `Your cart: ${list}. Total ${money(t.total)} with tax, ${t.shipping ? `${money(t.shipping)} shipping` : 'free shipping'}.`;
  }

  async function cartShow(s) {
    s.autoAdvance = false;
    if (!s.cart.lines.length) { say(s, 'Your cart is empty.'); emitCart(s, { open: true }); return undefined; }
    say(s, cartSummaryLine(s));
    emitCart(s, { open: true });
    return undefined;
  }

  async function removeFromCart(s, line, via) {
    const r = setQty(s.cart, line.line_id, 0);
    if (!r) return null;
    const totals = cartTotals(s.cart);
    await log(s, 'cart_item_removed', via === 'panel' ? 'user' : 'agent', `Removed ${spokenTitle(line.title)} from the cart`, {
      ...cartLineFacts(line), qty_before: r.qty_before, via, cart_items: totals.item_count, cart_total: totals.total, currency: 'USD',
    }, { sku: line.sku });
    emitCart(s, { change: 'removed', line_id: line.line_id });
    return totals;
  }

  async function cartRemove(s, { target = 'it', all = false } = {}) {
    s.autoAdvance = false;
    if (!s.cart.lines.length) { say(s, 'Your cart is already empty.'); return undefined; }
    await cartChanged(s);
    if (all) {
      for (const line of [...s.cart.lines]) await removeFromCart(s, line, 'voice');
      say(s, 'Done, your cart is empty.');
      return undefined;
    }
    const line = findLine(s.cart, target);
    if (!line) { say(s, `I don't see that in your cart. ${cartSummaryLine(s)}`); return undefined; }
    const totals = await removeFromCart(s, line, 'voice');
    say(s, totals.item_count
      ? `Removed the ${spokenTitle(line.title)}. Your cart has ${itemWord(totals.item_count)}, ${money(totals.total)} with tax.`
      : `Removed the ${spokenTitle(line.title)}. Your cart is empty now.`);
    return undefined;
  }

  async function changeQty(s, line, qty, via) {
    if (qty <= 0) return removeFromCart(s, line, via);
    const r = setQty(s.cart, line.line_id, qty);
    if (!r) return null;
    const totals = cartTotals(s.cart);
    await log(s, 'cart_quantity_changed', via === 'panel' ? 'user' : 'agent', `Changed ${spokenTitle(line.title)} from ${r.qty_before} to ${r.line.qty}`, {
      ...cartLineFacts(r.line), qty_before: r.qty_before, via, cart_items: totals.item_count, cart_total: totals.total, currency: 'USD',
    }, { sku: line.sku });
    emitCart(s, { change: 'quantity', line_id: line.line_id });
    return totals;
  }

  async function cartQty(s, { target = 'it', qty } = {}) {
    s.autoAdvance = false;
    if (!s.cart.lines.length) { say(s, 'Your cart is empty.'); return undefined; }
    const line = findLine(s.cart, target);
    if (!line) { say(s, `I don't see that in your cart. ${cartSummaryLine(s)}`); return undefined; }
    await cartChanged(s);
    const totals = await changeQty(s, line, qty, 'voice');
    if (!totals) return undefined;
    say(s, qty <= 0
      ? `Removed the ${spokenTitle(line.title)}.`
      : `Now ${line.qty} of the ${spokenTitle(line.title)}. Your cart total is ${money(totals.total)} with tax.`);
    return undefined;
  }

  /** Panel: quantity stepper and remove button in the cart view. Same audit trail, no speech. */
  function cartUpdate(session_id, { op, line_id, qty } = {}) {
    const s = getSession(session_id);
    return enqueue(s, async () => {
      await ensureStarted(s);
      const line = s.cart.lines.find((l) => l.line_id === line_id);
      if (!line) return { ok: false, error: 'unknown line', cart: cartView(s.cart) };
      await cartChanged(s);
      if (op === 'remove') await removeFromCart(s, line, 'panel');
      else if (op === 'qty' && Number.isFinite(Number(qty))) await changeQty(s, line, Math.floor(Number(qty)), 'panel');
      else return { ok: false, error: 'op must be qty or remove', cart: cartView(s.cart) };
      return { ok: true, cart: cartView(s.cart) };
    });
  }

  async function cartCheckout(s) {
    s.autoAdvance = false;
    if (!s.cart.lines.length) { say(s, 'Your cart is empty. Add something first.'); return undefined; }
    const lines = s.cart.lines.filter((l) => l.source !== 'external');
    if (!lines.length) { say(s, 'Those items are from other stores. Open them at the store to buy.'); return undefined; }
    if (s.pending) await dropApproval(s, s.pending.kind === 'cart' ? 'cart_rechecked' : 'user_navigated_away');
    const before = cartTotals(s.cart);
    setState(s, 'VERIFY', null);
    await log(s, 'cart_checkout_started', 'agent', `Checking out the cart: ${itemWord(before.item_count)} from ${before.stores.map((x) => x.store_name).join(' and ')} (${money(before.total)} as added)`, {
      lines: lines.map(cartLineFacts), total_as_added: before.total, subtotal: before.subtotal, tax: before.tax, shipping: before.shipping, currency: 'USD',
      stores: before.stores.map((x) => ({ merchant_id: x.merchant_id, store_name: x.store_name, items: x.item_count, total: x.total })),
    });
    const stores = before.stores.map((x) => x.store_name);
    say(s, `Checking out ${itemWord(before.item_count)} from ${joinAnd(stores)}. I'll re-check every page first.`);

    // 1. re-check price and stock of every line on its page
    const prices = {};
    const stock = {};
    const changed = [];
    for (const line of lines) {
      const opt = { sku: line.sku, url: line.url, title: line.title, store_name: line.store_name, merchant_id: line.merchant_id, price: { amount: line.unit_price } };
      if (s.openUrl !== line.url) await openPage(s, opt, null, 'cart_verify');
      await callBrowser(s, 'reload');
      await log(s, 'page_reload', 'agent', `Reloaded ${spokenTitle(line.title)} to re-check price and stock`, { url: line.url, sku: line.sku, line_id: line.line_id }, { sku: line.sku });
      const snap = await readSection(s, 'price', opt);
      const price = fieldNum(snap, 'price');
      if (price == null) {
        say(s, `I couldn't re-check the price of the ${spokenTitle(line.title)}, so I won't check out right now.`);
        setState(s, s.options.length ? 'AWAIT_CHOICE' : 'IDLE');
        return undefined;
      }
      const inStock = fieldBool(snap, 'in_stock') ?? true;
      const ch = Math.abs(Number(line.unit_price) - price) >= 0.005;
      await observePrice(s, opt, price, snap, {
        previous_price: line.unit_price, previous_observed_at: line.seen_at, previous_snapshot_id: line.snapshot_id, changed: ch, at: 'cart_verify', line_id: line.line_id,
      });
      await log(s, 'stock_checked', 'agent', inStock ? `${spokenTitle(line.title)} is in stock` : `${spokenTitle(line.title)} is out of stock`, {
        sku: line.sku, in_stock: inStock, snapshot_id: snap.snapshot_id, snapshot_sha256: snap.sha256, line_id: line.line_id,
      }, { snapshot_id: snap.snapshot_id, sku: line.sku });
      prices[line.line_id] = price;
      stock[line.line_id] = inStock;
      if (ch) changed.push({ line, before: line.unit_price, after: price, at: snap.taken_at });
    }

    // 2. the same purchase policy as a single item, for every line, plus the whole cart against the limits
    setState(s, 'POLICY', null);
    const now = cartTotals(s.cart, prices);
    const { evaluate: evalFn, policy: pol } = await getPolicy();
    const ordersToday = await store.orders.countToday(USER_ID);
    const perLine = [];
    for (const line of lines) {
      perLine.push(await evalFn({
        policy: pol, merchant_id: line.merchant_id, category: line.category, qty: line.qty, totals: lineTotals(line, prices[line.line_id]),
        first_seen_price: line.first_seen_price, current_price: prices[line.line_id], in_stock: stock[line.line_id], orders_today: ordersToday,
        instruction_from_page: false, known_merchant: true,
      }));
    }
    // One order per line: the day's order count must hold for all of them.
    const countedToday = ordersToday + lines.length - 1;
    const whole = await evalFn({
      policy: pol, merchant_id: lines[0].merchant_id, category: lines[0].category, qty: Math.max(...lines.map((l) => l.qty)),
      totals: { subtotal: now.subtotal, tax: now.tax, shipping: now.shipping, total: now.total, currency: 'USD' },
      first_seen_price: null, current_price: null, in_stock: lines.every((l) => stock[l.line_id] !== false), orders_today: countedToday,
      instruction_from_page: false, known_merchant: true,
    });
    const all = [...perLine, whole];
    const rules = [...new Set(all.flatMap((d) => d.rules || []))];
    const decision = all.some((d) => d.decision === 'DENY') ? 'DENY' : all.some((d) => d.decision === 'REQUIRE_APPROVAL') || rules.length ? 'REQUIRE_APPROVAL' : 'AUTO_APPROVE';
    const limit = whole.limit ?? pol?.auto_approve?.max_total ?? null;
    const lineFacts = lines.map((l, i) => ({
      line_id: l.line_id, sku: l.sku, title: l.title, qty: l.qty, merchant_id: l.merchant_id, store_name: l.store_name,
      price_added: l.unit_price, price_now: prices[l.line_id], in_stock: stock[l.line_id], decision: perLine[i].decision, rules: perLine[i].rules,
      total: lineTotals(l, prices[l.line_id]).total,
    }));
    const inputs = {
      scope: 'cart', policy_id: pol?.policy_id ?? null, policy_version: pol?.version ?? null, limit, total: now.total, total_as_added: before.total,
      orders_today: ordersToday, orders_to_place: lines.length, orders_today_counted: countedToday,
      max_orders_per_day: pol?.auto_approve?.max_orders_per_day ?? null, approved_merchants: [...(pol?.approved_merchants || [])],
      max_qty: Math.max(...lines.map((l) => l.qty)), currency: 'USD',
    };
    const polEvent = await log(s, 'policy_decision', 'policy', `${decision}${rules.length ? ` (${rules.join(', ')})` : ''}: cart total ${money(now.total)}, auto-buy ≤ ${money(limit)}`, {
      scope: 'cart', decision, rules, inputs, limit, total: now.total, total_as_added: before.total, currency: 'USD',
      policy_id: pol?.policy_id ?? null, policy_version: pol?.version ?? null, lines: lineFacts,
    });
    for (const c of changed) {
      emit(s.id, 'price_diff', { sku: c.line.sku, title: c.line.title, before: c.before, after: c.after, before_ts: c.line.seen_at, after_ts: c.at, scope: 'cart' });
    }
    emit(s.id, 'policy', {
      scope: 'cart', decision, rules, inputs, total: now.total, total_as_added: before.total, currency: 'USD', limit, lines: lineFacts,
      stores: now.stores.map((x) => ({ merchant_id: x.merchant_id, store_name: x.store_name, items: x.item_count, total: x.total })),
    });
    for (const c of changed) say(s, `The ${spokenTitle(c.line.title)} changed since you added it: ${money(c.before)} then, ${money(c.after)} now.`);

    if (decision === 'DENY') {
      const out = lines.filter((l) => stock[l.line_id] === false);
      if (out.length) say(s, `The ${joinAnd(out.map((l) => spokenTitle(l.title)))} ${out.length === 1 ? 'is' : 'are'} out of stock now, so I can't check out. Remove ${out.length === 1 ? 'it' : 'them'} and I'll try again.`);
      else say(s, `My spending policy blocks this cart (${rules.join(', ').replace(/_/g, ' ')}), so I won't check out.`);
      setState(s, s.options.length ? 'AWAIT_CHOICE' : 'IDLE');
      return undefined;
    }

    const orderWord = lines.length === 1 ? 'one order' : `${NUMBER_WORDS[lines.length] || lines.length} orders`;
    const summary = `Cart total is ${money(now.total)} with tax, ${now.shipping ? `${money(now.shipping)} shipping` : 'free shipping'}${changed.length ? `, it was ${money(before.total)} when you added the items` : ''}.`;
    const pending = {
      kind: 'cart', index: null, lines: lines.map((l) => ({ ...l })), prices, stock, totals: now, before, changed, decision: { decision, rules },
      polEvent, sig: cartSig(s.cart), requestedTurn: s.turn, requestedAt: Date.now(), lastSayId: null,
    };
    say(s, summary);
    if (decision === 'AUTO_APPROVE') {
      say(s, `That's under your limit, so I'm placing ${orderWord} now.`);
      return checkoutCart(s, pending, { mode: 'auto' });
    }
    say(s, approvalReason(rules, limit, { cart: true }));
    pending.lastSayId = say(s, `Say '${APPROVAL_PHRASE}' to place ${orderWord}.`);
    s.pending = pending;
    s.offeredIndex = null;
    await log(s, 'approval_requested', 'agent', `Asked for "${APPROVAL_PHRASE}" (cart total ${money(now.total)})`, {
      scope: 'cart', total: now.total, total_as_added: before.total, currency: 'USD', rules, phrase: pol?.approval?.phrase || APPROVAL_PHRASE,
      channel: pol?.approval?.channel || 'voice', timeout_s: pol?.approval?.timeout_s ?? null, line_ids: lines.map((l) => l.line_id),
      policy_decision_event_id: polEvent?.event_id ?? null,
    }, { event_id: polEvent?.event_id ?? null });
    setState(s, 'APPROVE', null);
    return undefined;
  }

  async function confirmCart(s, transcript) {
    const { policy: pol } = await getPolicy();
    const timeout = Number(pol?.approval?.timeout_s) || 0;
    const p = s.pending;
    if (p.sig !== cartSig(s.cart)) {
      s.pending = null;
      await log(s, 'approval_denied', 'system', 'Cart changed after the approval was requested', { reason: 'cart_changed', scope: 'cart', total: p.totals.total });
      say(s, 'Your cart changed, so let me check it again.');
      return cartCheckout(s);
    }
    if (timeout && Date.now() - p.requestedAt > timeout * 1000) {
      s.pending = null;
      await log(s, 'approval_denied', 'system', 'Approval window expired', { reason: 'timeout', scope: 'cart', total: p.totals.total, timeout_s: timeout });
      say(s, 'That approval window expired, so let me check the cart again.');
      return cartCheckout(s);
    }
    const ev = await log(s, 'approval_granted', 'user', `User said "${clip(transcript, 80)}"`, {
      scope: 'cart', channel: 'voice', transcript, phrase: APPROVAL_PHRASE, policy_version: pol?.version ?? null, policy_id: pol?.policy_id ?? null,
      total: p.totals.total, line_ids: p.lines.map((l) => l.line_id), policy_decision_event_id: p.polEvent?.event_id ?? null,
    }, { event_id: p.polEvent?.event_id ?? null });
    s.pending = null;
    say(s, 'Confirmed. Placing the orders.');
    return checkoutCart(s, p, { mode: 'user_explicit', channel: 'voice', transcript, event_id: ev?.event_id ?? null });
  }

  async function checkoutCart(s, p, approval) {
    setState(s, 'CHECKOUT', null);
    const orders = [];
    let failed = null;
    for (const line of p.lines) {
      const price = p.prices[line.line_id];
      const expected = lineTotals(line, price);
      await log(s, 'checkout_started', 'agent', `Checking out ${line.qty} × ${spokenTitle(line.title)} at ${line.store_name} (${money(expected.total)})`, {
        sku: line.sku, url: line.url, qty: line.qty, merchant_id: line.merchant_id, total: expected.total, approval_mode: approval.mode, scope: 'cart', line_id: line.line_id,
      }, { sku: line.sku });
      let res = null;
      try {
        res = await callBrowser(s, 'checkout', { url: line.url, sku: line.sku, qty: line.qty });
      } catch (err) {
        res = { error: err };
      }
      for (const st of (res && res.steps) || []) {
        await log(s, 'checkout_step', 'agent', `Checkout step: ${st.step}${st.ok === false ? ' (failed)' : ''}`, { step: st.step, ok: st.ok !== false, ms: st.ms ?? null, executor: res.executor ?? null, line_id: line.line_id }, { sku: line.sku });
      }
      if (!res || res.error || !res.order_id) {
        const message = res?.error?.message || 'no order id returned';
        await log(s, 'error', 'system', `Checkout failed: ${clip(message, 120)}`, { stage: 'cart_checkout', message, sku: line.sku, line_id: line.line_id }, { sku: line.sku });
        emit(s.id, 'error', { message: `Checkout failed: ${message}` });
        failed = line;
        break;
      }
      const totals = res.totals || expected;
      const eta = res.delivery_eta || null;
      const items = [{ sku: line.sku, title: line.title, qty: line.qty, unit_price: price }];
      const confirmed = await log(s, 'order_confirmed', 'merchant', `Order ${res.order_id} confirmed (${money(totals.total)})`, {
        order_id: res.order_id, totals, items, executor: res.executor ?? null, delivery_eta: eta, merchant_id: line.merchant_id, sku: line.sku,
        confirmation_text: res.confirmation_text ?? null, approval_mode: approval.mode, scope: 'cart', line_id: line.line_id,
      }, { sku: line.sku, order_id: res.order_id });
      const order = {
        order_id: res.order_id, session_id: s.id, user_id: USER_ID, merchant_id: line.merchant_id, store_name: line.store_name, items, totals, delivery_eta: eta,
        return_policy: null,
        price_change: { first_seen: line.unit_price, at_checkout: price, disclosed_to_user: Math.abs(line.unit_price - price) >= 0.005 },
        policy_decision_event_id: p.polEvent?.event_id ?? null,
        approval: {
          mode: approval.mode, channel: approval.mode === 'user_explicit' ? (approval.channel || 'voice') : null,
          transcript: approval.transcript ?? null, event_id: approval.event_id ?? null,
        },
        executor: res.executor ?? null, demo_data: true, status: 'confirmed', placed_at: new Date().toISOString(),
        audit_head_hash: confirmed?.hash ?? null, cart_line_id: line.line_id,
      };
      await store.orders.insert(order);
      orders.push(order);
    }
    clearLines(s.cart, orders.map((o) => o.cart_line_id));
    const paid = orders.reduce((sum, o) => sum + Number(o.totals?.total || 0), 0);
    const left = cartTotals(s.cart);
    await log(s, 'cart_checkout_done', failed ? 'system' : 'agent', failed
      ? `Cart checkout stopped: ${orders.length} of ${p.lines.length} orders placed`
      : `Cart checked out: ${orders.length} order${orders.length === 1 ? '' : 's'}, ${money(paid)}`, {
      orders: orders.map((o) => ({ order_id: o.order_id, merchant_id: o.merchant_id, total: o.totals?.total ?? null, line_id: o.cart_line_id })),
      total: Math.round(paid * 100) / 100, approval_mode: approval.mode, failed_line_id: failed?.line_id ?? null,
      items_left: left.item_count, currency: 'USD',
    });
    if (orders.length) s.lastOrder = orders[orders.length - 1];
    emit(s.id, 'cart_order', { orders, total: Math.round(paid * 100) / 100, currency: 'USD', approval_mode: approval.mode, failed: failed ? { line_id: failed.line_id, title: failed.title } : null });
    emitCart(s, { change: 'checkout' });
    if (failed) {
      say(s, orders.length
        ? `I placed ${orders.length} order${orders.length === 1 ? '' : 's'}, but the checkout for the ${spokenTitle(failed.title)} didn't go through. It's still in your cart.`
        : "The checkout didn't go through, so nothing was bought. Your cart is unchanged.");
      setState(s, s.options.length ? 'AWAIT_CHOICE' : 'IDLE');
      return undefined;
    }
    const ids = orders.map((o) => `${o.order_id} arrives ${etaPhrase(o.delivery_eta)}`);
    say(s, `Done. ${orders.length === 1 ? 'Order' : 'Orders'} ${joinAnd(ids)}. You paid ${money(paid)} in total.`);
    setState(s, 'DONE', null);
    return undefined;
  }

  // ---------------------------------------------------------------- reorder + checkout
  async function reorder(s, category) {
    // "Buy it again" without a category means the last order of this session, if there is one.
    const lastCat = s.lastOrder ? s.request?.category || null : null;
    resetShopping(s);
    const cats = category ? [category] : [...new Set([lastCat, 'coffee', 'running_shoes'].filter(Boolean))];
    let pref = null;
    for (const c of cats) {
      pref = await prefs.usual(USER_ID, c);
      if (!pref && !category && c === lastCat) pref = (await prefs.forCategory(USER_ID, c)).find((x) => x.key === 'last_purchase') || null;
      if (pref) break;
    }
    if (!pref) {
      say(s, `I don't have a usual ${CATEGORY_LABEL[category] || 'order'} saved yet. What would you like?`);
      setState(s, 'IDLE', null);
      return undefined;
    }
    const v = pref.value || {};
    const merchant = merchants.find((m) => m.id === v.merchant_id);
    if (!merchant) return denyStore(s, { id: v.merchant_id || 'unknown', name: v.merchant_id || 'that store' }, '');
    const base = String(merchant.base).replace(/\/+$/, '');
    const opt = {
      option_id: 'opt_reorder', sku: v.sku, merchant_id: merchant.id, store_name: merchant.name, title: v.title, brand: v.brand ?? null,
      category: pref.category, demo_data: true, url: `${base}/p/${v.sku}`, seller: merchant.name, in_stock: true,
      price: { amount: Number(v.last_price ?? v.price), currency: 'USD', observed_at: pref.last_used_at || pref.learned_at || null, snapshot_id: null },
      delivery: { eta_date: null, shipping_cost: 0 },
    };
    s.request = { category: pref.category, reorder: true };
    s.options = [opt];
    const chip = prefChip(pref);
    s.chips = [chip];
    emit(s.id, 'memory', { chips: s.chips });
    await log(s, 'preference_used', 'agent', `Used saved preference: ${chip.label} (${chip.source})`, {
      pref_id: pref.pref_id, category: pref.category, key: pref.key, value: v, kind: pref.kind, source: pref.source, seeded: Boolean(pref.seeded),
    }, { pref_id: pref.pref_id });
    await openPage(s, opt, 0, 'reorder');
    const first = { price: Number(v.last_price ?? v.price), ts: pref.last_used_at || pref.learned_at || null, snapshot_id: null, source: 'preference' };
    s.firstSeen[opt.sku] = first;
    return verify(s, opt, 0, { reorder: true, first });
  }

  async function checkout(s, p, approval) {
    const { opt } = p;
    setState(s, 'CHECKOUT', p.index);
    await log(s, 'checkout_started', 'agent', `Checking out ${spokenTitle(opt.title)} at ${opt.store_name} (${money(p.totals.total)})`, {
      sku: opt.sku, url: opt.url, qty: 1, merchant_id: opt.merchant_id, total: p.totals.total, approval_mode: approval.mode,
    }, { sku: opt.sku });
    let res = null;
    try {
      res = await callBrowser(s, 'checkout', { url: opt.url, sku: opt.sku, qty: 1 });
    } catch (err) {
      res = { error: err };
    }
    for (const st of (res && res.steps) || []) {
      await log(s, 'checkout_step', 'agent', `Checkout step: ${st.step}${st.ok === false ? ' (failed)' : ''}`, { step: st.step, ok: st.ok !== false, ms: st.ms ?? null, executor: res.executor ?? null }, { sku: opt.sku });
    }
    if (!res || res.error || !res.order_id) {
      const message = res?.error?.message || 'no order id returned';
      await log(s, 'error', 'system', `Checkout failed: ${clip(message, 120)}`, { stage: 'checkout', message, sku: opt.sku }, { sku: opt.sku });
      emit(s.id, 'error', { message: `Checkout failed: ${message}` });
      say(s, "The checkout didn't go through, so nothing was bought.");
      setState(s, s.options.length > 1 ? 'AWAIT_CHOICE' : 'IDLE', p.index);
      return undefined;
    }
    const totals = res.totals || p.totals;
    const eta = res.delivery_eta || p.eta;
    const items = [{ sku: opt.sku, title: opt.title, qty: 1, unit_price: p.price }];
    const confirmed = await log(s, 'order_confirmed', 'merchant', `Order ${res.order_id} confirmed (${money(totals.total)})`, {
      order_id: res.order_id, totals, items, executor: res.executor ?? null, delivery_eta: eta, merchant_id: opt.merchant_id, sku: opt.sku,
      confirmation_text: res.confirmation_text ?? null, approval_mode: approval.mode,
    }, { sku: opt.sku, order_id: res.order_id });
    const order = {
      order_id: res.order_id, session_id: s.id, user_id: USER_ID, merchant_id: opt.merchant_id, items, totals, delivery_eta: eta,
      return_policy: p.returnsShort || p.returnPolicyText || null,
      price_change: { first_seen: p.firstSeen?.price ?? p.price, at_checkout: p.price, disclosed_to_user: Boolean(p.changed) },
      policy_decision_event_id: p.polEvent?.event_id ?? null,
      approval: {
        mode: approval.mode, channel: approval.mode === 'user_explicit' ? (approval.channel || 'voice') : null,
        transcript: approval.transcript ?? null, event_id: approval.event_id ?? null,
      },
      executor: res.executor ?? null, demo_data: true, status: 'confirmed', placed_at: new Date().toISOString(),
      audit_head_hash: confirmed?.hash ?? null,
    };
    await store.orders.insert(order);
    s.lastOrder = order;
    const category = opt.category || s.request?.category || 'any';
    try {
      const saved = await prefs.save({
        pref_id: `pref_last_${category}`, user_id: USER_ID, category, key: 'last_purchase',
        value: { sku: opt.sku, merchant_id: opt.merchant_id, title: opt.title, price: p.price, order_id: res.order_id },
        kind: 'soft_preference', source: 'inferred_from_order', seeded: false,
        learned_at: new Date().toISOString(), last_used_at: new Date().toISOString(),
      });
      await log(s, 'preference_saved', 'agent', `Remembered: last ${CATEGORY_LABEL[category] || category} order was ${spokenTitle(opt.title)}`, {
        pref_id: saved?.pref_id ?? `pref_last_${category}`, category, key: 'last_purchase', value: saved?.value ?? null, source: 'inferred_from_order',
      }, { pref_id: saved?.pref_id ?? null, order_id: res.order_id });
      s.chips = [...s.chips.filter((c) => c.source !== 'learned'), { label: `Last bought: ${spokenTitle(opt.title)}`, source: 'learned' }];
      emit(s.id, 'memory', { chips: s.chips });
    } catch (err) {
      await log(s, 'error', 'system', `Could not save preference: ${clip(err.message, 100)}`, { stage: 'preference_saved', message: err.message });
    }
    emit(s.id, 'order', { order });
    if (p.reorder && approval.mode === 'auto') {
      say(s, `Done: ${spokenTitle(opt.title)}, ${money(p.price)} at ${opt.store_name}, arrives ${etaPhrase(eta)}.`, null, p.index);
      say(s, "That's under your limit, so I bought it without asking.");
    } else {
      say(s, `Done. Order ${res.order_id} arrives ${etaPhrase(eta)}.`, null, p.index);
    }
    setState(s, 'DONE', p.index);
    return undefined;
  }

  async function fail(s, err) {
    const message = err && err.message ? err.message : String(err);
    s.autoAdvance = false;
    await log(s, 'error', 'system', `Error: ${clip(message, 140)}`, { message, state: s.state });
    emit(s.id, 'error', { message });
    say(s, 'Sorry, something went wrong on my side. Please try that again.');
    if (['SEARCH', 'VERIFY', 'POLICY', 'CHECKOUT', 'NARRATE'].includes(s.state)) setState(s, s.options.length ? 'AWAIT_CHOICE' : 'IDLE');
  }

  function cart(session_id) {
    return cartView(getSession(session_id).cart);
  }

  return { handle, bargeIn, speaking, speechDone, reset, session, cart, cartUpdate };
}
