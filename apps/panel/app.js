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
    checkout_step: 'cart', order_confirmed: 'box', error: 'alert', fallback_used: 'reload',
  };
  function toneOf(ev) {
    const t = ev.type;
    if (t === 'policy_decision') {
      const d = String(findKey(ev.data, 'decision') || '').toUpperCase();
      return d === 'AUTO_APPROVE' ? 'good' : d === 'DENY' ? 'bad' : 'warn';
    }
    if (t === 'approval_granted' || t === 'order_confirmed') return 'good';
    if (t === 'error' || t === 'injection_ignored' || t === 'approval_denied') return 'bad';
    if (['approval_requested', 'price_observed', 'answer_not_on_page', 'fallback_used'].includes(t)) return 'warn';
    if (ev.actor === 'user' || ['utterance', 'user_interrupt', 'barge_in'].includes(t)) return 'user';
    return 'neutral';
  }

  /* ------------------------------------------------------------------ transcript */
  const MAX_TURNS = 6;
  const turnsEl = $('turns');
  let agentTurn = null; // { el, body } – consecutive agent sentences are grouped into one turn
  let interimTurn = null;
  const pendingUser = []; // turns we sent ourselves, matched against the agent's user.utterance echo

  function scrollTurns() { turnsEl.scrollTop = turnsEl.scrollHeight; }
  function pruneTurns() {
    const all = Array.from(turnsEl.querySelectorAll('.turn:not(.interim)'));
    for (let i = 0; i < all.length - MAX_TURNS; i++) all[i].remove();
  }
  function addTurn(who, text, interim = false) {
    const empty = $('turnsEmpty');
    if (empty) empty.remove();
    const body = h('div', { class: 'bubble' }, text || '');
    const el = h('div', { class: `turn turn-${who}` + (interim ? ' interim' : '') }, body);
    // settled turns go above a live interim bubble, so the bubble stays at the bottom
    turnsEl.insertBefore(el, interimTurn && !interim ? interimTurn.el : null);
    pruneTurns();
    scrollTurns();
    return { el, body };
  }
  function lastSettledTurn() {
    const all = turnsEl.querySelectorAll('.turn:not(.interim)');
    return all.length ? all[all.length - 1] : null;
  }
  function agentSentence(text) {
    if (!agentTurn || lastSettledTurn() !== agentTurn.el || !agentTurn.el.isConnected) agentTurn = addTurn('agent', '');
    agentTurn.body.querySelectorAll('.sent.live').forEach((s) => s.classList.remove('live'));
    if (agentTurn.body.childNodes.length) agentTurn.body.append(' ');
    agentTurn.body.append(h('span', { class: 'sent live' }, text));
    pruneTurns();
    scrollTurns();
  }
  function endLiveSentence() { turnsEl.querySelectorAll('.sent.live').forEach((s) => s.classList.remove('live')); }

  function showInterim(text) {
    if (!interimTurn) interimTurn = addTurn('user', '', true);
    interimTurn.body.replaceChildren();
    if (text) interimTurn.body.textContent = text;
    else interimTurn.body.append(h('span', { class: 'dots', 'aria-label': 'listening' }, h('i'), h('i'), h('i')));
    scrollTurns();
  }
  function settleInterim(text) {
    const t = interimTurn;
    interimTurn = null;
    if (!t) return null;
    if (!text) { t.el.remove(); return null; }
    t.el.className = 'turn turn-user';
    t.body.textContent = text;
    pruneTurns();
    scrollTurns();
    return t;
  }
  function onUserUtterance(d) {
    const text = d && d.text ? String(d.text) : '';
    if (!text) return;
    const now = Date.now();
    while (pendingUser.length && now - pendingUser[0].at > 20000) pendingUser.shift();
    const mine = pendingUser.shift();
    if (mine && mine.turn.el.isConnected) { mine.turn.body.textContent = text; return; }
    addTurn('user', text);
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
    speech.queue.slice(0, 3).forEach(fetchTts);
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
    $('mutedTag').hidden = !speech.muted;
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
    const t = turn || addTurn('user', text);
    pendingUser.push({ turn: t, at: Date.now() });
    const r = await post('/api/utterance', { session_id: SESSION, text });
    if (!r) t.el.classList.add('failed');
  }

  /* ------------------------------------------------------------------ step bar */
  const STEPS = ['CLARIFY', 'SEARCH', 'NARRATE', 'CHOOSE', 'VERIFY', 'POLICY', 'APPROVE', 'CHECKOUT', 'DONE'];
  const STATE_TO_STEP = { AWAIT_CHOICE: 'CHOOSE', SELECT: 'CHOOSE', NAVIGATE: 'NARRATE', ANSWER: 'NARRATE', CONFIRM: 'DONE' };
  const stepEls = [];
  (function buildSteps() {
    const nav = $('steps');
    STEPS.forEach((s, i) => {
      if (i) nav.append(h('span', { class: 'step-sep', 'aria-hidden': 'true' }, '›'));
      const el = h('span', { class: 'step' }, s);
      stepEls.push(el);
      nav.append(el);
    });
  })();
  function setStep(state) {
    const step = STATE_TO_STEP[state] || state;
    const idx = STEPS.indexOf(step);
    stepEls.forEach((el, i) => {
      el.classList.toggle('now', i === idx);
      el.classList.toggle('past', idx >= 0 && i < idx);
    });
  }

  /* ------------------------------------------------------------------ chips */
  let memChips = [];
  let conChips = [];
  function renderChips() {
    const box = $('chips');
    box.replaceChildren();
    if (!memChips.length && !conChips.length) { box.hidden = true; return; }
    box.hidden = false;
    if (memChips.length) {
      box.append(h('span', { class: 'chips-label' }, 'Memory'));
      for (const c of memChips) {
        const src = c.source || 'seeded profile';
        box.append(h('span', { class: 'chip mem' + (src === 'learned' ? ' learned' : '') },
          h('span', null, c.label), h('span', { class: 'chip-tag' }, src)));
      }
    }
    if (conChips.length) {
      if (memChips.length) box.append(h('span', { class: 'chips-gap' }));
      box.append(h('span', { class: 'chips-label' }, 'Constraints'));
      for (const c of conChips) box.append(h('span', { class: 'chip con' }, c.label));
    }
  }

  /* ------------------------------------------------------------------ options */
  let options = [];
  let narrated = -1;
  const priceNow = {}; // sku → re-checked price from price_diff
  function renderOptions() {
    const box = $('options');
    const rows = $('optionRows');
    rows.replaceChildren();
    if (!options.length) { box.hidden = true; return; }
    box.hidden = false;
    $('optionsMeta').textContent = `${options.length} pick${options.length === 1 ? '' : 's'} · ranked`;
    options.forEach((o, i) => {
      const r = o.rating || {};
      const cur = (o.price && o.price.currency) || 'USD';
      const changed = Boolean(o.sku) && priceNow[o.sku] !== undefined;
      const etaIso = o.delivery && o.delivery.eta_date;
      const tip = [
        o.title,
        r.stars !== undefined && r.stars !== null ? `★ ${r.stars}${r.count ? ` (${fmtInt(r.count)} reviews)` : ''}` : null,
        etaIso ? `arrives ${niceDate(etaIso)}` : null,
        o.rank && isNum(o.rank.score) ? `score ${o.rank.score.toFixed(2)}` : null,
        o.why,
      ].filter(Boolean).join(' · ');
      rows.append(h('div', { class: 'opt' + (i === narrated ? ' on' : ''), title: tip },
        h('div', { class: 'opt-rank' }, String((o.rank && o.rank.position) || i + 1)),
        h('div', { class: 'opt-title' }, o.title || o.sku || 'Option'),
        h('div', { class: 'opt-store' }, o.store_name || storeName(o.merchant_id) || ''),
        h('div', { class: 'opt-amt' + (changed ? ' up' : '') }, money(changed ? priceNow[o.sku] : o.price, cur)),
        h('div', { class: 'opt-eta' }, etaIso ? `arrives ${weekday(etaIso)}` : ''),
        h('div', { class: 'opt-why' }, o.why || '')));
    });
  }
  function setNarrated(i) {
    narrated = Number.isInteger(i) ? i : -1;
    $('optionRows').querySelectorAll('.opt').forEach((el, k) => el.classList.toggle('on', k === narrated));
  }

  /* ------------------------------------------------------------------ policy / price diff / order */
  const decision = { policy: null, approval: null, priceDiff: null, priceAt: 0, policyAt: 0, order: null };
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

  function renderDecision() {
    const zone = $('decision');
    const pc = $('policyCard');
    const pd = $('priceCard');
    const oc = $('orderCard');

    // policy
    const p = decision.policy;
    if (p) {
      const inp = p.inputs || {};
      const dec = String(p.decision || '').toUpperCase();
      const cls = dec === 'AUTO_APPROVE' ? 'dec-auto' : dec === 'DENY' ? 'dec-deny' : 'dec-req';
      const cur = p.currency || (inp.totals && inp.totals.currency) || 'USD';
      const c = {
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
      };
      const rules = Array.isArray(p.rules) ? p.rules : [];
      const lines = rules.map((r) => h('li', { class: DENY_RULES.has(r) ? 'deny' : '' }, ruleText(r, c)));
      if (!lines.length && dec === 'AUTO_APPROVE') {
        lines.push(h('li', { class: 'ok' }, c.limit !== null
          ? `Total ${money(c.total, cur)} is within your ${money(c.limit, cur, true)} auto-buy limit`
          : 'Within your auto-buy rules'));
        if (c.merchant) lines.push(h('li', { class: 'ok' }, `${c.merchant} is an approved store`));
      }
      let hint = null;
      if (dec === 'REQUIRE_APPROVAL') {
        if (decision.approval === 'granted') hint = h('div', { class: 'pc-hint done' }, 'Approved by voice ✓');
        else if (decision.approval === 'denied') hint = h('div', { class: 'pc-hint denied' }, 'Not approved');
        else hint = h('div', { class: 'pc-hint' }, 'Say “confirm purchase”');
      }
      const meta = [
        c.merchant,
        c.qty !== null ? `qty ${c.qty}` : null,
        isNum(Number(inp.orders_today)) && inp.orders_today !== null ? `orders today ${inp.orders_today}${c.maxDay !== null ? '/' + c.maxDay : ''}` : null,
        first(inp.policy_version, inp.version) !== null ? `policy v${first(inp.policy_version, inp.version)}` : null,
      ].filter(Boolean).join(' · ');
      pc.className = 'card policy ' + cls;
      fill(pc,
        h('div', { class: 'card-top' }, h('span', { class: 'card-title' }, 'Purchase policy'), h('span', { class: 'dec-pill' }, dec || '—')),
        h('div', { class: 'pc-total' }, h('b', null, money(c.total, cur)),
          h('span', null, c.limit !== null ? `total · auto-buy limit ${money(c.limit, cur, true)}` : 'total')),
        lines.length ? h('ul', { class: 'rules' }, lines) : null,
        hint,
        meta ? h('div', { class: 'pc-inputs' }, meta) : null,
      );
      pc.hidden = false;
    } else {
      pc.hidden = true;
    }

    // price diff
    const d = decision.priceDiff;
    if (d) {
      const before = amount(d.before);
      const after = amount(d.after);
      const cur = (d.before && d.before.currency) || (d.after && d.after.currency) || d.currency || 'USD';
      const delta = before !== null && after !== null ? after - before : null;
      const simulated = d.simulated === true || (priceBumpAt && Date.now() - priceBumpAt < 10 * 60 * 1000);
      fill(pd,
        h('div', { class: 'card-top' }, h('span', { class: 'card-title' }, 'Price changed'), simulated ? h('span', { class: 'tag sim' }, 'simulated') : null),
        h('div', { class: 'pd-title' }, d.title || d.sku || ''),
        h('div', { class: 'pd-prices' },
          h('s', null, money(before, cur)), h('span', { class: 'arrow' }, '→'), h('b', null, money(after, cur)),
          delta !== null && Math.abs(delta) >= 0.005
            ? h('span', { class: 'delta' + (delta < 0 ? ' down' : '') }, (delta > 0 ? '+' : '−') + money(Math.abs(delta), cur))
            : null),
        h('div', { class: 'pd-ts' },
          h('span', null, 'first seen ', h('b', null, hms(d.before_ts))),
          h('span', null, 'now ', h('b', null, hms(d.after_ts)))),
      );
      pd.hidden = false;
    } else {
      pd.hidden = true;
    }

    // order
    const o = decision.order;
    if (o) {
      const t = o.totals || {};
      const ap = o.approval || {};
      const mode = ap.mode === 'user_explicit'
        ? `you, by ${ap.channel || 'voice'}${ap.transcript ? ` · “${ap.transcript}”` : ''}`
        : ap.mode === 'auto' ? 'auto · within policy' : (ap.mode || '—');
      const it0 = Array.isArray(o.items) && o.items[0] ? o.items[0] : null;
      const item = it0 ? `${it0.title || it0.sku}${it0.qty > 1 ? ` × ${it0.qty}` : ''}` : null;
      fill(oc,
        h('div', { class: 'od-id' }, h('span', { class: 'card-title' }, 'Order'), h('b', null, o.order_id || '—'),
          h('span', { class: 'ok' }, `✓ ${o.status || 'confirmed'}`), h('span', { class: 'od-total' }, money(t.total, t.currency))),
        h('div', { class: 'od-item' }, h('span', { title: item || '' }, item || ''),
          o.demo_data !== false ? h('span', { class: 'tag' }, 'demo order') : null),
        h('div', { class: 'od-meta' }, 'Arrives ', h('b', null, niceDate(o.delivery_eta)), ' · executor ', h('code', null, o.executor || '—')),
        h('div', { class: 'od-meta', title: mode }, 'Approval ', h('b', null, mode)),
      );
      oc.hidden = false;
    } else {
      oc.hidden = true;
    }

    zone.classList.toggle('has-policy', Boolean(p));
    zone.hidden = !(p || d || o);
  }

  function clearDecision() {
    const now = Date.now();
    if (now - decision.priceAt > 2000) decision.priceDiff = null;
    if (now - decision.policyAt > 2000) { decision.policy = null; decision.approval = null; }
    decision.order = null;
    renderDecision();
  }

  /* ------------------------------------------------------------------ audit timeline */
  const tl = $('tl');
  const rowsByKey = new Map();
  const MAX_ROWS = 500;

  function buildRow(ev) {
    const data = ev.data || {};
    const quote = findKey(data, 'quoted_span');
    const sha = first(findKey(data, 'snapshot_sha256'), data.snapshot && data.snapshot.sha256);
    const tone = toneOf(ev);
    const row = h('div', { class: `ev tone-${tone}` });
    row.dataset.seq = isNum(ev.seq) ? String(ev.seq) : '';
    const line = h('div', { class: 'ev-line', role: 'button', title: 'Show details' },
      h('span', { class: 'ev-time' }, hms(ev.ts)),
      h('span', { class: 'ev-ico', html: icon(TYPE_ICON[ev.type] || 'dot') }),
      h('span', { class: 'ev-type' }, ev.type || 'event'),
      h('span', { class: 'ev-sum', title: ev.summary || null }, ev.summary || ''),
      h('span', { class: 'ev-seq' }, isNum(ev.seq) ? '#' + ev.seq : ''));
    row.append(line);
    if (quote || sha) {
      row.append(h('div', { class: 'ev-extra' },
        quote ? h('span', { class: 'ev-quote' }, `“${quote}”`) : null,
        sha ? h('span', { class: 'ev-sha' }, 'sha256 ' + short(sha)) : null));
    }
    line.addEventListener('click', () => toggleRow(row, ev, quote, sha));
    return row;
  }

  function toggleRow(row, ev, quote, sha) {
    if (!row.querySelector('.ev-detail')) {
      const data = ev.data || {};
      const snapId = first(findKey(data, 'snapshot_id'));
      row.append(h('div', { class: 'ev-detail' },
        quote ? h('div', { class: 'evd-quote' }, h('span', { class: 'evd-label' }, 'Quoted from the page'), h('blockquote', null, `“${quote}”`)) : null,
        sha ? h('div', { class: 'evd-sha' }, h('span', { class: 'evd-label' }, 'Page snapshot sha256' + (snapId ? ' · ' + snapId : '')), h('code', null, String(sha))) : null,
        h('pre', { class: 'evd-json', html: highlightJson(data) }),
        h('div', { class: 'evd-chain' },
          [ev.event_id, ev.actor ? 'actor ' + ev.actor : null, 'hash ' + short(ev.hash), 'prev ' + short(ev.prev_hash)].filter(Boolean).join(' · '))));
    }
    row.classList.toggle('open');
  }

  function addAudit(ev, fresh) {
    if (!ev || typeof ev !== 'object') return;
    const key = first(ev.event_id, isNum(ev.seq) ? 'seq' + ev.seq : null, ev.hash);
    if (key !== null && rowsByKey.has(key)) return;
    const empty = $('tlEmpty');
    if (empty) empty.remove();
    const row = buildRow(ev);
    if (key !== null) rowsByKey.set(key, row);

    // newest first, ordered by seq; keep the reader's place if they scrolled down
    const seq = isNum(ev.seq) ? ev.seq : Infinity;
    let before = null;
    for (const r of tl.children) {
      const s = r.dataset && r.dataset.seq !== '' ? Number(r.dataset.seq) : Infinity;
      if (s < seq) { before = r; break; }
    }
    const keepPlace = tl.scrollTop > 4;
    const oldHeight = tl.scrollHeight;
    tl.insertBefore(row, before);
    if (keepPlace && row.getBoundingClientRect().top < tl.getBoundingClientRect().top) {
      tl.scrollTop += tl.scrollHeight - oldHeight;
    }
    if (fresh) row.classList.add('fresh');
    while (tl.children.length > MAX_ROWS) tl.lastElementChild.remove();

    if (ev.type === 'approval_granted' || ev.type === 'approval_denied') {
      if (decision.policy) { decision.approval = ev.type === 'approval_granted' ? 'granted' : 'denied'; renderDecision(); }
    }
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

  /* ------------------------------------------------------------------ hash chain footer */
  let verifyDebounce = null;
  let verifyFailed = false;
  function scheduleVerify() {
    clearTimeout(verifyDebounce);
    verifyDebounce = setTimeout(refreshVerify, 1200);
  }
  async function refreshVerify() {
    const el = $('chain');
    try {
      const r = await fetch('/api/audit/verify?session=' + encodeURIComponent(SESSION));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const v = await r.json();
      verifyFailed = false;
      const n = Number(v.count) || 0;
      el.className = 'chain ' + (v.ok ? 'ok' : 'bad');
      fill(el,
        h('span', { class: 'chain-main' }, v.ok
          ? `Hash chain verified ✓ (${n} event${n === 1 ? '' : 's'})`
          : `✗ chain broken at #${first(v.bad_seq, '?')}`),
        v.head_hash ? h('span', { class: 'chain-head', title: v.head_hash }, 'head ' + short(v.head_hash)) : null);
    } catch (err) {
      el.className = 'chain unk';
      el.replaceChildren(h('span', { class: 'chain-main' }, 'Hash chain: not reachable'));
      if (!verifyFailed) toast('Audit check failed: ' + (err && err.message ? err.message : 'network error'), 'error');
      verifyFailed = true;
    }
  }

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
        clearDecision(); // a new purchase starts: cards of the previous one are stale
        if ((prev === 'DONE' || prev === 'IDLE') && !Number.isInteger(d.option_index) && options.length) {
          options = []; // e.g. "reorder my usual coffee" – not one of the presented options
          renderOptions();
        }
      }
    },
    'user.utterance': onUserUtterance,
    'agent.say': enqueueSay,
    'speech.cancel': () => stopSpeech(),
    memory(d) { memChips = Array.isArray(d.chips) ? d.chips.filter((c) => c && c.label) : []; renderChips(); },
    constraints(d) { conChips = Array.isArray(d.chips) ? d.chips.filter((c) => c && c.label) : []; renderChips(); },
    options(d) {
      options = Array.isArray(d.options) ? d.options : [];
      narrated = -1;
      renderOptions();
      clearDecision();
    },
    policy(d) { decision.policy = d; decision.approval = null; decision.policyAt = Date.now(); renderDecision(); },
    price_diff(d) {
      decision.priceDiff = d;
      decision.priceAt = Date.now();
      if (d.sku && amount(d.after) !== null) { priceNow[d.sku] = amount(d.after); renderOptions(); }
      renderDecision();
    },
    order(d) {
      decision.order = d.order || d;
      renderDecision();
      refreshVerify();
    },
    audit(d) { addAudit(d.event || d, true); },
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
        const r = await fetch('/api/poll?session=' + encodeURIComponent(SESSION) + '&since=' + pollSince, { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        if (!wasLive) { retry = 0; wasLive = true; setConn('live'); backfillAudit(); refreshVerify(); }
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
    es = new EventSource('/api/events?session=' + encodeURIComponent(SESSION));
    es.onopen = () => {
      retry = 0;
      wasLive = true;
      setConn('live');
      backfillAudit();
      refreshVerify();
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
    if (e.key === 'Escape') { toggleHelp(false); return; }
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

  $('textForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('textInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    if (isSpeaking()) {
      stopSpeech();
      await post('/api/barge-in', { session_id: SESSION });
    }
    sendUtterance(text);
  });

  if (!SR) {
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
  setStep('IDLE');
  setMicPill();
  setConn('down');
  connect();
  refreshVerify();
  setInterval(refreshVerify, 10000);
})();
