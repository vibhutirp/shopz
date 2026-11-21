// Shopz control panel – static, no build step, no dependencies.
// Talks to the agent on the same origin: SSE from /api/events, JSON POSTs (docs/CONTRACTS.md §3).
(() => {
  'use strict';

  /* ------------------------------------------------------------------ helpers */
  const $ = (id) => document.getElementById(id);

  /** h('div', {class, text, html, onclick, ...attrs}, ...children) – strings become text nodes (never HTML). */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v; // only used with constants / pre-escaped markup
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false || kid === '') continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  /** Like el.replaceChildren(), but skips null/false/'' (the DOM method would print them as text). */
  function fill(el, ...kids) {
    el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false && k !== ''));
    return el;
  }

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
  const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
  function amount(v) {
    if (v && typeof v === 'object') v = v.amount;
    const n = typeof v === 'string' ? Number(v) : v;
    return isNum(n) ? n : null;
  }
  function money(v, currency, smart) {
    const n = amount(v);
    if (n === null) return '—';
    const whole = smart && Math.abs(n - Math.round(n)) < 0.005;
    const digits = whole ? 0 : 2;
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency', currency: currency || 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits,
      }).format(n);
    } catch {
      return n.toFixed(digits) + ' ' + (currency || '');
    }
  }
  const fmtInt = (n) => (isNum(Number(n)) ? Number(n).toLocaleString('en-US') : String(n));
  const pad2 = (n) => String(n).padStart(2, '0');
  function hms(ts) {
    const d = ts ? new Date(ts) : null;
    if (!d || Number.isNaN(d.getTime())) return '--:--:--';
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function localDate(iso) {
    const m = typeof iso === 'string' && iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12) : null;
  }
  const weekday = (iso) => { const d = localDate(iso); return d ? WD[d.getDay()] : ''; };
  const niceDate = (iso) => { const d = localDate(iso); return d ? `${WD[d.getDay()]}, ${MO[d.getMonth()]} ${d.getDate()}` : (iso || '—'); };
  const short = (hash) => (hash ? String(hash).slice(0, 10) + '…' : '—');
  const STORE_NAMES = { runhub: 'RunHub', dailycart: 'DailyCart' }; // the two fictional demo stores
  const storeName = (id) => (id ? STORE_NAMES[String(id).toLowerCase()] || String(id) : null);
  const first = (...vals) => { for (const v of vals) if (v !== undefined && v !== null && v !== '') return v; return null; };

  /** Depth-limited search for a key anywhere inside event data (e.g. data.answer.quoted_span). */
  function findKey(obj, key, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 4) return null;
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const v = obj[key];
      if (v !== null && v !== undefined && v !== '' && typeof v !== 'object') return v;
    }
    for (const v of Object.values(obj)) {
      const r = findKey(v, key, depth + 1);
      if (r !== null) return r;
    }
    return null;
  }

  /** Pretty JSON with light syntax colouring; tokens are escaped individually. */
  function highlightJson(value) {
    let src;
    try { src = JSON.stringify(value, null, 2); } catch { src = String(value); }
    if (src === undefined) src = 'null';
    const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(src))) {
      out += esc(src.slice(last, m.index));
      if (m[1]) out += m[2] ? `<span class="jk">${esc(m[1])}</span>${esc(m[2])}` : `<span class="js">${esc(m[1])}</span>`;
      else if (m[3]) out += `<span class="jl">${m[3]}</span>`;
      else out += `<span class="jn">${m[4]}</span>`;
      last = re.lastIndex;
    }
    return out + esc(src.slice(last));
  }

  /* ------------------------------------------------------------------ session */
  // Random per page load (a reload = a fresh take), kept in sessionStorage for inspection/debugging.
  function newId() {
    if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 15) | 64;
    b[8] = (b[8] & 63) | 128;
    const x = Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
  }
  const SESSION = newId();
  try { sessionStorage.setItem('shopz.session_id', SESSION); } catch { /* storage may be disabled */ }
  // Demo (fictional stores, pitch script) or Live web (real stores, hand-off to the store's checkout). ?mode=live|demo wins, then the last choice.
  const MODE_PARAM = (new URLSearchParams(location.search).get('mode') || '').toLowerCase();
  let MODE = ['live', 'demo'].includes(MODE_PARAM) ? MODE_PARAM : (() => { try { return localStorage.getItem('shopz.mode') || ''; } catch { return ''; } })();
  const LIVE_NOTICE = 'Live web results · prices from the store pages · checkout happens in the store';
  const isLive = () => MODE === 'live';

  /* ------------------------------------------------------------------ toasts + HTTP */
  const toastSeen = new Map();
  function toast(msg, kind = 'error', ms) {
    const now = Date.now();
    const key = kind + ':' + msg;
    if (toastSeen.get(key) > now - 5000) return;
    toastSeen.set(key, now);
    const box = $('toasts');
    const t = h('div', { class: 'toast ' + kind }, msg);
    box.append(t);
    while (box.children.length > 3) box.firstElementChild.remove();
    requestAnimationFrame(() => t.classList.add('in'));
    setTimeout(() => {
      t.classList.remove('in');
      setTimeout(() => t.remove(), 250);
    }, ms || (kind === 'error' ? 4500 : 2000));
  }

  async function post(path, body, { quiet = false } = {}) {
    try {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
      return data || {};
    } catch (err) {
      const what = path.replace('/api/', '');
      const why = err instanceof TypeError ? 'agent not reachable' : (err && err.message) || 'request failed';
      if (!quiet) toast(`${what}: ${why}`, 'error');
      return null;
    }
  }

  // speaking / speech-done must reach the agent in order.
  let postChain = Promise.resolve();
  function postInOrder(path, body) {
    postChain = postChain.then(() => post(path, body));
    return postChain;
  }

  /* ------------------------------------------------------------------ icons */
  const ICON_PATHS = {
    dot: '<circle cx="8" cy="8" r="2.6" fill="currentColor" stroke="none"/>',
    mic: '<rect x="5.5" y="1.75" width="5" height="8" rx="2.5"/><path d="M3.25 7.5a4.75 4.75 0 0 0 9.5 0M8 12.25v2"/>',
    chat: '<path d="M2.25 3.25h11.5v7.5H7.25l-3.5 2.75v-2.75h-1.5z"/>',
    mark: '<path d="M4.25 1.75h7.5v12.5L8 11.25l-3.75 3z"/>',
    search: '<circle cx="7" cy="7" r="4.25"/><path d="M10.25 10.25l3.5 3.5"/>',
    filter: '<path d="M2 3h12l-4.5 5.25v4.25l-3 1.5V8.25z"/>',
    list: '<path d="M6 4h7.5M6 8h7.5M6 12h7.5M2.75 4h.01M2.75 8h.01M2.75 12h.01"/>',
    page: '<path d="M4 1.75h5.25l3 3v9.5H4z"/><path d="M9 1.75V5h3.25M6 8.5h4M6 11h4"/>',
    reload: '<path d="M13.25 8a5.25 5.25 0 1 1-1.55-3.7"/><path d="M13.25 1.75v3h-3"/>',
    eye: '<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
    alert: '<path d="M8 1.75l6.5 12H1.5z"/><path d="M8 6.25v3.5M8 11.75v.01"/>',
    check: '<path d="M3 8.5l3.25 3.25L13 4.75"/>',
    x: '<path d="M4 4l8 8M12 4l-8 8"/>',
    tag: '<path d="M1.75 8.25V1.75h6.5l6 6-6.5 6.5z"/><circle cx="4.75" cy="4.75" r="1"/>',
    box: '<path d="M2 4.75L8 1.75l6 3v6.5l-6 3-6-3z"/><path d="M2 4.75l6 3 6-3M8 7.75v6.5"/>',
    shield: '<path d="M8 1.5l5.25 2v4.25c0 3.25-2.25 5.75-5.25 6.75-3-1-5.25-3.5-5.25-6.75V3.5z"/>',
    cart: '<path d="M1.5 2h2l1.75 8h7.25l1.5-5.5H4.1"/><circle cx="6.25" cy="13" r="1"/><circle cx="12" cy="13" r="1"/>',
    chev: '<path d="M6 3.5L10.5 8 6 12.5"/>',
    out: '<path d="M9 2.25h4.75V7M13.5 2.5L7.5 8.5M11.75 9.5v4.25h-9.5v-9.5H6.5"/>',
    speaker: '<path d="M2.5 6h2.5l3.5-3v10l-3.5-3H2.5z"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.75 3.5a6 6 0 0 1 0 9"/>',
    speakerOff: '<path d="M2.5 6h2.5l3.5-3v10l-3.5-3H2.5z"/><path d="M11 6l3.5 4M14.5 6L11 10"/>',
  };
  const icon = (name) =>
    `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ICON_PATHS.dot}</svg>`;
  const TYPE_ICON = {
    session_started: 'dot', utterance: 'mic', user_interrupt: 'mic', barge_in: 'mic', clarify_question: 'chat',
    preference_used: 'mark', preference_saved: 'mark', search_issued: 'search', search_result: 'search',
    product_filtered: 'filter', ranking: 'list', options_presented: 'list', page_opened: 'page', page_navigate: 'page',
    page_reload: 'reload', page_read: 'eye', answer_given: 'chat', answer_not_on_page: 'chat', injection_ignored: 'alert',
    option_selected: 'check', price_observed: 'tag', stock_checked: 'box', policy_decision: 'shield',
    approval_requested: 'shield', approval_granted: 'check', approval_denied: 'x', checkout_started: 'cart',
    checkout_step: 'cart', order_confirmed: 'box', error: 'alert', fallback_used: 'reload', handoff: 'out', web_search: 'search',
    cart_item_added: 'cart', cart_item_removed: 'x', cart_quantity_changed: 'cart', cart_checkout_started: 'cart', cart_checkout_done: 'box',
  };
  function toneOf(ev) {
    const t = ev.type;
    if (t === 'policy_decision') {
      const d = String(findKey(ev.data, 'decision') || '').toUpperCase();
      return d === 'AUTO_APPROVE' ? 'good' : d === 'DENY' ? 'bad' : 'warn';
    }
    if (t === 'approval_granted' || t === 'order_confirmed' || t === 'cart_checkout_done') return 'good';
    if (t === 'error' || t === 'injection_ignored' || t === 'approval_denied') return 'bad';
    if (['approval_requested', 'price_observed', 'answer_not_on_page', 'fallback_used'].includes(t)) return 'warn';
    if (ev.actor === 'user' || ['utterance', 'user_interrupt', 'barge_in'].includes(t)) return 'user';
    return 'neutral';
  }

  /* ------------------------------------------------------------------ thread (chat) */
  const thread = $('thread');
  const scroller = $('scroller');
  let agentTurn = null; // the agent message that collects activity, spoken text and cards
  let interimTurn = null;
  const pendingUser = []; // turns we sent ourselves, matched against the agent's user.utterance echo
  let stick = true; // follow new content unless the reader scrolled up

  scroller.addEventListener('scroll', () => {
    stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
  }, { passive: true });
  function scrollTurns(force) {
    if (force) stick = true;
    if (!stick) return;
    requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
  }
  // Images and cards grow after they are placed: keep following the bottom while the reader has not scrolled up.
  if (window.ResizeObserver) new ResizeObserver(() => { if (stick) scroller.scrollTop = scroller.scrollHeight; }).observe(thread);
  function hideWelcome() { const w = $('welcome'); if (w) w.remove(); }
  /** Settled messages go above a live "listening" bubble, so that bubble stays at the bottom. */
  function placeInThread(el) { thread.insertBefore(el, interimTurn && interimTurn.el !== el ? interimTurn.el : null); }

  function addUserTurn(text, interim = false) {
    hideWelcome();
    const body = h('div', { class: 'bubble' }, text || '');
    const el = h('div', { class: 'msg msg-user' + (interim ? ' interim' : '') }, body);
    if (interim) thread.append(el); else placeInThread(el);
    scrollTurns(true);
    return { el, body };
  }

  function newAgentTurn() {
    hideWelcome();
    if (agentTurn) settleTurn(agentTurn, true);
    const actNow = h('span', { class: 'act-now' }, 'Thinking…');
    const actCount = h('span', { class: 'act-count' });
    const head = h('button', { class: 'act-head', type: 'button', 'aria-expanded': 'false', title: 'Show every step' },
      h('span', { class: 'act-ico' }), actNow, actCount, h('span', { class: 'act-chev', html: icon('chev') }));
    const list = h('ol', { class: 'act-list' });
    const act = h('div', { class: 'act busy' }, head, list);
    const say = h('div', { class: 'say' });
    const attach = h('div', { class: 'attach' });
    const el = h('div', { class: 'msg msg-agent' },
      h('span', { class: 'avatar', 'aria-hidden': 'true' }),
      h('div', { class: 'msg-body' }, act, say, attach));
    const t = {
      el, act, head, actNow, actCount, list, say, attach,
      steps: 0, busy: true, lastNow: '', startedAt: Date.now(), view: null, hasCards: false,
      stores: new Set(), pages: new Set(), opened: new Set(), prefs: 0, filtered: 0, policy: false, order: false,
    };
    head.addEventListener('click', () => {
      const open = !act.classList.contains('open');
      act.classList.toggle('open', open);
      head.setAttribute('aria-expanded', String(open));
    });
    placeInThread(el);
    agentTurn = t;
    lastEventAt = Date.now();
    armSettle();
    renderQuick();
    scrollTurns();
    return t;
  }
  const ensureAgentTurn = () => (agentTurn && agentTurn.el.isConnected ? agentTurn : newAgentTurn());

  function agentSentence(text) {
    const t = ensureAgentTurn();
    t.say.querySelectorAll('.sent.live').forEach((s) => s.classList.remove('live'));
    if (t.say.childNodes.length) t.say.append(' ');
    t.say.append(h('span', { class: 'sent live' }, text));
    scrollTurns();
  }
  function endLiveSentence() { thread.querySelectorAll('.sent.live').forEach((s) => s.classList.remove('live')); }

  function showInterim(text) {
    if (!interimTurn) interimTurn = addUserTurn('', true);
    interimTurn.body.replaceChildren();
    if (text) interimTurn.body.textContent = text;
    else interimTurn.body.append(h('span', { class: 'dots', 'aria-label': 'listening' }, h('i'), h('i'), h('i')));
    scrollTurns(true);
  }
  function settleInterim(text) {
    const t = interimTurn;
    interimTurn = null;
    if (!t) return null;
    if (!text) { t.el.remove(); return null; }
    t.el.className = 'msg msg-user';
    t.body.textContent = text;
    thread.append(t.el);
    scrollTurns(true);
    return t;
  }
  function onUserUtterance(d) {
    const text = d && d.text ? String(d.text) : '';
    if (!text) return;
    const now = Date.now();
    while (pendingUser.length && now - pendingUser[0].at > 20000) pendingUser.shift();
    const mine = pendingUser.shift();
    if (mine && mine.turn.el.isConnected) { mine.turn.body.textContent = text; return; }
    addUserTurn(text);
    newAgentTurn();
  }

  /* ------------------------------------------------------------------ activity line ("Searching… / Reading…") */
  const SKIP_STEP = new Set(['session_started', 'utterance', 'user_interrupt', 'barge_in', 'clarify_question']);
  const SNAP_TAIL = /\s*\(snap_[^)]*\)\s*$/;
  const REST_STATES = new Set(['IDLE', 'CLARIFY', 'AWAIT_CHOICE', 'APPROVE', 'DONE']);
  let lastEventAt = 0;
  let settleTimer = null;

  function stepOf(ev) {
    const d = ev.data || {};
    let done = String(ev.summary || ev.type || '').replace(SNAP_TAIL, '');
    let now = done;
    let quote = null;
    switch (ev.type) {
      case 'preference_used':
        done = 'Used your saved preference: ' + done.replace(/^Used saved preference:\s*/, '').replace(/\s*\((?:seeded profile|learned)\)\s*$/, '');
        now = 'Checking your saved preferences';
        break;
      case 'preference_saved': now = 'Remembering this for next time'; break;
      case 'search_issued': now = done.replace(/^Searched /, 'Searching '); break;
      case 'search_result':
        if (isNum(d.seen)) done = `Found ${d.seen} product${d.seen === 1 ? '' : 's'}` + (isNum(d.matched) && d.matched !== d.seen ? `, ${d.matched} match` : '');
        now = 'Comparing results';
        break;
      case 'product_filtered': now = done.replace(/^Filtered out /, 'Filtering out '); break;
      case 'ranking': now = 'Ranking the best matches'; break;
      case 'options_presented': now = 'Preparing your options'; break;
      case 'page_opened': now = done.replace(/^Opened /, 'Opening ').replace(/^Went back to /, 'Going back to '); break;
      case 'page_navigate': now = done.replace(/^Scrolled to /, 'Scrolling to '); break;
      case 'page_read': now = done.replace(/^Read /, 'Reading '); break;
      case 'page_reload': now = 'Re-checking price and stock'; break;
      case 'price_observed': now = d.title ? `Checking the price of ${d.title}` : 'Checking the price'; break;
      case 'stock_checked': now = 'Checking stock'; break;
      case 'answer_given': done = 'Found the answer on the page'; now = 'Looking for the answer on the page'; quote = findKey(d, 'quoted_span'); break;
      case 'answer_not_on_page': done = 'Not on the page – Shopz does not guess'; now = 'Looking for the answer on the page'; break;
      case 'injection_ignored': done = 'Ignored an instruction hidden in the page'; quote = first(d.quote); break;
      case 'option_selected': now = 'Selecting your pick'; break;
      case 'policy_decision': {
        const dec = String(d.decision || '').toUpperCase();
        done = dec === 'AUTO_APPROVE' ? 'Purchase rules: within your limits' : dec === 'DENY' ? 'Purchase rules: not allowed' : 'Purchase rules: needs your OK';
        now = 'Checking your purchase rules';
        break;
      }
      case 'approval_requested': done = 'Asked for your confirmation'; now = 'Waiting for your confirmation'; break;
      case 'approval_granted': done = 'You confirmed the purchase'; break;
      case 'approval_denied': done = 'Purchase not confirmed'; break;
      case 'checkout_started': now = 'Checking out'; break;
      case 'checkout_step': done = 'Checkout: ' + String(d.step || '').replace(/_/g, ' '); now = 'Checking out'; break;
      case 'order_confirmed': now = 'Placing the order'; break;
      case 'handoff': done = 'Ready to buy – handed off to the store (Shopz does not pay)'; now = 'Getting it ready in the store'; break;
      case 'web_search': now = 'Searching the web'; break;
      case 'cart_item_added': done = done.replace(/ at \$[\d.,]+ to the cart$/, ' to the cart'); now = 'Adding it to your cart'; break;
      case 'cart_item_removed': now = 'Updating your cart'; break;
      case 'cart_quantity_changed': now = 'Updating your cart'; break;
      case 'cart_checkout_started': done = 'Checking out your cart'; now = 'Re-checking every item in your cart'; break;
      case 'cart_checkout_done': now = 'Placing the orders'; break;
      case 'fallback_used': now = 'Trying another way'; break;
      default: break;
    }
    return { done, now, quote };
  }

  function turnHeadline(t) {
    const parts = [];
    const pl = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    if (t.prefs && !t.stores.size) parts.push('used ' + pl(t.prefs, 'saved preference'));
    if (t.stores.size) parts.push('searched ' + pl(t.stores.size, 'store'));
    if (t.filtered) parts.push('filtered out ' + t.filtered);
    if (t.pages.size) parts.push('read ' + pl(t.pages.size, 'product page'));
    else if (t.opened.size) parts.push('opened ' + pl(t.opened.size, 'product page'));
    if (t.policy) parts.push('checked your purchase rules');
    if (t.cartAdd && !t.order && !t.orders) parts.push('added it to your cart');
    if (t.orders) parts.push(`placed ${t.orders} order${t.orders === 1 ? '' : 's'}`);
    else if (t.order) parts.push('placed the order');
    if (t.handoff) parts.push('handed off to the store');
    const s = parts.slice(0, 3).join(', ') || 'Worked it out';
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function renderActHead(t) {
    t.act.classList.toggle('busy', t.busy);
    t.act.classList.toggle('done', !t.busy);
    t.head.querySelector('.act-ico').innerHTML = t.busy ? '' : icon('check');
    t.actNow.textContent = t.busy ? (t.lastNow || 'Thinking') + '…' : turnHeadline(t);
    t.actCount.textContent = t.steps ? `· ${t.steps} step${t.steps === 1 ? '' : 's'}` : '';
    t.act.hidden = !t.busy && !t.steps;
  }
  function settleTurn(t, force) {
    if (!t || !t.busy) return;
    t.busy = false;
    t.list.querySelectorAll('li.now').forEach((li) => { li.classList.remove('now'); li.classList.add('done'); });
    renderActHead(t);
    if (!force) renderQuick();
  }
  function armSettle() { clearTimeout(settleTimer); settleTimer = setTimeout(trySettle, 700); }
  function trySettle() {
    const t = agentTurn;
    if (!t || !t.busy) return;
    const quiet = Date.now() - lastEventAt;
    const minBusy = Date.now() - t.startedAt < 1200;
    if (!REST_STATES.has(curState) || quiet < 650 || minBusy) {
      if (Date.now() - t.startedAt < 90000) armSettle(); else settleTurn(t);
      return;
    }
    settleTurn(t);
  }

  function addStep(ev) {
    if (!ev || SKIP_STEP.has(ev.type) || ev.actor === 'user') return;
    const t = ensureAgentTurn();
    const s = stepOf(ev);
    const d = ev.data || {};
    if (ev.type === 'preference_used') t.prefs++;
    if (ev.type === 'search_issued') t.stores.add(first(d.store_name, d.store, ev.summary));
    if (ev.type === 'product_filtered') t.filtered++;
    if (ev.type === 'page_read' && d.sku) t.pages.add(d.sku);
    if (ev.type === 'page_opened' && d.sku) t.opened.add(d.sku);
    if (ev.type === 'policy_decision') t.policy = true;
    if (ev.type === 'order_confirmed') t.order = true;
    if (ev.type === 'handoff') t.handoff = true;
    if (ev.type === 'cart_item_added') t.cartAdd = (t.cartAdd || 0) + 1;
    if (ev.type === 'cart_checkout_done') t.orders = ((ev.data && ev.data.orders) || []).length;
    t.list.querySelectorAll('li.now').forEach((li) => { li.classList.remove('now'); li.classList.add('done'); });
    const tone = toneOf(ev);
    t.list.append(h('li', { class: (['warn', 'bad', 'good'].includes(tone) ? tone + ' ' : '') + 'now' },
      h('span', { class: 'li-ico', html: icon(TYPE_ICON[ev.type] || 'dot') }),
      h('span', null, s.done, s.quote ? h('span', { class: 'li-quote' }, `“${s.quote}”`) : null)));
    t.steps++;
    t.lastNow = s.now;
    t.busy = true;
    lastEventAt = Date.now();
    renderActHead(t);
    pageEvent(t, ev);
    renderQuick();
    armSettle();
    scrollTurns();
  }

  /* ------------------------------------------------------------------ "now viewing" page card */
  const SECTION_LABEL = { price: 'Price', delivery: 'Delivery', reviews: 'Reviews', returns: 'Returns', specs: 'Specs', gallery: 'Photos', seller: 'Seller', description: 'Description', overview: 'Overview' };
  const PAGE_TYPES = new Set(['page_opened', 'page_navigate', 'page_read', 'page_reload', 'answer_given', 'answer_not_on_page', 'injection_ignored', 'stock_checked', 'price_observed']);
  const artUrl = (sku, view) => '/api/art/' + encodeURIComponent(sku) + (view ? '?view=' + encodeURIComponent(view) : '');
  function optionBySku(sku) { return options.find((o) => o && o.sku === sku) || null; }

  function pageEvent(t, ev) {
    if (!PAGE_TYPES.has(ev.type)) return;
    const d = ev.data || {};
    const sku = first(d.sku);
    if (!sku || t.hasCards) return; // option cards already show which page is open
    if (!t.view || t.view.sku !== sku) {
      const o = optionBySku(sku);
      t.view = {
        sku,
        title: first(d.title, d.page_title, o && o.title, sku),
        store: first(storeName(d.merchant_id), o && (o.store_name || storeName(o.merchant_id))),
        secs: new Map(), now: null, quote: null, note: null, el: h('div', { class: 'icard pview' }),
      };
      t.attach.prepend(t.view.el);
    }
    const v = t.view;
    if (d.title && v.title === sku) v.title = d.title;
    if (!v.store && d.merchant_id) v.store = storeName(d.merchant_id);
    const sec = first(d.section);
    if (ev.type === 'page_navigate' && sec) v.now = sec;
    if (ev.type === 'page_read' && sec && sec !== 'all') { v.secs.set(sec, true); v.now = sec; }
    if (ev.type === 'page_reload') { v.secs.clear(); v.now = null; }
    if (ev.type === 'answer_given') { const q = findKey(d, 'quoted_span'); if (q) v.quote = String(q); }
    if (ev.type === 'answer_not_on_page') v.note = `The page does not mention ${first(d.topic, 'that')} – Shopz will not guess.`;
    if (ev.type === 'injection_ignored') v.note = 'Ignored an instruction hidden in a review – only you can tell Shopz what to do.';
    renderView(v);
  }
  function renderView(v) {
    fill(v.el,
      h('div', { class: 'pview-img' }, h('img', (() => { const o = optionBySku(v.sku); return o && o.image_url ? { class: 'photo', src: o.image_url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' } : { src: artUrl(v.sku), alt: '', loading: 'lazy' }; })())),
      h('div', { class: 'pview-main' },
        h('div', { class: 'pview-url', html: icon('page') + ' ' + esc((v.store || 'Store') + ' › product page') }),
        h('div', { class: 'pview-title' }, v.title),
        v.secs.size || v.now ? h('div', { class: 'pview-secs' },
          Array.from(new Set([...v.secs.keys(), ...(v.now ? [v.now] : [])])).map((s) =>
            h('span', { class: 'sec' + (v.secs.has(s) ? ' read' : '') + (s === v.now ? ' now' : '') }, SECTION_LABEL[s] || s))) : null,
        v.quote ? h('blockquote', { class: 'pview-quote' }, `“${v.quote}”`) : null,
        v.note ? h('div', { class: 'pview-note', html: icon('alert') + esc(v.note) }) : null));
  }

  /* ------------------------------------------------------------------ mic pill */
  function setMicPill() {
    let st = 'idle';
    let label = 'Idle';
    if (ptt.active) { st = 'listening'; label = 'Listening…'; }
    else if (speech.current || speech.queue.length) { st = 'speaking'; label = 'Speaking'; }
    $('micPill').className = 'pill pill-' + st;
    $('micPillText').textContent = label;
    $('micBtn').classList.toggle('on', ptt.active);
  }

  /* ------------------------------------------------------------------ voice out */
  const speech = { queue: [], current: null, muted: false, gen: 0, running: false, blockedNoted: false, noVoiceNoted: false };

  function estimateMs(text) {
    const words = String(text).trim().split(/\s+/).filter(Boolean).length;
    return Math.min(14000, Math.max(1200, words * 340 + 400));
  }
  function fetchTts(it) {
    if (it.audioP) return it.audioP;
    it.ctrl = new AbortController();
    it.audioP = fetch('/api/tts?text=' + encodeURIComponent(it.text), { signal: it.ctrl.signal })
      .then(async (r) => {
        const type = r.headers.get('content-type') || '';
        if (!r.ok || !/audio|octet-stream/i.test(type)) return null; // 503 → browser voice
        const blob = await r.blob();
        return blob.size ? URL.createObjectURL(blob) : null;
      })
      .catch(() => null);
    return it.audioP;
  }
  function prefetch() {
    if (speech.muted) return;
    speech.queue.slice(0, 2).forEach(fetchTts); // two ahead keeps a single-voice server from queueing up
  }
  function dropItem(it) {
    try { if (it.ctrl) it.ctrl.abort(); } catch { /* ignore */ }
    if (it.audioP) it.audioP.then((u) => { if (u) URL.revokeObjectURL(u); });
  }

  function enqueueSay(d) {
    if (!d || !d.text) return;
    const listening = ptt.active || Boolean(ptt.press && !ptt.press.settled);
    // After a barge-in, sentences the agent queued before it heard the user are stale: drop them.
    if (listening && ptt.bargedIn) return;
    speech.queue.push({
      say_id: d.say_id,
      text: String(d.text),
      section: first(d.section),
      option_index: Number.isInteger(d.option_index) ? d.option_index : null,
    });
    prefetch();
    setMicPill();
    runQueue(); // holds playback while push-to-talk is down
  }

  /** Called when a sentence really starts playing (or pacing, when muted / no voice). */
  function sentenceStarted(it) {
    postInOrder('/api/speaking', { session_id: SESSION, say_id: it.say_id });
    agentSentence(it.text);
    if (it.option_index !== null) setNarrated(it.option_index);
  }

  async function runQueue() {
    if (speech.running) return;
    speech.running = true;
    const gen = speech.gen;
    let last = null;
    try {
      while (speech.queue.length && gen === speech.gen && !ptt.active) {
        const it = speech.queue.shift();
        speech.current = it;
        prefetch();
        setMicPill();
        await playItem(it, gen);
        if (gen === speech.gen && it.begun) last = it;
        if (speech.current === it) speech.current = null;
      }
    } catch (err) {
      console.error(err);
    } finally {
      speech.running = false;
      if (gen === speech.gen) speech.current = null;
      endLiveSentence();
      setMicPill();
    }
    if (gen === speech.gen && last && !speech.queue.length && !ptt.active) {
      postInOrder('/api/speech-done', { session_id: SESSION, say_id: last.say_id });
    }
    if (speech.queue.length && !ptt.active) runQueue();
  }

  function playItem(it, gen) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(it.watch);
        if (it.audio) { try { it.audio.pause(); } catch { /* ignore */ } }
        if (it.url) URL.revokeObjectURL(it.url);
        it.stop = null;
        resolve();
      };
      it.stop = finish;
      const pace = (ms) => { clearTimeout(it.watch); it.watch = setTimeout(finish, ms); };
      const begin = () => { if (!it.begun && !done) { it.begun = true; sentenceStarted(it); } };
      if (gen !== speech.gen) return finish();
      if (speech.muted) { begin(); return pace(estimateMs(it.text)); } // muted: keep the rhythm so highlights stay in sync

      fetchTts(it).then((url) => {
        if (done) { if (url) URL.revokeObjectURL(url); return; }
        if (!url) return speakWithBrowser(it, begin, finish, pace);
        it.url = url;
        const a = new Audio(url);
        it.audio = a;
        a.onended = finish;
        a.onerror = () => { if (!done) speakWithBrowser(it, begin, finish, pace); };
        a.onloadedmetadata = () => { if (Number.isFinite(a.duration)) pace(a.duration * 1000 + 2500); };
        pace(estimateMs(it.text) * 2 + 4000); // watchdog until metadata is known
        begin();
        a.muted = speech.muted;
        a.play().catch((err) => {
          if (done) return;
          if (err && err.name === 'NotAllowedError' && !speech.blockedNoted) {
            speech.blockedNoted = true;
            toast('Audio is blocked until you click or press a key in this window', 'error');
          }
          speakWithBrowser(it, begin, finish, pace);
        });
      });
    });
  }

  let cachedVoice;
  function pickVoice() {
    if (cachedVoice !== undefined) return cachedVoice;
    const vs = (window.speechSynthesis && speechSynthesis.getVoices()) || [];
    if (!vs.length) return null; // voices load async – try again next sentence
    // Male voice first (server voice is male too): macOS/iOS, Windows, Chrome names.
    const male = /\b(male|daniel|alex|aaron|fred|tom|evan|nathan|reed|rocko|ralph|guy|david|mark|christopher|eric|roger|andrew|brian|ryan|james|arthur|oliver|gordon)\b/i;
    const en = vs.filter((v) => /^en[-_]/i.test(v.lang) && !/female/i.test(v.name));
    cachedVoice = en.find((v) => /^en[-_]US$/i.test(v.lang) && male.test(v.name)) || en.find((v) => male.test(v.name))
      || vs.find((v) => /^en[-_]US$/i.test(v.lang) && v.default) || vs.find((v) => /^en[-_]US$/i.test(v.lang)) || null;
    return cachedVoice;
  }
  function speakWithBrowser(it, begin, finish, pace) {
    const ss = window.speechSynthesis;
    if (it.audio) { try { it.audio.pause(); } catch { /* ignore */ } it.audio = null; }
    begin();
    if (!ss || typeof SpeechSynthesisUtterance === 'undefined' || speech.muted) return pace(estimateMs(it.text));
    let started = false;
    const u = new SpeechSynthesisUtterance(it.text);
    u.lang = 'en-US';
    u.rate = 1.03;
    const v = pickVoice();
    if (v) u.voice = v;
    u.onstart = () => { started = true; pace(estimateMs(it.text) * 2 + 4000); };
    u.onend = finish;
    u.onerror = () => { if (started) finish(); else pace(estimateMs(it.text)); };
    it.utter = u;
    try { ss.speak(u); } catch { return pace(estimateMs(it.text)); }
    // Without a voice engine (some Linux builds) onstart never fires: keep the text at speaking pace instead.
    clearTimeout(it.watch);
    it.watch = setTimeout(() => {
      if (started) return;
      try { ss.cancel(); } catch { /* ignore */ }
      if (!speech.noVoiceNoted) { speech.noVoiceNoted = true; toast('No voice output available – showing text only', 'error'); }
      pace(Math.max(0, estimateMs(it.text) - 1500));
    }, 1500);
  }

  /** Barge-in / speech.cancel: stop now and drop everything queued. */
  function stopSpeech() {
    speech.gen++;
    speech.queue.forEach(dropItem);
    speech.queue = [];
    const it = speech.current;
    speech.current = null;
    if (it) {
      try { if (it.audio) it.audio.pause(); } catch { /* ignore */ }
      if (it.stop) it.stop();
    }
    try { if (window.speechSynthesis) speechSynthesis.cancel(); } catch { /* ignore */ }
    endLiveSentence();
    setMicPill();
  }
  const isSpeaking = () => Boolean(speech.current || speech.queue.length);

  function toggleMute() {
    speech.muted = !speech.muted;
    renderMute();
    const it = speech.current;
    if (it && it.audio) it.audio.muted = speech.muted;
    if (speech.muted && it && it.utter && window.speechSynthesis && speechSynthesis.speaking) {
      try { speechSynthesis.cancel(); } catch { /* ignore */ } // browser voice cannot be muted mid-sentence
    }
    if (!speech.muted) prefetch();
  }

  /* ------------------------------------------------------------------ voice in (push-to-talk) */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  const ptt = { active: false, src: null, press: null, bargedIn: false };

  const UA = navigator.userAgent;
  let serverStt = !SR || (/Safari/.test(UA) && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox/.test(UA));
  let micStream = null;
  async function recorderStart(press) {
    try {
      if (!micStream || !micStream.active) micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      press.fatal = true;
      toast('Microphone blocked – allow it for this page or type below', 'error');
      return settlePress(press);
    }
    if (press.settled) return;
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
    let mr;
    try { mr = new MediaRecorder(micStream, mime ? { mimeType: mime } : undefined); } catch { toast('Recording is not available – type below', 'error'); return settlePress(press); }
    const chunks = [];
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.onstop = async () => {
      const type = mr.mimeType || mime || 'audio/webm';
      const blob = new Blob(chunks, { type });
      if (blob.size < 2000 || press.settled) return settlePress(press);
      showInterim('Transcribing…');
      clearTimeout(press.timer);
      press.timer = setTimeout(() => settlePress(press), 30000);
      try {
        const r = await fetch('/api/stt', { method: 'POST', headers: { 'Content-Type': type }, body: blob });
        const j = await r.json();
        press.final = String(j.text || '');
        if (!r.ok) toast('Speech recognition failed – type below', 'error');
      } catch { toast('Speech recognition failed – type below', 'error'); }
      settlePress(press);
    };
    press.mr = mr;
    mr.start();
    if (!ptt.active || ptt.press !== press) { try { mr.stop(); } catch { /* ignore */ } }
  }

  function micErrorText(code) {
    if (code === 'not-allowed' || code === 'service-not-allowed') return 'Microphone blocked – allow it for this page or type below';
    if (code === 'audio-capture') return 'No microphone found – type below';
    if (code === 'network') return 'Speech recognition needs a network connection – type below';
    return 'Speech recognition error: ' + code;
  }

  function startRecognizer(press) {
    let rec;
    try {
      rec = new SR();
      rec.lang = 'en-US';
      rec.interimResults = true;
      rec.continuous = true;
      rec.maxAlternatives = 1;
    } catch {
      toast('Speech recognition could not start – type below', 'error');
      return;
    }
    let fin = '';
    let inter = '';
    rec.onresult = (e) => {
      fin = '';
      inter = '';
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) fin += r[0].transcript;
        else inter += r[0].transcript;
      }
      press.final = fin;
      press.interim = inter;
      if (!press.settled) showInterim(press.text());
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      press.fatal = true;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'network') {
        serverStt = true;
        toast('Switched to server speech recognition – hold the mic again', 'error');
        return;
      }
      toast(micErrorText(e.error), 'error');
    };
    rec.onend = () => {
      if (press.settled || press.rec !== rec) return;
      if (ptt.press === press && ptt.active && !press.fatal && press.restarts < 3) {
        // Chrome ends long or silent sessions on its own – keep listening while the key is held.
        press.carry = press.text();
        press.final = '';
        press.interim = '';
        press.restarts++;
        startRecognizer(press);
        return;
      }
      settlePress(press);
    };
    press.rec = rec;
    try { rec.start(); } catch { press.fatal = true; toast('Speech recognition could not start – type below', 'error'); }
  }

  function settlePress(press) {
    if (press.settled) return;
    press.settled = true;
    clearTimeout(press.timer);
    const text = press.text();
    if (press.rec) { try { press.rec.abort(); } catch { /* ignore */ } }
    press.rec = null;
    const turn = settleInterim(text);
    if (text) sendUtterance(text, turn);
    if (ptt.press === press) ptt.press = null;
    if (!ptt.active) runQueue();
  }

  function pttStart(src) {
    if (ptt.active) return;
    if (ptt.press) settlePress(ptt.press); // previous press still closing – send it now
    ptt.active = true;
    ptt.src = src;
    ptt.bargedIn = isSpeaking();
    if (ptt.bargedIn) {
      stopSpeech();
      post('/api/barge-in', { session_id: SESSION });
    }
    setMicPill();
    if (!serverStt && !SR) {
      toast('Voice input is not available in this browser – use the text box', 'error');
      return;
    }
    const press = {
      carry: '', final: '', interim: '', rec: null, settled: false, fatal: false, restarts: 0, timer: null,
      text() { return [this.carry, this.final, this.interim].join(' ').replace(/\s+/g, ' ').trim(); },
    };
    ptt.press = press;
    showInterim('');
    if (serverStt) recorderStart(press); else startRecognizer(press);
  }

  function pttEnd(src) {
    if (!ptt.active) return;
    if (src && ptt.src && src !== ptt.src) return;
    ptt.active = false;
    setMicPill();
    const press = ptt.press;
    if (press) {
      if (press.mr) {
        try { if (press.mr.state !== 'inactive') press.mr.stop(); } catch { /* ignore */ }
        press.timer = setTimeout(() => settlePress(press), 30000);
        runQueue();
        return;
      }
      if (!press.rec && serverStt) { runQueue(); return; } // recorder still waiting for mic permission
      try { if (press.rec) press.rec.stop(); } catch { /* ignore */ }
      // Final results arrive just after stop(); onend settles the press, the timer is the safety net.
      press.timer = setTimeout(() => settlePress(press), 1600);
    } else if (!SR) {
      $('textInput').focus();
    }
    runQueue();
  }

  async function sendUtterance(text, turn) {
    const t = turn || addUserTurn(text);
    pendingUser.push({ turn: t, at: Date.now() });
    newAgentTurn();
    const r = await post('/api/utterance', { session_id: SESSION, text, mode: MODE });
    if (!r) t.el.classList.add('failed');
  }

  /* ------------------------------------------------------------------ progress (header) */
  const STEPS = ['CLARIFY', 'SEARCH', 'NARRATE', 'CHOOSE', 'VERIFY', 'POLICY', 'APPROVE', 'CHECKOUT', 'DONE'];
  const STEP_LABEL = {
    CLARIFY: 'Understanding', SEARCH: 'Searching', NARRATE: 'Presenting options', CHOOSE: 'Your choice', VERIFY: 'Re-checking',
    POLICY: 'Checking your rules', APPROVE: 'Waiting for your OK', CHECKOUT: 'Checking out', DONE: 'Done',
  };
  const STATE_TO_STEP = { AWAIT_CHOICE: 'CHOOSE', SELECT: 'CHOOSE', NAVIGATE: 'NARRATE', ANSWER: 'NARRATE', CONFIRM: 'DONE' };
  const stepEls = STEPS.map(() => h('i'));
  $('progressDots').append(...stepEls);
  function setStep(state) {
    const step = STATE_TO_STEP[state] || state;
    const idx = STEPS.indexOf(step);
    stepEls.forEach((el, i) => {
      el.classList.toggle('now', i === idx);
      el.classList.toggle('past', idx >= 0 && i < idx);
    });
    $('progress').hidden = idx < 0;
    $('progressText').textContent = idx >= 0 ? STEP_LABEL[step] : '';
    $('progress').title = idx >= 0 ? `Step ${idx + 1} of ${STEPS.length}: ${STEP_LABEL[step]}` : '';
  }

  /* ------------------------------------------------------------------ memory + constraints (drawer, welcome) */
  let memChips = [];
  let conChips = [];
  function renderChips() {
    const box = $('chips');
    box.replaceChildren();
    const wp = $('welcomeProfile');
    const ctx = $('ctxBox');
    if (!memChips.length && !conChips.length) { box.hidden = true; ctx.hidden = true; if (wp) wp.hidden = true; return; }
    box.hidden = false;
    ctx.hidden = false;
    $('ctxCount').textContent = [memChips.length ? `${memChips.length} saved` : null, conChips.length ? `${conChips.length} for this request` : null].filter(Boolean).join(' · ');
    if (memChips.length) {
      box.append(h('div', { class: 'ctx-label' }, 'What Shopz remembers', h('span', { class: 'ctx-meta' }, 'used for every search')),
        h('div', { class: 'ctx-row' }, memChips.map((c) => {
          const src = c.source || 'seeded profile';
          return h('span', { class: 'mchip' + (src === 'learned' ? ' learned' : '') }, c.label, h('span', { class: 'src' }, src));
        })));
    }
    if (conChips.length) {
      box.append(h('div', { class: 'ctx-label' }, 'This request'),
        h('div', { class: 'ctx-row' }, conChips.map((c) => h('span', { class: 'mchip con' }, c.label))));
    }
    if (wp) {
      wp.hidden = !memChips.length;
      fill(wp, h('span', null, 'Shopz remembers'), memChips.map((c) => h('span', { class: 'mchip' }, c.label)));
    }
  }

  /* ------------------------------------------------------------------ product cards */
  let options = [];
  let narrated = -1;
  let chosen = -1;
  let cardSet = null; // { el, grid } – the newest option set in the thread
  const priceNow = {}; // sku → re-checked price from price_diff
  const ORD = ['first', 'second', 'third', 'fourth', 'fifth'];
  const stars = (n) => (isNum(Number(n)) ? '★'.repeat(Math.round(Number(n))) : '');

  function badgesFor(list) {
    const out = list.map(() => null);
    if (!list.length) return out;
    out[0] = 'Best fit';
    const minBy = (f) => {
      let best = -1; let bv = Infinity;
      list.forEach((o, i) => { const v = f(o); if (v !== null && v < bv) { bv = v; best = i; } });
      return best;
    };
    const cheap = minBy((o) => amount(o.price));
    if (cheap > 0 && !out[cheap]) out[cheap] = 'Cheapest';
    const fast = minBy((o) => { const d = localDate(o.delivery && o.delivery.eta_date); return d ? d.getTime() : null; });
    if (fast > 0 && !out[fast]) out[fast] = 'Fastest';
    return out;
  }

  function buildCard(o, i, badge) {
    const r = o.rating || {};
    const cur = (o.price && o.price.currency) || 'USD';
    const changed = Boolean(o.sku) && priceNow[o.sku] !== undefined && Math.abs(priceNow[o.sku] - amount(o.price)) >= 0.005;
    const etaIso = o.delivery && o.delivery.eta_date;
    const detail = h('dl', { class: 'pc-detail', hidden: true },
      h('dt', null, 'Seller'), h('dd', null, first(o.seller && (o.seller.name || o.seller), o.store_name, storeName(o.merchant_id), '—')),
      h('dt', null, 'Returns'), h('dd', null, first(o.return_policy && (o.return_policy.summary || o.return_policy), '—')),
      h('dt', null, 'Shipping'), h('dd', null, o.delivery && amount(o.delivery.shipping_cost) !== null
        ? (amount(o.delivery.shipping_cost) === 0 ? 'Free' : money(o.delivery.shipping_cost, cur)) : '—'),
      o.rank && isNum(o.rank.score) ? [h('dt', null, 'Match score'), h('dd', null, o.rank.score.toFixed(2))] : null);
    const card = h('article', {
      class: 'pcard' + (i === narrated ? ' on' : '') + (i === chosen ? ' chosen' : ''),
      tabindex: '0', role: 'button', 'aria-label': `Option ${i + 1}: ${o.title || o.sku}`,
    },
    h('div', { class: 'pc-img' },
      o.image_url ? h('img', { class: 'photo', src: o.image_url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
        : o.sku ? h('img', { src: artUrl(o.sku), alt: '' }) : null,
      badge ? h('span', { class: 'pc-badge' }, badge) : null,
      h('span', { class: 'pc-view' }, h('span', { class: 'dots' }, h('i'), h('i'), h('i')), 'Viewing'),
      h('span', { class: 'pc-pos' }, '#' + ((o.rank && o.rank.position) || i + 1))),
    h('div', { class: 'pc-body' },
      h('div', { class: 'pc-title', title: o.title || '' }, o.title || o.sku || 'Option'),
      h('div', { class: 'pc-store' }, o.store_name || storeName(o.merchant_id) || ''),
      h('div', { class: 'pc-price' },
        changed ? h('s', null, money(o.price, cur)) : null,
        h('b', null, money(changed ? priceNow[o.sku] : o.price, cur)),
        changed ? h('span', { class: 'up' }, 'price changed') : null),
      h('div', { class: 'pc-facts' },
        r.stars !== undefined && r.stars !== null ? h('span', null, h('span', { class: 'stars', 'aria-hidden': 'true' }, stars(r.stars)), ` ${r.stars}${r.count ? ` (${fmtInt(r.count)})` : ''}`) : null,
        etaIso ? h('span', null, `Arrives ${niceDate(etaIso)}`) : null),
      o.why ? h('div', { class: 'pc-why' }, o.why) : null,
      !o.live ? h('button', {
        class: 'linkbtn pc-more', type: 'button',
        onclick: (e) => { e.stopPropagation(); detail.hidden = !detail.hidden; e.currentTarget.textContent = detail.hidden ? 'Seller, returns, shipping' : 'Hide details'; },
      }, 'Seller, returns, shipping') : null,
      o.live ? h('div', { class: 'pc-src' },
        h('span', null, o.page_source === 'json-ld' ? 'read from the product page' : o.page_source ? 'from the store page' : 'from the store search'),
        o.url ? h('a', { class: 'pc-link', href: o.url, target: '_blank', rel: 'noopener noreferrer', onclick: (e) => e.stopPropagation() }, 'View in store ↗') : null) : null,
      detail),
    h('div', { class: 'pc-actions' },
      o.live ? h('button', {
        class: 'btn', type: 'button',
        onclick: (e) => { e.stopPropagation(); detail.hidden = !detail.hidden; e.currentTarget.textContent = detail.hidden ? 'Details' : 'Less'; },
      }, 'Details') : h('button', {
        class: 'btn btn-cart', type: 'button', 'aria-label': `Add ${o.title || 'this'} to the cart`,
        onclick: (e) => { e.stopPropagation(); sendText(`Add the ${ORD[i] || 'first'} one to my cart.`); },
      }, 'Add to cart'),
      h('button', {
        class: 'btn btn-primary', type: 'button',
        onclick: (e) => { e.stopPropagation(); chosen = i; renderCards(); sendText(`Buy the ${ORD[i] || 'first'} one.`); },
      }, i === chosen ? 'Chosen' : o.live ? 'Get it' : 'Choose')));
    const open = () => { if (narrated !== i) sendText(`Show me the ${ORD[i] || 'first'} one.`); };
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === card) { e.preventDefault(); open(); } });
    return card;
  }

  function renderCards() {
    if (!cardSet || !cardSet.el.isConnected) return;
    const badges = badgesFor(options);
    fill(cardSet.grid, options.map((o, i) => buildCard(o, i, badges[i])));
  }
  function showCards() {
    if (cardSet) { cardSet.el.classList.add('stale'); cardSet.el.inert = true; cardSet = null; }
    if (!options.length) return;
    const t = ensureAgentTurn();
    t.hasCards = true;
    if (t.view) { t.view.el.remove(); t.view = null; }
    const grid = h('div', { class: 'cards' });
    const el = h('div', { class: 'cards-wrap' },
      h('div', { class: 'cards-meta' }, isLive()
        ? `${options.length} pick${options.length === 1 ? '' : 's'} from real stores · prices read from the store pages · tap a card to hear it`
        : `${options.length} pick${options.length === 1 ? '' : 's'} from your approved stores · tap a card to hear it, or choose one`),
      grid);
    t.attach.append(el);
    cardSet = { el, grid };
    renderCards();
    scrollTurns();
  }
  function setNarrated(i) {
    narrated = Number.isInteger(i) ? i : -1;
    if (cardSet) cardSet.grid.querySelectorAll('.pcard').forEach((el, k) => el.classList.toggle('on', k === narrated));
    renderQuick();
  }

  /* ------------------------------------------------------------------ price change / policy / order cards */
  const decision = { policy: null, approval: null, priceDiff: null, priceAt: 0, policyAt: 0, order: null, policyEl: null, pending: false };
  let priceBumpAt = 0;
  const DENY_RULES = new Set(['merchant_not_approved', 'category_in_blocklist', 'out_of_stock', 'instruction_from_page_content']);

  function ruleText(rule, c) {
    switch (rule) {
      case 'total_over_limit':
        return c.limit !== null
          ? `Total ${money(c.total, c.cur)} is over your ${money(c.limit, c.cur, true)} auto-buy limit`
          : `Total ${money(c.total, c.cur)} is over your auto-buy limit`;
      case 'price_increased_since_first_seen':
        return 'Price went up since first seen' + (c.first !== null && c.now !== null ? ` (${money(c.first, c.cur)} → ${money(c.now, c.cur)})` : '');
      case 'merchant_not_approved':
        return `${c.merchant ? c.merchant + ' is' : 'This store is'} not one of your approved stores`;
      case 'out_of_stock':
        return 'Item is out of stock';
      case 'daily_order_limit':
        return 'Daily order limit reached' + (c.maxDay !== null ? ` (${c.maxDay} per day)` : '');
      case 'new_merchant':
        return 'First order at this store';
      case 'quantity_gt_2':
        return `Quantity ${c.qty !== null ? c.qty + ' ' : ''}is more than 2`;
      case 'category_in_blocklist':
        return `Category ${c.category ? '“' + c.category + '” ' : ''}is blocked by your policy`;
      case 'instruction_from_page_content':
        return 'Instruction came from page content, not from you';
      default: {
        const s = String(rule).replace(/_/g, ' ');
        return s.charAt(0).toUpperCase() + s.slice(1);
      }
    }
  }

  function policyFacts(p) {
    const inp = p.inputs || {};
    const cur = p.currency || (inp.totals && inp.totals.currency) || 'USD';
    return {
      cur,
      total: amount(first(p.total, inp.total, inp.totals && inp.totals.total)),
      limit: amount(first(p.limit, inp.limit, inp.max_total, inp.auto_approve_max_total, inp.auto_approve && inp.auto_approve.max_total,
        inp.policy && inp.policy.auto_approve && inp.policy.auto_approve.max_total)),
      first: amount(first(inp.first_seen_price, inp.first_seen)),
      now: amount(first(inp.current_price, inp.price_now, inp.at_checkout)),
      merchant: storeName(first(inp.merchant_name, inp.store_name, inp.merchant_id, inp.merchant)),
      maxDay: first(inp.max_orders_per_day, inp.policy && inp.policy.auto_approve && inp.policy.auto_approve.max_orders_per_day),
      qty: first(inp.qty),
      category: first(inp.category),
      ordersToday: inp.orders_today,
      version: first(inp.policy_version, inp.version),
    };
  }

  function renderPolicyCard() {
    const p = decision.policy;
    const el = decision.policyEl;
    if (!p || !el) return;
    if (p.scope === 'cart') { renderCartPolicyCard(p, el); return; }
    const dec = String(p.decision || '').toUpperCase();
    const c = policyFacts(p);
    const live = Boolean(p.live);
    const rules = Array.isArray(p.rules) ? p.rules : [];
    const lines = rules.map((r) => h('li', { class: DENY_RULES.has(r) ? 'deny' : '' }, ruleText(r, c)));
    if (!lines.length && dec === 'AUTO_APPROVE' && live) {
      lines.push(h('li', { class: 'ok' }, c.limit !== null ? `Price ${money(c.total, c.cur)} is within your ${money(c.limit, c.cur, true)} limit` : 'Within your rules'));
      if (c.merchant) lines.push(h('li', { class: 'ok' }, `${c.merchant} is one of your allowed stores`));
    } else if (!lines.length && dec === 'AUTO_APPROVE') {
      lines.push(h('li', { class: 'ok' }, c.limit !== null
        ? `Total ${money(c.total, c.cur)} is within your ${money(c.limit, c.cur, true)} auto-buy limit`
        : 'Within your auto-buy rules'));
      if (c.merchant) lines.push(h('li', { class: 'ok' }, `${c.merchant} is an approved store`));
    }
    const req = dec === 'REQUIRE_APPROVAL';
    const title = dec === 'AUTO_APPROVE' ? (live ? 'Within your rules – getting it ready in the store' : 'Within your rules – buying now') : dec === 'DENY' ? 'Not allowed by your rules' : 'Needs your OK';
    const sub = [c.merchant, c.version !== null ? `policy v${c.version}` : null, live ? 'live web' : null,
      !live && isNum(Number(c.ordersToday)) && c.ordersToday !== null && c.ordersToday !== undefined ? `orders today ${c.ordersToday}${c.maxDay !== null ? '/' + c.maxDay : ''}` : null].filter(Boolean).join(' · ');
    let foot = null;
    if (req && decision.approval === 'granted') foot = h('div', { class: 'policy-state ok', html: icon('check') + 'Confirmed by you' });
    else if (live && decision.approval === 'handoff') foot = h('div', { class: 'policy-state ok', html: icon('check') + 'Handed off to the store' });
    else if (req && decision.approval === 'denied') foot = h('div', { class: 'policy-state no' }, 'Not purchased');
    else if (req) {
      foot = [
        h('div', { class: 'policy-actions' },
          h('button', { class: 'btn btn-primary', type: 'button', disabled: decision.pending, onclick: () => { decision.pending = true; renderPolicyCard(); sendText('Confirm purchase.'); } }, live ? 'Confirm' : 'Confirm purchase'),
          h('button', { class: 'btn', type: 'button', disabled: decision.pending, onclick: () => { decision.pending = true; renderPolicyCard(); sendText('Cancel.'); } }, 'Cancel')),
        h('div', { class: 'policy-hint' }, live ? 'Or say “confirm”. Shopz never pays – you check out in the store.' : 'Or say “confirm purchase”. Nothing is bought without it.'),
      ];
    }
    el.className = 'icard policy ' + (dec === 'AUTO_APPROVE' ? 'dec-auto' : dec === 'DENY' ? 'dec-deny' : 'dec-req');
    fill(el,
      h('div', { class: 'policy-head' },
        h('span', { class: 'policy-ico', html: icon(dec === 'AUTO_APPROVE' ? 'check' : 'shield') }),
        h('div', null, h('div', { class: 'policy-title' }, title), sub ? h('div', { class: 'policy-sub' }, sub) : null),
        c.total !== null ? h('div', { class: 'policy-total' }, h('b', null, money(c.total, c.cur)),
          h('span', null, c.limit !== null ? `limit ${money(c.limit, c.cur, true)}` : 'total')) : null),
      lines.length ? h('ul', { class: 'rules' }, lines) : null,
      foot);
  }

  function policyFoot(req, live) {
    if (req && decision.approval === 'granted') return h('div', { class: 'policy-state ok', html: icon('check') + 'Confirmed by you' });
    if (req && decision.approval === 'denied') return h('div', { class: 'policy-state no' }, 'Not purchased');
    if (!req) return null;
    return [
      h('div', { class: 'policy-actions' },
        h('button', { class: 'btn btn-primary', type: 'button', disabled: decision.pending, onclick: () => { decision.pending = true; renderPolicyCard(); sendText('Confirm purchase.'); } }, live ? 'Confirm' : 'Confirm purchase'),
        h('button', { class: 'btn', type: 'button', disabled: decision.pending, onclick: () => { decision.pending = true; renderPolicyCard(); sendText('Cancel.'); } }, 'Cancel')),
      h('div', { class: 'policy-hint' }, 'Or say “confirm purchase”. Nothing is bought without it.'),
    ];
  }

  /** Cart checkout: the whole cart against the same rules – old and new total, every line, why it needs an OK. */
  function renderCartPolicyCard(p, el) {
    const dec = String(p.decision || '').toUpperCase();
    const inp = p.inputs || {};
    const rules = Array.isArray(p.rules) ? p.rules : [];
    const lines = Array.isArray(p.lines) ? p.lines : [];
    const total = amount(p.total);
    const was = amount(p.total_as_added);
    const limit = amount(first(p.limit, inp.limit));
    const changed = was !== null && total !== null && Math.abs(total - was) >= 0.005;
    const req = dec === 'REQUIRE_APPROVAL';
    const stores = Array.isArray(p.stores) ? p.stores.map((x) => x.store_name || storeName(x.merchant_id)) : [];
    const title = dec === 'AUTO_APPROVE' ? 'Cart within your rules – placing the orders' : dec === 'DENY' ? 'Cart not allowed by your rules' : 'Your cart needs your OK';
    const sub = [stores.join(' + '), `${lines.length} order${lines.length === 1 ? '' : 's'}`,
      isNum(Number(inp.orders_today)) && inp.orders_today !== null ? `orders today ${inp.orders_today}${inp.max_orders_per_day ? '/' + inp.max_orders_per_day : ''}` : null].filter(Boolean).join(' · ');
    const why = rules.length ? rules.map((r) => h('li', { class: DENY_RULES.has(r) ? 'deny' : '' }, cartRuleText(r, p)))
      : [h('li', { class: 'ok' }, limit !== null ? `Cart total ${money(total)} is within your ${money(limit, 'USD', true)} auto-buy limit` : 'Within your auto-buy rules'),
        h('li', { class: 'ok' }, `${stores.join(' and ') || 'The stores'} ${stores.length > 1 ? 'are' : 'is'} approved`)];
    el.className = 'icard policy cartpol ' + (dec === 'AUTO_APPROVE' ? 'dec-auto' : dec === 'DENY' ? 'dec-deny' : 'dec-req');
    fill(el,
      h('div', { class: 'policy-head' },
        h('span', { class: 'policy-ico', html: icon(dec === 'AUTO_APPROVE' ? 'check' : 'shield') }),
        h('div', null, h('div', { class: 'policy-title' }, title), sub ? h('div', { class: 'policy-sub' }, sub) : null),
        total !== null ? h('div', { class: 'policy-total' }, h('b', null, money(total)), h('span', null, limit !== null ? `limit ${money(limit, 'USD', true)}` : 'total')) : null),
      changed ? h('div', { class: 'cartpol-diff' },
        h('span', { class: 'lbl' }, 'Cart total'),
        h('span', { class: 'pdiff-row' }, h('s', null, money(was)), h('span', { 'aria-hidden': 'true' }, '→'), h('b', null, money(total)),
          h('span', { class: 'delta' + (total < was ? ' down' : '') }, (total > was ? '+' : '−') + money(Math.abs(total - was)))),
        h('span', { class: 'lbl muted' }, 'when added → now')) : null,
      lines.length ? h('ul', { class: 'cartpol-lines' }, lines.map((l) => {
        const up = isNum(l.price_now) && isNum(l.price_added) && Math.abs(l.price_now - l.price_added) >= 0.005;
        // line amounts: price × qty, so "2× … $36.80" reads right; the unit price goes next to the store name
        const q = isNum(Number(l.qty)) && Number(l.qty) > 0 ? Number(l.qty) : 1;
        const lt = (x) => (isNum(x) ? Math.round(x * q * 100) / 100 : x);
        return h('li', { class: l.in_stock === false ? 'out' : '' },
          h('span', { class: 'q' }, `${l.qty}×`),
          h('span', { class: 'n', title: l.title || '' }, l.title, h('span', { class: 's' }, l.store_name || storeName(l.merchant_id) || '')),
          h('span', { class: 'p' }, up ? [h('s', null, money(lt(l.price_added))), ' ', h('b', null, money(lt(l.price_now)))] : money(lt(l.price_now)),
            q > 1 && isNum(l.price_now) ? h('span', { class: 'each' }, `${money(l.price_now)} each`) : null,
            l.in_stock === false ? h('span', { class: 'oos' }, 'out of stock') : null));
      })) : null,
      h('ul', { class: 'rules' }, why),
      policyFoot(req, false));
  }

  function showPriceCard(d) {
    const t = ensureAgentTurn();
    const before = amount(d.before);
    const after = amount(d.after);
    const cur = (d.before && d.before.currency) || (d.after && d.after.currency) || d.currency || 'USD';
    const delta = before !== null && after !== null ? after - before : null;
    const simulated = d.simulated === true || (priceBumpAt && Date.now() - priceBumpAt < 10 * 60 * 1000);
    t.attach.append(h('div', { class: 'icard' },
      h('div', { class: 'icard-top', html: icon('tag') + 'Price changed since Shopz first saw it' + (simulated ? ' <span class="tag sim">simulated</span>' : '') }),
      h('div', { class: 'pdiff-row' },
        h('s', null, money(before, cur)), h('span', { 'aria-hidden': 'true' }, '→'), h('b', null, money(after, cur)),
        delta !== null && Math.abs(delta) >= 0.005 ? h('span', { class: 'delta' + (delta < 0 ? ' down' : '') }, (delta > 0 ? '+' : '−') + money(Math.abs(delta), cur)) : null),
      h('div', { class: 'pdiff-title' }, `${d.title || d.sku || ''} · first seen ${hms(d.before_ts)}, now ${hms(d.after_ts)}`)));
    scrollTurns();
  }

  function showPolicyCard(p) {
    const t = ensureAgentTurn();
    decision.policy = p;
    decision.approval = null;
    decision.pending = false;
    decision.policyAt = Date.now();
    decision.policyEl = h('div', { class: 'icard policy' });
    t.attach.append(decision.policyEl);
    renderPolicyCard();
    scrollTurns();
  }

  function showOrderCard(o) {
    const t = ensureAgentTurn();
    const tot = o.totals || {};
    const ap = o.approval || {};
    const how = ap.mode === 'user_explicit'
      ? `By you${ap.transcript ? ` – “${String(ap.transcript).replace(/[.\s]+$/, '')}”` : ''}`
      : ap.mode === 'auto' ? 'Automatic – within your rules' : (ap.mode || '—');
    const it0 = Array.isArray(o.items) && o.items[0] ? o.items[0] : null;
    t.attach.append(h('div', { class: 'icard order' },
      h('div', { class: 'order-head' },
        h('span', { class: 'order-ico', html: icon('check') }),
        h('div', null, h('div', { class: 'order-title' }, 'Order placed'), h('div', { class: 'order-id' }, o.order_id || '—')),
        o.demo_data !== false ? h('span', { class: 'tag', style: 'margin-left:auto' }, 'demo order') : null),
      h('div', { class: 'order-body' },
        it0 && it0.sku ? h('div', { class: 'order-img' }, h('img', { src: artUrl(it0.sku), alt: '' })) : null,
        h('dl', { class: 'order-facts' },
          it0 ? [h('dt', null, 'Item'), h('dd', null, `${it0.title || it0.sku}${it0.qty > 1 ? ` × ${it0.qty}` : ''}`)] : null,
          h('dt', null, 'Total'), h('dd', null, money(tot.total, tot.currency)),
          h('dt', null, 'Arrives'), h('dd', null, niceDate(o.delivery_eta)),
          h('dt', null, 'Approval'), h('dd', null, how)))));
    scrollTurns();
  }

  function showHandoffCard(x) {
    const t = ensureAgentTurn();
    const ap = x.approval || {};
    const how = ap.mode === 'user_explicit' ? 'Confirmed by you' : 'Within your rules';
    t.attach.append(h('div', { class: 'icard handoff' },
      h('div', { class: 'handoff-head' },
        h('span', { class: 'order-ico', html: icon('check') }),
        h('div', null, h('div', { class: 'handoff-title' }, 'Ready to buy'), h('div', { class: 'handoff-sub' }, `${x.store_name || ''} · price and stock just re-checked · ${how}`))),
      h('div', { class: 'handoff-body' },
        x.image_url ? h('div', { class: 'handoff-img' }, h('img', { src: x.image_url, alt: '', referrerpolicy: 'no-referrer' })) : null,
        h('div', { class: 'handoff-facts' },
          h('div', { class: 't', title: x.title || '' }, x.title || ''),
          h('div', { class: 'p' }, money(x.price, x.currency || 'USD')),
          x.variant && x.variant !== 'Default Title' ? h('div', { class: 'handoff-sub' }, x.variant) : null)),
      h('div', { class: 'handoff-actions' },
        h('a', { class: 'btn btn-primary', href: x.url, target: '_blank', rel: 'noopener noreferrer', html: 'Open in store ' + icon('out') })),
      h('div', { class: 'handoff-note' }, x.in_your_browser
        ? 'It is in your store cart and the checkout is open in the Shopz tab of your browser. Shopz never pays and never logs in for you.'
        : 'Shopz never pays and never logs in for you. Checkout, taxes and shipping happen in the store.')));
    if (decision.policy && decision.policyEl) { decision.approval = decision.approval === 'granted' ? 'granted' : 'handoff'; renderPolicyCard(); }
    scrollTurns();
  }

  function clearDecision() {
    decision.policy = null;
    decision.approval = null;
    decision.policyEl = null;
    decision.pending = false;
  }

  /* ------------------------------------------------------------------ quick replies */
  let lastClarify = null;
  const START_CHIPS = [
    ['Running shoes for a half marathon', 'I need running shoes for a half marathon in three weeks.'],
    ['Reorder my usual coffee', 'Reorder my usual coffee.'],
  ];
  const LIVE_CHIPS = [
    ['Running shoes under $150', 'Running shoes under $150.'],
    ['Wireless headphones under $100', 'Wireless headphones under $100.'],
    ['Whole bean coffee', 'Whole bean coffee.'],
    ['Rain jacket, size M', 'A rain jacket in size M.'],
  ];
  function quickReplies() {
    if (isLive()) {
      if (curState === 'APPROVE' && decision.policy && !decision.approval && !decision.pending) return [['Confirm', 'Confirm.', true], ['Cancel', 'Cancel.']];
      if (options.length && ['AWAIT_CHOICE', 'NARRATE'].includes(curState)) {
        const i = narrated >= 0 ? narrated : 0;
        const list = [['Reviews?', 'Show me the reviews.'], ['Shipping?', 'What about shipping?'], ['Return policy', "What's the return policy?"]];
        if (i < options.length - 1) list.push(['Next option', 'Next one.']);
        if (i > 0) list.push(['Go back', 'Go back.']);
        list.push(['Get this one', 'Buy this one.', true]);
        return list;
      }
      if (curState === 'DONE' || curState === 'IDLE') return thread.querySelector('.msg') ? LIVE_CHIPS : [];
      return [];
    }
    if (curState === 'APPROVE' && decision.policy && !decision.approval && !decision.pending) {
      return [['Confirm purchase', 'Confirm purchase.', true], ['Cancel', 'Cancel.']];
    }
    if (curState === 'CLARIFY') {
      const missing = (lastClarify && lastClarify.missing) || [];
      if (missing.includes('deadline')) return [['By next Friday', 'By next Friday.'], ['Within two weeks', 'Within two weeks.']];
      return START_CHIPS;
    }
    const inCart = cartItems() > 0;
    if (options.length && ['AWAIT_CHOICE', 'NARRATE', 'ANSWER', 'NAVIGATE', 'SELECT'].includes(curState)) {
      const i = narrated >= 0 ? narrated : 0;
      const list = [['Show reviews', 'Show me the reviews.'], ['Is it waterproof?', 'Is it waterproof?']];
      if (!inCart) list.push(['Return policy', "What's the return policy?"]);
      if (i < options.length - 1) list.push(['Next option', 'Next one.']);
      if (i > 0) list.push(['Go back', 'Go back.']);
      list.push(['Add to cart', 'Add this to my cart.']);
      if (inCart) list.push(['Check out cart', 'Check out my cart.']);
      list.push(['Buy this', 'Buy this one.', true]);
      return list;
    }
    if (curState === 'DONE' || curState === 'IDLE') {
      if (!thread.querySelector('.msg')) return [];
      return inCart ? [['Check out cart', 'Check out my cart.', true], ["What's in my cart?", "What's in my cart?"], ...START_CHIPS] : START_CHIPS;
    }
    return [];
  }
  function chipButtons(list) {
    return list.map(([label, text, primary], k) => h('button', {
      class: 'qchip' + (primary ? ' primary' : ''), type: 'button', style: `animation-delay:${k * 40}ms`,
      onclick: () => sendText(text),
    }, label));
  }
  let quickSig = '';
  function renderQuick() {
    const box = $('quick');
    const busy = Boolean(agentTurn && agentTurn.busy);
    const list = busy ? [] : quickReplies();
    const sig = list.map((x) => x[1]).join('|');
    if (sig === quickSig) return;
    quickSig = sig;
    fill(box, chipButtons(list));
    box.hidden = !list.length;
    scrollTurns();
  }

  /* ------------------------------------------------------------------ cart (demo stores) */
  const sheet = $('cartSheet');
  let cart = null; // cartView from the agent: { lines, totals, updated_at }
  let cartBusy = false;
  const cartItems = () => (cart && cart.totals ? Number(cart.totals.item_count || 0) + Number(cart.totals.external_count || 0) : 0);
  const pl = (n, w, many) => `${n} ${n === 1 ? w : many || w + 's'}`;

  function syncScrim() { $('scrim').hidden = !(drawer.classList.contains('open') || sheet.classList.contains('open')); }
  function setCart(open) {
    if (open && isLive()) return;
    if (open && drawer.classList.contains('open')) setDrawer(false);
    sheet.classList.toggle('open', open);
    sheet.setAttribute('aria-hidden', String(!open));
    $('cartBtn').setAttribute('aria-expanded', String(open));
    syncScrim();
    if (open) renderCart();
  }

  function lineImg(l, cls) {
    return h('div', { class: cls },
      l.image_url ? h('img', { class: 'photo', src: l.image_url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
        : l.sku ? h('img', { src: artUrl(l.sku), alt: '', loading: 'lazy' }) : null);
  }

  function setCartData(c) {
    cart = c && Array.isArray(c.lines) ? c : null;
    const n = cartItems();
    const badge = $('cartCount');
    const was = Number(badge.textContent) || 0;
    badge.textContent = String(n);
    badge.hidden = n === 0;
    if (n > was) { badge.classList.remove('bump'); void badge.offsetWidth; badge.classList.add('bump'); }
    $('cartBtn').setAttribute('aria-label', n ? `Cart, ${pl(n, 'item')}, ${money(cart.totals.total)}` : 'Cart, empty');
    if (sheet.classList.contains('open')) renderCart();
    renderQuick();
  }

  async function cartOp(body) {
    if (cartBusy) return;
    cartBusy = true;
    sheet.classList.add('busy');
    const r = await post('/api/cart', { session_id: SESSION, ...body });
    cartBusy = false;
    sheet.classList.remove('busy');
    if (r && r.cart) setCartData(r.cart);
  }

  function cartRow(l) {
    const cur = l.currency || 'USD';
    const ext = l.source === 'external';
    const changedPrice = isNum(l.first_seen_price) && Math.abs(l.first_seen_price - l.unit_price) >= 0.005;
    return h('li', { class: 'cline' + (ext ? ' ext' : ''), 'data-line': l.line_id },
      lineImg(l, 'cline-img'),
      h('div', { class: 'cline-main' },
        h('div', { class: 'cline-title', title: l.title || '' }, l.title || l.sku),
        h('div', { class: 'cline-meta' },
          `${money(l.unit_price, cur)} each`,
          changedPrice ? h('span', { class: 'was' }, ` · first seen ${money(l.first_seen_price, cur)}`) : null,
          ` · seen ${hms(l.seen_at).slice(0, 5)}`),
        ext
          ? h('a', { class: 'btn btn-sm cline-open', href: l.url || '#', target: '_blank', rel: 'noopener noreferrer', html: 'Open at store ' + icon('out') })
          : h('div', { class: 'cline-ctrl' },
            h('div', { class: 'stepper', role: 'group', 'aria-label': `Quantity of ${l.title}` },
              h('button', { type: 'button', class: 'step-btn', 'aria-label': 'One less', disabled: cartBusy || null, onclick: () => cartOp({ op: 'qty', line_id: l.line_id, qty: l.qty - 1 }), html: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' }),
              h('span', { class: 'step-n', 'aria-live': 'polite' }, String(l.qty)),
              h('button', { type: 'button', class: 'step-btn', 'aria-label': 'One more', disabled: cartBusy || l.qty >= 10 || null, onclick: () => cartOp({ op: 'qty', line_id: l.line_id, qty: l.qty + 1 }), html: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8h8M8 4v8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' })),
            h('button', { type: 'button', class: 'linkbtn cline-rm', onclick: () => cartOp({ op: 'remove', line_id: l.line_id }) }, 'Remove'))),
      h('div', { class: 'cline-price' }, ext ? h('span', { class: 'muted' }, 'as seen') : money(l.line_total, cur), ext ? h('b', null, money(l.unit_price, cur)) : null));
  }

  function renderCart() {
    const body = $('cartBody');
    const foot = $('cartFoot');
    const lines = (cart && cart.lines) || [];
    const tot = (cart && cart.totals) || null;
    if (!lines.length) {
      fill(body, h('div', { class: 'cart-empty' },
        h('div', { class: 'cart-empty-ico', html: icon('cart') }),
        h('div', { class: 'cart-empty-title' }, 'Your cart is empty'),
        h('div', { class: 'cart-empty-text' }, 'Say “add this to my cart” while Shopz shows a product, or tap Add to cart on a card. You can mix items from both stores.')));
      foot.hidden = true;
      $('cartSub').textContent = 'Demo stores · prices as seen on the product page';
      return;
    }
    $('cartSub').textContent = `${pl(tot.item_count, 'item')} from ${pl(tot.stores.length, 'store')} · prices as seen on the product page`;
    const byId = new Map(lines.map((l) => [l.line_id, l]));
    const groups = tot.stores.map((st) => h('section', { class: 'cstore' },
      h('div', { class: 'cstore-head' }, h('span', { class: 'cstore-name' }, st.store_name || storeName(st.merchant_id)), h('span', { class: 'cstore-meta' }, pl(st.item_count, 'item'))),
      h('ol', { class: 'clines' }, st.line_ids.map((id) => byId.get(id)).filter(Boolean).map(cartRow)),
      h('div', { class: 'cstore-sub' }, h('span', null, 'Subtotal'), h('span', null, money(st.subtotal)))));
    const ext = lines.filter((l) => l.source === 'external');
    if (ext.length) {
      groups.push(h('section', { class: 'cstore ext' },
        h('div', { class: 'cstore-head' }, h('span', { class: 'cstore-name' }, 'Other stores'), h('span', { class: 'cstore-meta' }, 'not checked out by Shopz')),
        h('ol', { class: 'clines' }, ext.map(cartRow))));
    }
    fill(body, groups);
    const ship = amount(tot.shipping);
    fill(foot,
      h('dl', { class: 'ctot' },
        h('dt', null, 'Items'), h('dd', null, money(tot.subtotal)),
        h('dt', null, `Tax ${isNum(tot.tax_rate) ? (tot.tax_rate * 100).toFixed(3).replace(/0+$/, '') + ' %' : ''}`), h('dd', null, money(tot.tax)),
        h('dt', null, 'Shipping'), h('dd', null, ship ? money(ship) : 'Free'),
        h('dt', { class: 'big' }, 'Total'), h('dd', { class: 'big' }, money(tot.total))),
      tot.line_count ? h('button', {
        class: 'btn btn-primary cart-go', type: 'button', disabled: cartBusy || null,
        onclick: () => { setCart(false); sendText('Check out my cart.'); },
      }, `Check out · ${money(tot.total)}`) : null,
      h('div', { class: 'cart-hint' }, tot.line_count
        ? `${pl(tot.line_count, 'order')} at the demo stores. Shopz re-checks every page and your purchase rules first.`
        : 'Open these items at their store to buy them.'));
    foot.hidden = false;
  }

  async function loadCart() {
    try {
      const r = await fetch('/api/cart?session=' + encodeURIComponent(SESSION), { cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      if (j.live) { $('cartBtn').hidden = true; return; }
      setCartData(j.cart);
    } catch { /* the cart also arrives over SSE */ }
  }

  function showCartAdded(d) {
    const l = ((d.cart && d.cart.lines) || []).find((x) => x.line_id === d.line_id);
    if (!l) return;
    const tot = d.cart.totals;
    const t = ensureAgentTurn();
    t.attach.append(h('div', { class: 'icard cartadd' },
      lineImg(l, 'cartadd-img'),
      h('div', { class: 'cartadd-main' },
        h('div', { class: 'cartadd-top', html: icon('check') + 'Added' + (d.added > 1 ? ` <span class="muted">× ${Number(d.added)}</span>` : '') }),
        h('div', { class: 'cartadd-title', title: l.title || '' }, l.title || l.sku),
        h('div', { class: 'cartadd-sub' }, `Cart · ${pl(tot.item_count, 'item')} · ${money(tot.total)} total`)),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => setCart(true) }, 'View cart')));
    scrollTurns();
  }

  function showCartSummary(c) {
    const t = ensureAgentTurn();
    const lines = (c && c.lines) || [];
    if (!lines.length) return;
    const tot = c.totals;
    t.attach.append(h('div', { class: 'icard cartsum' },
      h('div', { class: 'icard-top', html: icon('cart') + esc(`Your cart · ${pl(tot.item_count, 'item')}`) }),
      h('ul', { class: 'cartsum-list' }, lines.map((l) => h('li', null,
        h('span', { class: 'q' }, `${l.qty}×`), h('span', { class: 'n' }, l.title), h('span', { class: 's' }, l.store_name || ''),
        h('span', { class: 'p' }, l.source === 'external' ? money(l.unit_price) : money(l.line_total))))),
      h('div', { class: 'cartsum-foot' },
        h('span', null, 'Total with tax', h('b', null, money(tot.total))),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => setCart(true) }, 'View cart'))));
    scrollTurns();
  }

  function showCartOrderCard(d) {
    const t = ensureAgentTurn();
    const orders = Array.isArray(d.orders) ? d.orders : [];
    const how = d.approval_mode === 'user_explicit' ? 'Confirmed by you' : d.approval_mode === 'auto' ? 'Automatic – within your rules' : '';
    if (!orders.length) {
      if (d.failed) t.attach.append(h('div', { class: 'icard', html: icon('alert') + ' Checkout did not go through – nothing was bought. Your cart is unchanged.' }));
      return;
    }
    t.attach.append(h('div', { class: 'icard order corder' },
      h('div', { class: 'order-head' },
        h('span', { class: 'order-ico', html: icon('check') }),
        h('div', null, h('div', { class: 'order-title' }, `${pl(orders.length, 'order')} placed`), h('div', { class: 'order-sub' }, how)),
        h('span', { class: 'tag', style: 'margin-left:auto' }, 'demo orders')),
      h('ol', { class: 'corder-list' }, orders.map((o) => {
        const it = Array.isArray(o.items) && o.items[0] ? o.items[0] : {};
        return h('li', null,
          it.sku ? h('div', { class: 'corder-img' }, h('img', { src: artUrl(it.sku), alt: '' })) : null,
          h('div', { class: 'corder-main' },
            h('div', { class: 'corder-title' }, `${it.title || it.sku || ''}${it.qty > 1 ? ` × ${it.qty}` : ''}`),
            h('div', { class: 'corder-meta' }, [o.store_name || storeName(o.merchant_id), o.order_id, o.delivery_eta ? 'arrives ' + niceDate(o.delivery_eta) : null].filter(Boolean).join(' · '))),
          h('div', { class: 'corder-price' }, money(o.totals && o.totals.total)));
      })),
      h('div', { class: 'corder-foot' }, h('span', null, 'Paid in total'), h('b', null, money(d.total, d.currency))),
      d.failed ? h('div', { class: 'pview-note', html: icon('alert') + esc(`${d.failed.title || 'One item'} did not go through – it is still in your cart.`) }) : null));
    if (decision.policy && decision.policyEl && decision.policy.scope === 'cart' && !decision.approval) { decision.approval = 'granted'; renderPolicyCard(); }
    scrollTurns();
  }

  /* ------------------------------------------------------------------ audit trail (readable timeline) */
  const drawer = $('drawer');
  function setDrawer(open) {
    if (open && sheet.classList.contains('open')) setCart(false);
    drawer.classList.toggle('open', open);
    drawer.setAttribute('aria-hidden', String(!open));
    $('actBtn').setAttribute('aria-expanded', String(open));
    syncScrim();
    if (open) renderTimeline();
  }
  const tl = $('tl');
  const auditEvents = []; // chronological (by seq)
  const auditKeys = new Set();
  const MAX_EVENTS = 3000;
  const openEntries = new Set(); // entry keys with technical details open
  const groupOpen = new Map(); // group key → expanded (user choice wins over the default)
  let tlTimer = null;

  const PHASE_OF = {
    clarify_question: 'understand', preference_used: 'understand', user_interrupt: 'understand', barge_in: 'understand',
    search_issued: 'search', search_result: 'search', web_search: 'search',
    product_filtered: 'compare', ranking: 'compare', options_presented: 'compare',
    page_opened: 'check', page_navigate: 'check', page_read: 'check', page_reload: 'check', answer_given: 'check', answer_not_on_page: 'check',
    injection_ignored: 'check', price_observed: 'check', stock_checked: 'check', option_selected: 'check',
    policy_decision: 'rules', approval_requested: 'rules', approval_granted: 'rules', approval_denied: 'rules',
    checkout_started: 'buy', checkout_step: 'buy', order_confirmed: 'buy', handoff: 'buy', cart_checkout_done: 'buy',
    cart_item_added: 'cart', cart_item_removed: 'cart', cart_quantity_changed: 'cart', cart_checkout_started: 'cart',
  };
  const PHASE_LABEL = { understand: 'Understand', search: 'Search', compare: 'Compare', check: 'Check', rules: 'Your rules', buy: 'Buy', cart: 'Cart' };
  const DEC_LABEL = { AUTO_APPROVE: 'AUTO', REQUIRE_APPROVAL: 'NEEDS YOUR OK', DENY: 'NOT ALLOWED' };
  const DENIED_WHY = {
    user_cancelled: 'you said no', timeout: 'no answer in time', cart_changed: 'the cart changed', cart_rechecked: 'checked out again',
    user_navigated_away: 'you moved on', price_changed: 'the price changed',
  };
  const clean = (s) => String(s || '').replace(SNAP_TAIL, '');
  const skuOf = (ev) => first(ev.data && ev.data.sku, ev.refs && ev.refs.sku);
  const titleOf = (ev) => {
    const d = ev.data || {};
    const sku = skuOf(ev);
    const o = sku ? optionBySku(sku) : null;
    const l = sku && cart ? (cart.lines || []).find((x) => x.sku === sku) : null;
    return first(d.title, o && o.title, l && l.title, sku && skuNames.get(sku), sku);
  };
  const shortTitle = (t) => String(t || '').replace(/\s+[–-]\s+.*$/, '').replace(/\s+–.*$/, '');

  function joinable(last, ev) {
    if (!last) return false;
    const t = ev.type;
    const sku = skuOf(ev);
    if (['page_opened', 'page_navigate', 'page_read'].includes(t)) return last.kind === 'page' && last.sku === sku;
    if (['price_observed', 'stock_checked'].includes(t)) return ['page', 'recheck'].includes(last.kind) && last.sku === sku;
    if (t === 'product_filtered') return last.kind === 'filter';
    if (t === 'search_issued' || t === 'search_result') return last.kind === 'search';
    if (t === 'checkout_step') return last.kind === 'checkout';
    return false;
  }
  function kindOf(ev) {
    switch (ev.type) {
      case 'page_opened': case 'page_navigate': case 'page_read': case 'price_observed': case 'stock_checked': return 'page';
      case 'page_reload': return 'recheck';
      case 'product_filtered': return 'filter';
      case 'search_issued': case 'search_result': return 'search';
      case 'checkout_started': case 'checkout_step': return 'checkout';
      case 'policy_decision': return 'policy';
      default: return 'single';
    }
  }

  const skuNames = new Map(); // sku → product name, learned from any event that carries both
  function learnNames(ev) {
    const d = ev.data || {};
    const take = (o) => { if (o && typeof o === 'object' && o.sku && o.title && !skuNames.has(o.sku)) skuNames.set(o.sku, o.title); };
    take(d);
    take(d.value);
    for (const arr of [d.options, d.lines, d.items]) if (Array.isArray(arr)) arr.forEach(take);
  }

  /** Chronological events → groups (one per thing you asked) → entries (merged bursts) with phase. */
  function buildStory(events) {
    const groups = [];
    const seenPrice = new Map(); // sku → first price seen in the session
    let g = null;
    events.forEach(learnNames);
    const open = (ev) => {
      g = { key: ev ? 'g' + ev.seq : 'g0', ev, entries: [], stores: new Set(), pages: new Set(), rules: 0, orders: 0, added: 0, handoff: false, denied: false, asked: false };
      groups.push(g);
    };
    for (const ev of events) {
      if (ev.type === 'session_started') continue;
      if (ev.type === 'utterance') { open(ev); continue; }
      if (!g) open(null);
      const d = ev.data || {};
      const last = g.entries[g.entries.length - 1];
      if (ev.type === 'price_observed' && skuOf(ev) && isNum(amount(d.price))) {
        const sku = skuOf(ev);
        ev._was = seenPrice.has(sku) ? seenPrice.get(sku) : null;
        if (!seenPrice.has(sku)) seenPrice.set(sku, amount(d.price));
      }
      if (ev.type === 'search_issued') g.stores.add(first(d.store_name, d.store));
      if (ev.type === 'page_read' && skuOf(ev)) g.pages.add(skuOf(ev));
      if (ev.type === 'policy_decision') { g.rules++; if (String(d.decision).toUpperCase() === 'DENY') g.denied = true; }
      if (ev.type === 'order_confirmed') g.orders++;
      if (ev.type === 'cart_item_added') g.added += Number(d.qty_added) || 1;
      if (ev.type === 'handoff') g.handoff = true;
      if (ev.type === 'approval_requested') g.asked = true;
      if (joinable(last, ev)) { last.events.push(ev); continue; }
      const phase = PHASE_OF[ev.type] || (last ? last.phase : 'understand');
      g.entries.push({ key: 'e' + ev.seq, kind: kindOf(ev), sku: skuOf(ev), phase, events: [ev] });
    }
    return groups;
  }

  function groupOutcome(g) {
    const parts = [];
    if (g.stores.size) parts.push('searched ' + pl(g.stores.size, 'store'));
    if (g.pages.size) parts.push('read ' + pl(g.pages.size, 'page'));
    if (g.rules) parts.push(pl(g.rules, 'rule check'));
    if (g.added) parts.push('added ' + pl(g.added, 'item') + ' to the cart');
    if (g.orders) parts.push(pl(g.orders, 'order') + ' placed');
    else if (g.handoff) parts.push('handed off to the store');
    else if (g.denied) parts.push('not allowed');
    else if (g.asked) parts.push('waiting for your OK');
    if (!parts.length) parts.push(pl(g.entries.length, 'step'));
    const s = parts.join(' · ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function priceChange(before, after, cur) {
    if (before === null || after === null) return null;
    const delta = after - before;
    if (Math.abs(delta) < 0.005) return h('span', { class: 'pchip' }, money(after, cur));
    return h('span', { class: 'pchange' }, h('s', null, money(before, cur)), h('span', { 'aria-hidden': 'true' }, '→'), h('b', null, money(after, cur)),
      h('span', { class: 'delta' + (delta < 0 ? ' down' : '') }, (delta > 0 ? '+' : '−') + money(Math.abs(delta), cur)));
  }

  /** One entry → { icon, tone, text, facts (inline chips), extra (block below) } in plain language. */
  function describe(e) {
    const ev = e.events[0];
    const evs = e.events;
    const d = ev.data || {};
    const t = ev.type;
    const name = shortTitle(titleOf(ev)) || 'the product';
    let text = clean(ev.summary) || t;
    let tone = toneOf(ev);
    let ico = TYPE_ICON[t] || 'dot';
    const facts = [];
    let extra = null;
    switch (e.kind) {
      case 'page': {
        const secs = []; let price = null; let was = null; let stock = null; let opened = false;
        for (const x of evs) {
          const xd = x.data || {};
          if (x.type === 'page_opened') opened = true;
          if (x.type === 'page_read' && xd.section && xd.section !== 'all' && !secs.includes(xd.section)) secs.push(xd.section);
          if (x.type === 'page_read' && xd.section === 'all' && !secs.includes('all')) secs.push('all');
          if (x.type === 'price_observed') { price = amount(xd.price); was = x._was; }
          if (x.type === 'stock_checked') stock = xd.in_stock;
        }
        const back = evs.some((x) => /^Went back to /.test(x.summary || ''));
        ico = secs.length ? 'eye' : 'page';
        text = secs.length ? `Read the ${name} page` : back ? `Went back to the ${name} page` : opened ? `Opened the ${name} page` : `Looked at ${name}`;
        if (secs.length) facts.push(h('span', { class: 'secs' }, secs.map((s) => h('span', { class: 'sec read' }, s === 'all' ? 'Whole page' : SECTION_LABEL[s] || s))));
        if (price !== null) facts.push(was !== null && Math.abs(was - price) >= 0.005 ? priceChange(was, price) : h('span', { class: 'pchip' }, 'price ' + money(price)));
        if (stock === false) { facts.push(h('span', { class: 'fact bad' }, 'out of stock')); tone = 'bad'; }
        if (was !== null && price !== null && Math.abs(was - price) >= 0.005) tone = 'warn';
        if (tone === 'neutral' || tone === 'user') tone = 'neutral';
        break;
      }
      case 'recheck': {
        let price = null; let was = null; let stock = null;
        for (const x of evs) {
          const xd = x.data || {};
          if (x.type === 'price_observed') { price = amount(xd.price); was = x._was; }
          if (x.type === 'stock_checked') stock = xd.in_stock;
        }
        ico = 'reload';
        text = `Re-checked price and stock for ${name}`;
        if (price !== null) facts.push(was !== null && Math.abs(was - price) >= 0.005 ? priceChange(was, price) : h('span', { class: 'pchip' }, money(price) + ' · unchanged'));
        if (stock !== null) facts.push(h('span', { class: 'fact' + (stock ? ' good' : ' bad') }, stock ? 'in stock' : 'out of stock'));
        tone = stock === false ? 'bad' : was !== null && price !== null && Math.abs(was - price) >= 0.005 ? 'warn' : 'neutral';
        break;
      }
      case 'search': {
        const stores = []; let query = null; let res = null;
        for (const x of evs) {
          const xd = x.data || {};
          if (x.type === 'search_issued') { const n = first(xd.store_name, xd.store); if (n && !stores.includes(n)) stores.push(n); query = first(query, xd.query); }
          if (x.type === 'search_result') res = xd;
        }
        ico = 'search';
        text = stores.length ? `Searched ${stores.join(' and ')}${query ? ` for “${query}”` : ''}` : clean(ev.summary);
        if (res && isNum(res.seen)) facts.push(h('span', { class: 'fact' }, `${res.seen} seen · ${isNum(res.matched) ? res.matched : '?'} match`));
        break;
      }
      case 'filter': {
        ico = 'filter';
        tone = 'warn';
        text = `Set aside ${pl(evs.length, 'product')}`;
        extra = h('ul', { class: 'aside-list' }, evs.map((x) => {
          const m = clean(x.summary).match(/^Filtered out (.+?):\s*(.+)$/);
          return h('li', null, h('span', { class: 'n' }, shortTitle(m ? m[1] : first(x.data && x.data.title, x.data && x.data.sku))), h('span', { class: 'why' }, m ? m[2] : String((x.data && x.data.reason) || '').replace(/_/g, ' ')));
        }));
        break;
      }
      case 'checkout': {
        const steps = evs.filter((x) => x.type === 'checkout_step').map((x) => String((x.data && x.data.step) || '').replace(/_/g, ' '));
        const failed = evs.some((x) => x.type === 'checkout_step' && x.data && x.data.ok === false);
        const store = first(storeName(d.merchant_id), d.store_name);
        text = `Checked out ${d.qty > 1 ? d.qty + ' × ' : ''}${name}${store ? ' at ' + store : ''}`;
        ico = 'cart';
        if (isNum(amount(d.total))) facts.push(h('span', { class: 'pchip' }, money(d.total)));
        if (steps.length) facts.push(h('span', { class: 'fact' }, steps.join(' → ')));
        if (failed) { tone = 'bad'; facts.push(h('span', { class: 'fact bad' }, 'a step failed')); }
        break;
      }
      case 'policy': {
        const dec = String(d.decision || '').toUpperCase();
        const c = policyFacts({ ...d, inputs: d.inputs || {} });
        const rules = Array.isArray(d.rules) ? d.rules : [];
        const isCart = d.scope === 'cart';
        ico = 'shield';
        tone = dec === 'AUTO_APPROVE' ? 'good' : dec === 'DENY' ? 'bad' : 'warn';
        text = isCart ? 'Checked the whole cart against your rules' : `Checked ${name} against your rules`;
        const why = rules.length ? rules.map((r) => h('li', { class: DENY_RULES.has(r) ? 'deny' : '' }, isCart ? cartRuleText(r, d) : ruleText(r, c)))
          : [h('li', { class: 'ok' }, c.limit !== null ? `Total ${money(c.total)} is within your ${money(c.limit, c.cur, true)} auto-buy limit` : 'Within your rules')];
        const was = amount(d.total_as_added);
        extra = h('div', { class: 'rule-box dec-' + (dec === 'AUTO_APPROVE' ? 'auto' : dec === 'DENY' ? 'deny' : 'req') },
          h('div', { class: 'rule-top' },
            h('span', { class: 'dtag' }, DEC_LABEL[dec] || dec),
            h('span', { class: 'rule-total' }, isCart && was !== null && Math.abs(was - c.total) >= 0.005 ? priceChange(was, c.total) : money(c.total),
              c.limit !== null ? h('span', { class: 'muted' }, ` · limit ${money(c.limit, c.cur, true)}`) : null)),
          h('ul', { class: 'rule-why' }, why),
          isCart && Array.isArray(d.lines) ? h('div', { class: 'rule-lines' }, d.lines.map((l) => h('div', null,
            h('span', null, `${l.qty}× ${shortTitle(l.title)}`),
            isNum(l.price_now) && isNum(l.price_added) && Math.abs(l.price_now - l.price_added) >= 0.005 ? priceChange(l.price_added, l.price_now) : h('span', { class: 'muted' }, money(l.price_now))))) : null);
        break;
      }
      default:
        switch (t) {
          case 'preference_used': text = 'Used your saved preference: ' + clean(ev.summary).replace(/^Used saved preference:\s*/, '').replace(/\s*\((?:seeded[^)]*|learned)\)\s*$/, ''); break;
          case 'preference_saved': text = 'Remembered for next time: ' + clean(ev.summary).replace(/^[^:]*:\s*/, ''); break;
          case 'clarify_question': text = 'Asked you: ' + clean(first(d.question, ev.summary)).replace(/^Asked:?\s*/, ''); break;
          case 'ranking': text = 'Ranked the matches by rating, fit, price and delivery'; if (Array.isArray(d.options)) facts.push(h('span', { class: 'fact' }, d.options.map((o) => shortTitle(o.title)).join(' → '))); break;
          case 'options_presented': text = `Showed you ${pl(Number(d.count) || 0, 'option')}`; break;
          case 'answer_given': text = 'Answered from the page'; { const q = findKey(d, 'quoted_span'); if (q) extra = h('blockquote', { class: 'te-quote' }, `“${q}”`); } break;
          case 'answer_not_on_page': text = `Not on the page${d.topic ? ' (' + d.topic + ')' : ''} – Shopz did not guess`; break;
          case 'injection_ignored': text = 'Ignored an instruction hidden in the page – only you give instructions'; if (d.quote) extra = h('blockquote', { class: 'te-quote bad' }, `“${d.quote}”`); break;
          case 'option_selected': text = `You picked ${name}`; break;
          case 'approval_requested': text = `Asked you to say “${first(d.phrase, 'confirm purchase')}”`; if (isNum(amount(d.total))) facts.push(h('span', { class: 'pchip' }, money(d.total))); break;
          case 'approval_granted': text = `You confirmed${d.transcript ? ': “' + String(d.transcript).replace(/[.\s]+$/, '') + '”' : ''}`; break;
          case 'approval_denied': text = `Not bought – ${DENIED_WHY[d.reason] || String(d.reason || 'not confirmed').replace(/_/g, ' ')}`; tone = d.reason === 'user_cancelled' ? 'neutral' : 'warn'; break;
          case 'order_confirmed': text = `${storeName(d.merchant_id) || 'The store'} confirmed order ${d.order_id || ''}`.trim(); if (d.totals) facts.push(h('span', { class: 'pchip' }, money(d.totals.total))); if (d.delivery_eta) facts.push(h('span', { class: 'fact' }, 'arrives ' + niceDate(d.delivery_eta))); break;
          case 'handoff': text = 'Handed off to the store – Shopz does not pay'; break;
          case 'cart_item_added': text = `Added ${d.qty_added > 1 ? d.qty_added + ' × ' : ''}${name} to the cart`; facts.push(h('span', { class: 'pchip' }, money(d.unit_price) + ' as seen')); if (isNum(d.cart_total)) facts.push(h('span', { class: 'fact' }, `cart ${money(d.cart_total)}`)); tone = 'neutral'; break;
          case 'cart_item_removed': text = `${ev.actor === 'user' ? 'You removed' : 'Removed'} ${name} from the cart`; if (isNum(d.cart_total)) facts.push(h('span', { class: 'fact' }, `cart ${money(d.cart_total)}`)); break;
          case 'cart_quantity_changed': text = `${ev.actor === 'user' ? 'You changed' : 'Changed'} ${name} from ${d.qty_before} to ${d.qty}`; if (isNum(d.cart_total)) facts.push(h('span', { class: 'fact' }, `cart ${money(d.cart_total)}`)); break;
          case 'cart_checkout_started': text = `Started checking out the cart${Array.isArray(d.stores) ? ' at ' + d.stores.map((x) => x.store_name).join(' and ') : ''}`; if (isNum(amount(d.total_as_added))) facts.push(h('span', { class: 'pchip' }, money(d.total_as_added) + ' as added')); break;
          case 'cart_checkout_done': text = Array.isArray(d.orders) ? `Cart checked out: ${pl(d.orders.length, 'order')}` : clean(ev.summary); if (isNum(amount(d.total))) facts.push(h('span', { class: 'pchip' }, money(d.total) + ' paid')); tone = d.failed_line_id ? 'bad' : 'good'; break;
          case 'user_interrupt': case 'barge_in': text = 'You interrupted – Shopz stopped talking'; tone = 'neutral'; break;
          case 'error': text = 'Something went wrong: ' + clean(ev.summary); break;
          case 'fallback_used': text = 'Used another way: ' + clean(ev.summary); break;
          default: break;
        }
    }
    return { ico, tone, text, facts, extra };
  }

  function cartRuleText(rule, d) {
    const inp = d.inputs || {};
    const lines = Array.isArray(d.lines) ? d.lines : [];
    switch (rule) {
      case 'total_over_limit': return `Cart total ${money(d.total)} is over your ${money(first(d.limit, inp.limit), 'USD', true)} auto-buy limit`;
      case 'price_increased_since_first_seen': {
        const up = lines.filter((l) => isNum(l.price_now) && isNum(l.price_added) && l.price_now - l.price_added >= 0.005);
        return 'Price went up since you added it' + (up.length ? ': ' + up.map((l) => `${shortTitle(l.title)} ${money(l.price_added)} → ${money(l.price_now)}`).join(', ') : '');
      }
      case 'daily_order_limit': return `${pl(Number(inp.orders_to_place) || lines.length, 'order')} on top of ${Number(inp.orders_today) || 0} today is over your ${first(inp.max_orders_per_day, 3)} per day`;
      case 'quantity_gt_2': return `More than 2 of one item (${first(inp.max_qty, '?')})`;
      case 'out_of_stock': { const out = lines.filter((l) => l.in_stock === false); return (out.length ? out.map((l) => shortTitle(l.title)).join(', ') + ' ' + (out.length === 1 ? 'is' : 'are') : 'An item is') + ' out of stock'; }
      case 'new_merchant': return 'First order at one of these stores';
      default: return ruleText(rule, policyFacts(d));
    }
  }

  function techDetail(e) {
    return h('div', { class: 'te-tech' }, e.events.map((ev) => {
      const data = ev.data || {};
      const sha = first(findKey(data, 'snapshot_sha256'), data.snapshot && data.snapshot.sha256);
      return h('div', { class: 'tech-ev' },
        h('div', { class: 'tech-head' }, h('b', null, ev.type), ` · #${ev.seq} · ${hms(ev.ts)}${ev.actor ? ' · ' + ev.actor : ''}`),
        sha ? h('div', { class: 'tech-row' }, h('span', null, 'page sha256'), h('code', null, String(sha))) : null,
        h('div', { class: 'tech-row' }, h('span', null, 'hash'), h('code', null, String(ev.hash || '—'))),
        h('div', { class: 'tech-row' }, h('span', null, 'prev'), h('code', null, String(ev.prev_hash || '—'))),
        h('pre', { class: 'evd-json', html: highlightJson({ summary: ev.summary, data, refs: ev.refs, event_id: ev.event_id }) }));
    }));
  }

  function renderEntry(e) {
    const x = describe(e);
    const ev = e.events[0];
    const li = h('li', { class: `te tone-${x.tone}${e.kind === 'policy' ? ' te-policy' : ''}${openEntries.has(e.key) ? ' open' : ''}` });
    const line = h('button', { class: 'te-line', type: 'button', 'aria-expanded': String(openEntries.has(e.key)), title: 'Technical details' },
      h('span', { class: 'te-ico', html: icon(x.ico) }),
      h('span', { class: 'te-text' }, x.text),
      h('span', { class: 'te-time' }, hms(ev.ts)));
    li.append(line);
    if (x.facts.length) li.append(h('div', { class: 'te-facts' }, x.facts));
    if (x.extra) li.append(h('div', { class: 'te-extra' }, x.extra));
    if (openEntries.has(e.key)) li.append(techDetail(e));
    line.addEventListener('click', () => {
      const open = !openEntries.has(e.key);
      if (open) openEntries.add(e.key); else openEntries.delete(e.key);
      li.classList.toggle('open', open);
      line.setAttribute('aria-expanded', String(open));
      const tech = li.querySelector('.te-tech');
      if (open && !tech) li.append(techDetail(e)); else if (!open && tech) tech.remove();
    });
    return li;
  }

  function renderGroup(g, idx) {
    const said = g.ev ? first(g.ev.data && g.ev.data.text, clean(g.ev.summary).replace(/^User:\s*"?|"$/g, '')) : null;
    const expanded = groupOpen.has(g.key) ? groupOpen.get(g.key) : idx < 3;
    const phases = [];
    for (const e of g.entries) {
      const lastP = phases[phases.length - 1];
      if (!lastP || lastP.phase !== e.phase) phases.push({ phase: e.phase, entries: [e] }); else lastP.entries.push(e);
    }
    const body = h('div', { class: 'tg-body' }, phases.map((p) => h('div', { class: 'tp tp-' + p.phase },
      h('div', { class: 'tp-label' }, PHASE_LABEL[p.phase] || p.phase),
      h('ol', { class: 'tp-list' }, p.entries.map(renderEntry)))));
    const head = h('button', { class: 'tg-head', type: 'button', 'aria-expanded': String(expanded) },
      h('span', { class: 'tg-chev', html: icon('chev') }),
      h('span', { class: 'tg-main' },
        h('span', { class: 'tg-said' }, said ? `“${String(said).replace(/[.\s]+$/, '')}”` : 'Session start'),
        h('span', { class: 'tg-out' }, groupOutcome(g))),
      h('span', { class: 'tg-time' }, g.ev ? hms(g.ev.ts).slice(0, 5) : ''));
    const el = h('article', { class: 'tg' + (expanded ? ' open' : '') }, head, body);
    head.addEventListener('click', () => {
      const open = !el.classList.contains('open');
      groupOpen.set(g.key, open);
      el.classList.toggle('open', open);
      head.setAttribute('aria-expanded', String(open));
    });
    return el;
  }

  let storyStats = { steps: 0, pages: 0, rules: 0 };
  function renderTimeline() {
    clearTimeout(tlTimer);
    tlTimer = null;
    const groups = buildStory(auditEvents).filter((g) => g.entries.length || g.ev);
    const pages = new Set(); let rules = 0; let steps = 0;
    for (const g of groups) { g.pages.forEach((p) => pages.add(p)); rules += g.rules; steps += g.entries.length; }
    storyStats = { steps, pages: pages.size, rules };
    renderSummary();
    if (!groups.length) { fill(tl, h('div', { id: 'tlEmpty', class: 'tl-empty' }, 'Each request you make shows up here as a short story: what Shopz searched, compared, read and checked, and which of your rules applied.')); return; }
    const keep = $('drawer').querySelector('.drawer-body');
    const top = keep.scrollTop;
    fill(tl, groups.slice().reverse().map((g, i) => renderGroup(g, i)));
    keep.scrollTop = top;
  }
  function scheduleTimeline() {
    if (!drawer.classList.contains('open')) { renderSummaryCounts(); return; }
    if (tlTimer) return;
    tlTimer = setTimeout(renderTimeline, 150);
  }
  function renderSummaryCounts() {
    // cheap count while the drawer is closed (the full story is built when it opens)
    const pages = new Set(); let rules = 0;
    for (const ev of auditEvents) { if (ev.type === 'page_read' && skuOf(ev)) pages.add(skuOf(ev)); if (ev.type === 'policy_decision') rules++; }
    storyStats = { steps: storyStats.steps, pages: pages.size, rules };
  }
  function renderSummary() {
    const s = storyStats;
    fill($('asumStats'), s.steps
      ? [h('b', null, String(s.steps)), ` ${s.steps === 1 ? 'step' : 'steps'} · `, h('b', null, String(s.pages)), ` ${s.pages === 1 ? 'page' : 'pages'} read · `, h('b', null, String(s.rules)), ` rule ${s.rules === 1 ? 'check' : 'checks'}`]
      : 'No steps yet');
  }

  function addAudit(ev, fresh) {
    if (!ev || typeof ev !== 'object') return;
    const key = first(ev.event_id, isNum(ev.seq) ? 'seq' + ev.seq : null, ev.hash);
    if (key !== null && auditKeys.has(key)) return;
    if (key !== null) auditKeys.add(key);
    const seq = isNum(ev.seq) ? ev.seq : Infinity;
    let i = auditEvents.length;
    while (i > 0 && (isNum(auditEvents[i - 1].seq) ? auditEvents[i - 1].seq : Infinity) > seq) i--;
    auditEvents.splice(i, 0, ev);
    if (auditEvents.length > MAX_EVENTS) auditEvents.splice(0, auditEvents.length - MAX_EVENTS);
    $('actBtnCount').textContent = String(auditKeys.size);

    if (fresh) addStep(ev);
    if (ev.type === 'clarify_question') lastClarify = ev.data || null;
    if (ev.type === 'option_selected' && Number.isInteger(ev.data && ev.data.option_index)) { chosen = ev.data.option_index; renderCards(); }
    if (ev.type === 'approval_granted' || ev.type === 'approval_denied') {
      if (decision.policy) { decision.approval = ev.type === 'approval_granted' ? 'granted' : 'denied'; decision.pending = false; renderPolicyCard(); renderQuick(); }
    }
    scheduleTimeline();
    scheduleVerify();
  }

  async function backfillAudit() {
    try {
      const r = await fetch('/api/audit?session=' + encodeURIComponent(SESSION));
      if (!r.ok) return;
      const body = await r.json();
      const events = Array.isArray(body && body.events) ? body.events : [];
      events.forEach((ev) => addAudit(ev, false));
    } catch { /* live events still arrive over SSE */ }
  }

  /* ------------------------------------------------------------------ hash chain: verify (server + this browser) and export */
  let verifyDebounce = null;
  let verifyFailed = false;
  let lastVerify = null;
  function scheduleVerify() {
    clearTimeout(verifyDebounce);
    verifyDebounce = setTimeout(refreshVerify, 1200);
  }
  function canonical(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  /** Recompute every hash in this browser: hash = sha256(prev_hash + canonicalJson(event without hash)). */
  async function verifyHere(events) {
    if (!(window.crypto && crypto.subtle)) return null; // needs https or localhost
    let prev = '0'.repeat(64);
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const { hash, ...rest } = e;
      if (e.seq !== i + 1) return { ok: false, count: events.length, bad_seq: i + 1, reason: 'seq_gap' };
      if (e.prev_hash !== prev) return { ok: false, count: events.length, bad_seq: e.seq, reason: 'prev_hash_mismatch' };
      if ((await sha256((rest.prev_hash || '0'.repeat(64)) + canonical(rest))) !== hash) return { ok: false, count: events.length, bad_seq: e.seq, reason: 'hash_mismatch' };
      prev = hash;
    }
    return { ok: true, count: events.length };
  }
  const REASON_TEXT = { seq_gap: 'an entry is missing', prev_hash_mismatch: 'an entry does not point to the one before', hash_mismatch: 'an entry was changed after it was written' };

  function renderChain(v) {
    const el = $('chain');
    const n = Number(v.count) || 0;
    el.className = 'chain ' + (v.ok ? 'ok' : 'bad');
    fill(el,
      h('span', { class: 'chain-ico', html: icon(v.ok ? 'check' : 'alert') }),
      h('span', { class: 'chain-main' }, v.ok ? 'Hash chain verified' : `Hash chain broken at #${first(v.bad_seq, '?')}`),
      h('span', { class: 'chain-meta' }, `${pl(n, 'entry', 'entries')}${v.head_hash ? ' · head ' + short(v.head_hash) : ''}`));
    const badge = $('actBtnChain');
    badge.className = 'act-btn-chain' + (v.ok ? '' : ' bad');
    badge.innerHTML = n ? icon(v.ok ? 'check' : 'x') : '';
    badge.title = v.ok ? 'Hash chain verified' : 'Hash chain broken';
    $('actBtnCount').textContent = String(n);
  }

  async function refreshVerify() {
    try {
      const r = await fetch('/api/audit/verify?session=' + encodeURIComponent(SESSION));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const v = await r.json();
      verifyFailed = false;
      lastVerify = v;
      renderChain(v);
      return v;
    } catch (err) {
      const el = $('chain');
      el.className = 'chain unk';
      fill(el, h('span', { class: 'chain-ico', html: icon('alert') }), h('span', { class: 'chain-main' }, 'Hash chain: not reachable'));
      if (!verifyFailed) toast('Audit check failed: ' + (err && err.message ? err.message : 'network error'), 'error');
      verifyFailed = true;
      return null;
    }
  }

  async function verifyAgain() {
    const btn = $('verifyBtn');
    const out = $('chainDetail');
    btn.disabled = true;
    btn.textContent = 'Verifying…';
    const started = performance.now();
    const v = await refreshVerify();
    let here = null;
    try {
      const r = await fetch('/api/audit?session=' + encodeURIComponent(SESSION), { cache: 'no-store' });
      const evs = (await r.json()).events || [];
      evs.forEach((ev) => addAudit(ev, false));
      here = await verifyHere(evs);
    } catch { here = null; }
    const ms = Math.max(1, Math.round(performance.now() - started));
    await new Promise((res) => setTimeout(res, Math.max(0, 350 - ms))); // let the reader see that it ran
    btn.disabled = false;
    btn.textContent = 'Verify again';
    out.hidden = false;
    const okAll = v && v.ok && (!here || here.ok);
    out.className = 'chain-detail ' + (okAll ? 'ok' : 'bad');
    const bad = (v && !v.ok ? v : null) || (here && !here.ok ? here : null);
    fill(out,
      h('div', null, h('b', null, okAll ? 'All entries intact' : `Problem at #${bad ? bad.bad_seq : '?'}`),
        h('span', { class: 'muted' }, ` · checked ${hms(new Date().toISOString())} · ${ms} ms`)),
      h('div', { class: 'muted' }, v ? `Server: ${pl(Number(v.count) || 0, 'entry', 'entries')} ${v.ok ? 'match' : 'checked – ' + (REASON_TEXT[v.reason] || v.reason)}` : 'Server: not reachable'),
      h('div', { class: 'muted' }, here ? `This browser recomputed every SHA-256 hash: ${here.ok ? 'all match' : REASON_TEXT[here.reason] || here.reason}` : 'This browser cannot recompute hashes here (needs https) – server check only'));
  }

  async function exportAudit() {
    try {
      const [a, v] = await Promise.all([
        fetch('/api/audit?session=' + encodeURIComponent(SESSION), { cache: 'no-store' }).then((r) => r.json()),
        fetch('/api/audit/verify?session=' + encodeURIComponent(SESSION), { cache: 'no-store' }).then((r) => r.json()),
      ]);
      const doc = {
        format: 'shopz-audit/1', session_id: SESSION, exported_at: new Date().toISOString(), demo_data: !isLive(),
        hash_rule: 'hash = sha256(prev_hash + canonicalJson(event without hash)), keys sorted, genesis = 64 × "0"',
        verify: v, events: a.events || [],
      };
      const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }));
      const link = h('a', { href: url, download: `shopz-audit-${SESSION.slice(0, 8)}.json` });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast(`Exported ${pl((a.events || []).length, 'entry', 'entries')}`, 'info', 1800);
    } catch (err) {
      toast('Export failed: ' + (err && err.message ? err.message : 'network error'), 'error');
    }
  }
  $('verifyBtn').addEventListener('click', verifyAgain);
  $('exportBtn').addEventListener('click', exportAudit);

  /* ------------------------------------------------------------------ SSE */
  let curState = 'IDLE';
  const PURCHASE_STATES = ['VERIFY', 'POLICY', 'APPROVE', 'CHECKOUT'];
  const HANDLERS = {
    state(d) {
      const prev = curState;
      curState = String(d.state || 'IDLE').toUpperCase();
      setStep(curState);
      if (Number.isInteger(d.option_index)) setNarrated(d.option_index);
      else if (['IDLE', 'CLARIFY', 'SEARCH'].includes(curState)) setNarrated(-1);
      if (curState === 'VERIFY' && !PURCHASE_STATES.includes(prev)) {
        clearDecision(); // a new purchase starts
        if ((prev === 'DONE' || prev === 'IDLE') && !Number.isInteger(d.option_index) && options.length) {
          options = []; // e.g. "reorder my usual coffee" – not one of the presented options
          if (cardSet) { cardSet.el.classList.add('stale'); cardSet.el.inert = true; cardSet = null; }
        }
      }
      if (prev === 'APPROVE' && !['APPROVE', 'CHECKOUT', 'DONE', 'CONFIRM'].includes(curState) && decision.policy && !decision.approval) {
        decision.approval = 'denied'; // cancelled or moved on without confirming
        decision.pending = false;
        renderPolicyCard();
      }
      if (['IDLE', 'CLARIFY', 'SEARCH'].includes(curState) && prev === 'DONE') chosen = -1;
      lastEventAt = Date.now();
      armSettle();
      renderQuick();
    },
    'user.utterance': onUserUtterance,
    'agent.say': enqueueSay,
    'speech.cancel': () => stopSpeech(),
    memory(d) { memChips = Array.isArray(d.chips) ? d.chips.filter((c) => c && c.label) : []; renderChips(); },
    constraints(d) { conChips = Array.isArray(d.chips) ? d.chips.filter((c) => c && c.label) : []; renderChips(); },
    options(d) {
      if (d.update && cardSet && cardSet.el.isConnected) {
        options = Array.isArray(d.options) ? d.options : [];
        fill(cardSet.el.querySelector('.cards-meta'), `${options.length} pick${options.length === 1 ? '' : 's'} from real stores · prices read from the store pages · tap a card to hear it`);
        renderCards();
        return;
      }
      options = Array.isArray(d.options) ? d.options : [];
      narrated = -1;
      chosen = -1;
      clearDecision();
      showCards();
      renderQuick();
    },
    policy(d) { showPolicyCard(d); renderQuick(); },
    price_diff(d) {
      decision.priceDiff = d;
      decision.priceAt = Date.now();
      if (d.sku && amount(d.after) !== null) { priceNow[d.sku] = amount(d.after); renderCards(); }
      showPriceCard(d);
    },
    handoff(d) { showHandoffCard(d.handoff || d); refreshVerify(); renderQuick(); },
    order(d) {
      decision.order = d.order || d;
      showOrderCard(decision.order);
      refreshVerify();
    },
    audit(d) { addAudit(d.event || d, true); },
    cart(d) {
      setCartData(d.cart);
      if (d.change === 'added') showCartAdded(d);
      if (d.open) { showCartSummary(d.cart); if (cartItems()) setCart(true); }
    },
    cart_order(d) { showCartOrderCard(d); refreshVerify(); renderQuick(); },
    error(d) { toast((d && d.message) || 'Agent error', 'error'); },
  };

  let es = null;
  let retry = 0;
  let retryTimer = null;
  let wasLive = false;
  function setConn(state) {
    const c = $('conn');
    c.className = 'conn ' + state;
    c.title = state === 'live' ? 'Live' : 'Reconnecting…';
  }
  const USE_POLL = /(^|[?&])poll=1/.test(location.search) || /\.trycloudflare\.com$/.test(location.hostname);
  let pollSince = -1;
  async function pollLoop() {
    for (;;) {
      try {
        const r = await fetch('/api/poll?session=' + encodeURIComponent(SESSION) + '&since=' + pollSince + '&mode=' + encodeURIComponent(MODE), { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        if (!wasLive) { retry = 0; wasLive = true; setConn('live'); backfillAudit(); refreshVerify(); loadCart(); }
        pollSince = j.next;
        for (const ev of j.events || []) {
          const fn = HANDLERS[ev.type];
          if (fn) { try { fn(ev.data || {}); } catch (err) { console.error('[panel] ' + ev.type, err); } }
        }
      } catch {
        if (wasLive) { wasLive = false; toast('Connection to the agent lost – reconnecting…', 'error'); }
        setConn('down');
        await new Promise((res) => setTimeout(res, 1000));
      }
    }
  }
  function connect() {
    if (USE_POLL) { pollLoop(); return; }
    clearTimeout(retryTimer);
    if (es) { try { es.close(); } catch { /* ignore */ } }
    es = new EventSource('/api/events?session=' + encodeURIComponent(SESSION) + '&mode=' + encodeURIComponent(MODE));
    es.onopen = () => {
      retry = 0;
      wasLive = true;
      setConn('live');
      backfillAudit();
      refreshVerify();
      loadCart();
    };
    es.onerror = (e) => {
      if (e && typeof e.data === 'string') return; // a server-sent `event: error` message, not a connection problem
      setConn('down');
      if (wasLive) { wasLive = false; toast('Connection to the agent lost – reconnecting…', 'error'); }
      if (es.readyState === EventSource.CLOSED) {
        retryTimer = setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
      }
    };
    for (const [type, fn] of Object.entries(HANDLERS)) {
      es.addEventListener(type, (msg) => {
        // EventSource fires its own data-less 'error' on connection problems – only real SSE messages carry data.
        if (typeof msg.data !== 'string') return;
        let data = {};
        try { data = msg.data ? JSON.parse(msg.data) : {}; } catch { return; }
        try { fn(data || {}); } catch (err) { console.error('[panel] ' + type, err); }
      });
    }
  }

  /* ------------------------------------------------------------------ input wiring */
  const isTypingTarget = (t) => Boolean(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable));

  function toggleHelp(force) {
    const el = $('help');
    el.hidden = typeof force === 'boolean' ? !force : !el.hidden;
  }

  function priceBump() {
    priceBumpAt = Date.now();
    toast('simulated price change', 'info', 2000);
    post('/api/admin/price-bump', { session_id: SESSION });
  }

  async function resetAll() {
    if (!window.confirm('Reset this session and the demo stores?')) return;
    stopSpeech();
    await post('/api/admin/reset', { session_id: SESSION });
    try { sessionStorage.removeItem('shopz.session_id'); } catch { /* ignore */ }
    location.reload();
  }

  document.addEventListener('keydown', (e) => {
    if (isTypingTarget(e.target)) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (e.code === 'Space' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (!e.repeat) pttStart('key');
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.key === '?') { e.preventDefault(); toggleHelp(); return; }
    if (e.key === 'Escape') { toggleHelp(false); setDrawer(false); setCart(false); return; }
    if (e.code === 'KeyA' && !e.shiftKey) { setDrawer(!drawer.classList.contains('open')); return; }
    if (e.code === 'KeyC' && !e.shiftKey && !isLive()) { setCart(!sheet.classList.contains('open')); return; }
    if (e.code === 'KeyM') { toggleMute(); return; }
    if (e.code === 'KeyP' && e.shiftKey) { e.preventDefault(); priceBump(); return; }
    if (e.code === 'KeyR' && e.shiftKey) { e.preventDefault(); resetAll(); }
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && ptt.active && ptt.src === 'key') {
      e.preventDefault();
      pttEnd('key');
    }
  });
  window.addEventListener('blur', () => pttEnd());
  document.addEventListener('visibilitychange', () => { if (document.hidden) pttEnd(); });

  const mic = $('micBtn');
  mic.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { mic.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    pttStart('pointer');
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((t) => mic.addEventListener(t, () => pttEnd('pointer')));
  mic.addEventListener('contextmenu', (e) => e.preventDefault());

  /** Chips, cards and buttons use the same path as typing: barge in if the agent is talking, then send. */
  async function sendText(text) {
    const t = String(text || '').trim();
    if (!t) return;
    if (isSpeaking()) {
      stopSpeech();
      await post('/api/barge-in', { session_id: SESSION });
    }
    sendUtterance(t);
  }

  const input = $('textInput');
  const syncSend = () => { $('sendBtn').disabled = !input.value.trim(); };
  input.addEventListener('input', syncSend);
  $('textForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    syncSend();
    sendText(text);
  });

  function renderMute() {
    const b = $('muteBtn');
    b.innerHTML = icon(speech.muted ? 'speakerOff' : 'speaker');
    b.setAttribute('aria-pressed', String(speech.muted));
    b.title = speech.muted ? 'Voice off – press M to unmute' : 'Voice on – press M to mute';
    b.setAttribute('aria-label', speech.muted ? 'Unmute the agent voice' : 'Mute the agent voice');
  }
  $('muteBtn').addEventListener('click', (e) => { toggleMute(); e.currentTarget.blur(); });
  $('actBtn').addEventListener('click', (e) => { setDrawer(!drawer.classList.contains('open')); e.currentTarget.blur(); });
  $('drawerClose').innerHTML = icon('x');
  $('drawerClose').addEventListener('click', () => setDrawer(false));
  $('scrim').addEventListener('click', () => { setDrawer(false); setCart(false); });
  $('cartIco').innerHTML = icon('cart');
  $('cartBtn').addEventListener('click', (e) => { setCart(!sheet.classList.contains('open')); e.currentTarget.blur(); });
  $('cartClose').innerHTML = icon('x');
  $('cartClose').addEventListener('click', () => setCart(false));
  /* ------------------------------------------------------------------ mode + allowed stores (live web) */
  function applyMode() {
    document.body.classList.toggle('mode-live', isLive());
    document.querySelectorAll('#modeSwitch button').forEach((b) => {
      b.classList.toggle('on', b.dataset.mode === MODE);
      b.setAttribute('aria-pressed', String(b.dataset.mode === MODE));
    });
    const badge = $('badge');
    if (isLive()) {
      badge.textContent = LIVE_NOTICE;
      badge.title = 'Real stores, read in real time. Shopz never pays or logs in – you check out in the store.';
      badge.classList.add('live');
      $('welcomeText').textContent = 'Talk or type. Shopz searches real stores you allow, reads each product page live and shows every step.';
      const note = $('liveNote');
      note.hidden = false;
      note.textContent = LIVE_NOTICE + '.';
      $('storesSec').hidden = false;
      $('cartBtn').hidden = true;
      loadStores();
    }
    fill($('welcomeChips'), chipButtons(isLive() ? LIVE_CHIPS : START_CHIPS));
  }
  document.querySelectorAll('#modeSwitch button').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.mode === MODE) return;
    try { localStorage.setItem('shopz.mode', b.dataset.mode); } catch { /* ignore */ }
    stopSpeech();
    const u = new URL(location.href);
    u.searchParams.delete('mode');
    location.href = u.pathname + (u.search ? u.search : '') + (u.search ? '&' : '?') + 'mode=' + b.dataset.mode;
  }));
  let stores = [];
  function renderStores() {
    fill($('storeList'), stores.map((st) => h('label', { class: 'store-row' },
      h('input', { type: 'checkbox', checked: st.enabled ? '' : null, onchange: (e) => toggleStore(st.host, e.target.checked) }),
      h('span', { class: 'nm' }, st.name), h('span', { class: 'dom' }, st.label))));
    stores.forEach((st, i) => { const box = $('storeList').children[i]?.querySelector('input'); if (box) box.checked = Boolean(st.enabled); });
  }
  async function loadStores() {
    try {
      const r = await fetch('/api/live/shops?session=' + encodeURIComponent(SESSION));
      stores = (await r.json()).stores || [];
      renderStores();
    } catch { /* drawer stays empty */ }
  }
  async function toggleStore(host, on) {
    const r = await post('/api/live/shops', { session_id: SESSION, [on ? 'enable' : 'disable']: [host] });
    if (r && r.stores) { stores = r.stores; renderStores(); }
  }
  $('storeAdd').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = $('storeInput').value.trim();
    if (!v) return;
    const r = await post('/api/live/shops', { session_id: SESSION, add: v });
    if (r && r.stores) { stores = r.stores; renderStores(); $('storeInput').value = ''; toast('Store added', 'info', 1800); }
  });

  if (!SR && !(navigator.mediaDevices && window.MediaRecorder)) {
    const hint = $('micHint');
    hint.textContent = 'Voice input is not available in this browser – type below';
    hint.classList.add('warn');
    mic.classList.add('disabled');
    mic.title = 'Voice input not available';
  }
  if (window.speechSynthesis && typeof speechSynthesis.addEventListener === 'function') {
    speechSynthesis.addEventListener('voiceschanged', () => { cachedVoice = undefined; });
  }

  /* ------------------------------------------------------------------ start */
  async function start() {
    if (!MODE) {
      try { const c = await (await fetch('/api/config', { cache: 'no-store' })).json(); MODE = c.default_mode === 'live' ? 'live' : 'demo'; } catch { MODE = 'demo'; }
    }
    applyMode();
    // Shopz Companion (companion.js): its event handlers join the stream; it gets the session and a few helpers.
    if (window.ShopzCompanion) {
      Object.assign(HANDLERS, window.ShopzCompanion.handlers);
      window.ShopzCompanion.init({ session: SESSION, mode: () => MODE, post, toast, h, placeInThread, hideWelcome, scrollTurns });
    }
    connect();
  }
  setStep('IDLE');
  renderMute();
  setMicPill();
  setConn('down');
  start();
  refreshVerify();
  setInterval(refreshVerify, 10000);
})();
