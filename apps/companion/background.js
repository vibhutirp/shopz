// Shopz Companion – background service worker.
// Holds the WebSocket to the Shopz server and carries out its commands in ONE tab it opened itself (the "Shopz tab").
// It never reads or controls your other tabs, never types passwords or card numbers, never clicks pay, never solves
// captchas. Sign-in, checks and paying are handed to you; Shopz waits.
/* global ShopzGate */
importScripts('gate.js');

const VERSION = chrome.runtime.getManifest().version;
const NAV_TIMEOUT_MS = 20000;
const MAX_TEXT = 3_000_000;

const st = {
  server: null, // "https://shopz.example" (origin of the panel)
  ws: null,
  status: 'off', // off | connecting | paired | error
  error: null,
  tabId: null,
  groupId: null,
  token: null, // reconnect token after a successful pairing (session storage only)
  turn: null, // { turn_id, kind, message }
  turnTimer: null,
  log: [], // last actions, shown in the popup
};

const isLocalHost = (h) => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/i.test(h);
const allowLocal = () => { try { return isLocalHost(new URL(st.server).hostname); } catch { return false; } };
const wsUrl = (server) => { const u = new URL(server); u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'; u.pathname = '/api/companion/ws'; u.search = ''; u.hash = ''; return u.href; };

function remember(line) {
  st.log.unshift({ t: new Date().toISOString(), line: String(line).slice(0, 140) });
  st.log.length = Math.min(st.log.length, 12);
  broadcast();
}
function publicState() {
  return { status: st.status, error: st.error, server: st.server, tabId: st.tabId, turn: st.turn, log: st.log, version: VERSION };
}
function broadcast() {
  chrome.runtime.sendMessage({ type: 'state', state: publicState() }).catch(() => {});
  const badge = st.status === 'paired' ? (st.turn ? '!' : 'ON') : st.status === 'connecting' ? '…' : '';
  chrome.action.setBadgeText({ text: badge }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: st.turn ? '#f59e0b' : '#1e3a8a' }).catch(() => {});
}

// ------------------------------------------------------------------ connection
function send(obj) {
  if (st.ws && st.ws.readyState === WebSocket.OPEN) { st.ws.send(JSON.stringify(obj)); return true; }
  return false;
}

async function connect({ server, code = null }) {
  disconnect(false);
  st.server = new URL(server).origin;
  st.status = 'connecting';
  st.error = null;
  broadcast();
  await chrome.storage.local.set({ server: st.server });
  const ws = new WebSocket(wsUrl(st.server));
  st.ws = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'hello', code, token: code ? null : st.token, version: VERSION, browser: navigator.userAgent.match(/(Edg|Chrome)\/[\d]+/)?.[0]?.replace('Edg', 'Edge') || 'Chrome', allow_local: allowLocal() }));
  };
  ws.onmessage = (ev) => onServer(ev.data);
  ws.onclose = (ev) => {
    if (st.ws !== ws) return;
    st.ws = null;
    if (st.status === 'paired' && ev.code !== 4000 && st.token) {
      st.status = 'connecting';
      broadcast();
      setTimeout(() => { if (!st.ws && st.token) connect({ server: st.server }).catch(() => {}); }, 1500);
      return;
    }
    st.status = st.status === 'error' ? 'error' : 'off';
    if (ev.code === 4000) { st.token = null; chrome.storage.session.remove('token').catch(() => {}); }
    clearTurn();
    broadcast();
  };
  ws.onerror = () => { if (st.status === 'connecting') { st.error = 'Cannot reach the Shopz server'; st.status = 'error'; broadcast(); } };
}

function disconnect(clearToken = true) {
  if (st.ws) { try { st.ws.close(1000, 'user'); } catch { /* ignore */ } }
  st.ws = null;
  st.status = 'off';
  if (clearToken) { st.token = null; chrome.storage.session.remove('token').catch(() => {}); }
  clearTurn();
  broadcast();
}

async function onServer(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.type === 'paired') {
    st.status = 'paired'; st.error = null;
    if (msg.token) { st.token = msg.token; chrome.storage.session.set({ token: msg.token, server: st.server }).catch(() => {}); }
    remember('Connected to Shopz');
    return;
  }
  if (msg.type === 'pair_failed') { st.status = 'error'; st.error = msg.error || 'Pairing failed'; st.token = null; broadcast(); return; }
  if (msg.type === 'ping') { send({ type: 'pong', t: msg.t }); return; }
  if (msg.type === 'your_turn') { startTurn(msg); return; }
  if (msg.type === 'turn_done') { clearTurn(); return; }
  if (msg.type === 'cmd') {
    try {
      const data = await run(msg.name, msg.args || {});
      send({ type: 'result', id: msg.id, ok: true, data });
    } catch (err) {
      send({ type: 'result', id: msg.id, ok: false, error: String(err && err.message || err), refused: Boolean(err && err.refused) });
    }
  }
}

// ------------------------------------------------------------------ the Shopz tab
async function shopzTab() {
  if (st.tabId !== null) {
    try { const t = await chrome.tabs.get(st.tabId); if (t) return t; } catch { st.tabId = null; }
  }
  return null;
}

async function openTab(url) {
  let t = await shopzTab();
  if (!t) {
    t = await chrome.tabs.create({ url, active: true });
    st.tabId = t.id;
    try {
      st.groupId = await chrome.tabs.group({ tabIds: [t.id] });
      await chrome.tabGroups.update(st.groupId, { title: 'Shopz', color: 'blue' });
    } catch { /* tab groups are optional */ }
  } else {
    await chrome.tabs.update(t.id, { url });
  }
  return waitLoaded(st.tabId, NAV_TIMEOUT_MS);
}

function waitLoaded(tabId, timeoutMs, { started = Date.now() } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = async () => {
      if (done) return; done = true;
      chrome.tabs.onUpdated.removeListener(onUpd);
      clearTimeout(timer);
      try { resolve(await chrome.tabs.get(tabId)); } catch { resolve(null); }
    };
    const onUpd = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    chrome.tabs.onUpdated.addListener(onUpd);
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.get(tabId).then((t) => { if (t && t.status === 'complete' && Date.now() - started > 300) finish(); }).catch(finish);
  });
}

async function inject(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { op: 'ping' });
    if (r && r.ok) return;
  } catch { /* not injected yet */ }
  await chrome.scripting.executeScript({ target: { tabId }, files: ['gate.js', 'content.js'] });
}

async function inTab(op, args = {}) {
  const t = await shopzTab();
  if (!t) throw new Error('the Shopz tab is not open');
  await inject(t.id);
  const r = await chrome.tabs.sendMessage(t.id, { op, args, turn: st.turn });
  if (!r) throw new Error('the page did not answer');
  if (!r.ok) throw Object.assign(new Error(r.error || `${op} failed`), { refused: Boolean(r.refused) });
  return r.data;
}

function refuse(msg) { return Object.assign(new Error(msg), { refused: true }); }

// ------------------------------------------------------------------ commands from the server
async function run(name, a) {
  switch (name) {
    case 'status': {
      const t = await shopzTab();
      return { tab: t ? { url: t.url, title: t.title } : null, version: VERSION };
    }
    case 'fetch': {
      const why = ShopzGate.refuseUrl(a.url, { allowLocal: allowLocal() });
      if (why) throw refuse(why);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      try {
        const res = await fetch(a.url, { credentials: 'include', redirect: 'follow', headers: { accept: a.accept || '*/*' }, signal: ctrl.signal });
        let text = await res.text();
        if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
        if (res.url) { const why2 = ShopzGate.refuseUrl(res.url, { allowLocal: allowLocal() }); if (why2) throw refuse(`redirected to a blocked address (${why2})`); }
        return { status: res.status, url: res.url || a.url, type: res.headers.get('content-type') || '', text, retry_after: res.headers.get('retry-after') };
      } finally { clearTimeout(timer); }
    }
    case 'navigate': {
      const why = ShopzGate.refuseUrl(a.url, { allowLocal: allowLocal() });
      if (why) throw refuse(why);
      remember(`Opening ${new URL(a.url).host}${new URL(a.url).pathname.slice(0, 40)}`);
      const t = await openTab(a.url);
      try { await inTab('badge', { text: `Shopz opened this page` }); } catch { /* page may block scripts (e.g. the web store) */ }
      return { url: t?.url || a.url, title: t?.title || '' };
    }
    case 'read': {
      const d = await inTab('read', {});
      remember(`Read ${d.title ? d.title.slice(0, 50) : 'the page'}`);
      return d;
    }
    case 'snapshot': return inTab('snapshot', a);
    case 'query': return inTab('query', a);
    case 'scroll': return inTab('scroll', a);
    case 'highlight': return inTab('highlight', a);
    case 'fill': {
      const d = await inTab('fill', a);
      remember(`Filled ${a.label || 'a field'}`);
      return d;
    }
    case 'click': {
      const t0 = Date.now();
      const d = await inTab('click', a);
      remember(`Clicked ${a.label || d.label || 'a button'}`);
      const after = await settle(t0);
      if (a.wait_for) await waitFor(a.wait_for, 10000);
      const t = await shopzTab();
      return { ...d, url: t?.url || after?.url || null };
    }
    case 'add_to_cart': {
      const d = await inTab('add_to_cart', a);
      remember(`Added to cart (${d.method})`);
      return d;
    }
    case 'back': {
      const t = await shopzTab();
      if (!t) throw new Error('the Shopz tab is not open');
      await chrome.tabs.goBack(t.id).catch(() => {});
      const r = await waitLoaded(t.id, NAV_TIMEOUT_MS);
      return { url: r?.url || null };
    }
    case 'reload': {
      const t = await shopzTab();
      if (!t) throw new Error('the Shopz tab is not open');
      await chrome.tabs.reload(t.id);
      const r = await waitLoaded(t.id, NAV_TIMEOUT_MS);
      return { url: r?.url || null };
    }
    case 'screenshot': {
      const t = await shopzTab();
      if (!t) throw new Error('the Shopz tab is not open');
      await chrome.tabs.update(t.id, { active: true });
      const image = await chrome.tabs.captureVisibleTab(t.windowId, { format: 'jpeg', quality: 60 });
      return { image, url: t.url };
    }
    default:
      throw refuse(`unknown command ${name}`);
  }
}

/** After a click: if a navigation started, wait for it to finish. */
async function settle(t0) {
  await new Promise((r) => setTimeout(r, 450));
  const t = await shopzTab();
  if (t && t.status === 'loading') return waitLoaded(t.id, NAV_TIMEOUT_MS, { started: t0 });
  return t;
}

async function waitFor(selector, timeoutMs) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try { const d = await inTab('exists', { selector }); if (d.found) return true; } catch { /* page in between loads */ }
    if (Date.now() > end) throw new Error(`${selector} did not appear`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

// ------------------------------------------------------------------ hand-off to the human
function startTurn(msg) {
  clearTurn();
  st.turn = { turn_id: msg.turn_id, kind: msg.kind, message: msg.message };
  remember(msg.message);
  let clear = 0;
  const tick = async () => {
    if (!st.turn) return;
    try {
      const d = await inTab('turn', { show: true, kind: st.turn.kind, message: st.turn.message });
      // Sign-in / check / code: when the page no longer shows it twice in a row, Shopz carries on by itself.
      if (st.turn && st.turn.kind !== 'payment') {
        clear = d.gate && d.gate.kind ? 0 : clear + 1;
        if (clear >= 2) { send({ type: 'event', name: 'gate_cleared', turn_id: st.turn.turn_id, url: d.url }); }
      }
    } catch { /* between page loads */ }
  };
  tick();
  st.turnTimer = setInterval(tick, 1500);
  shopzTab().then((t) => { if (t) chrome.tabs.update(t.id, { active: true }).catch(() => {}); });
  broadcast();
}

function clearTurn() {
  if (st.turnTimer) clearInterval(st.turnTimer);
  st.turnTimer = null;
  const had = st.turn;
  st.turn = null;
  if (had) inTab('turn', { show: false }).catch(() => {});
  broadcast();
}

chrome.tabs.onUpdated.addListener((id, info, tab) => {
  if (id !== st.tabId) return;
  if (info.status === 'complete') send({ type: 'event', name: 'page', url: tab.url, title: tab.title });
});
chrome.tabs.onRemoved.addListener((id) => {
  if (id !== st.tabId) return;
  st.tabId = null;
  send({ type: 'event', name: 'tab_closed' });
});

// ------------------------------------------------------------------ popup + page buttons
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.type === 'get_state') { reply(publicState()); return false; }
  if (msg.type === 'connect') {
    connect({ server: msg.server, code: msg.code }).then(() => reply({ ok: true }), (err) => { st.status = 'error'; st.error = err.message; broadcast(); reply({ ok: false, error: err.message }); });
    return true;
  }
  if (msg.type === 'disconnect') { disconnect(true); reply({ ok: true }); return false; }
  // "I'm done" in the Shopz tab banner (only from the Shopz tab itself).
  if (msg.type === 'turn_button' && sender.tab && sender.tab.id === st.tabId && st.turn) {
    send({ type: 'event', name: 'turn_button', turn_id: st.turn.turn_id });
    reply({ ok: true });
    return false;
  }
  return false;
});

// Keep the link alive across service-worker restarts (reconnect with the session token, never with a stored code).
chrome.alarms.create('shopz-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'shopz-keepalive') return;
  if (st.ws) return;
  const s = await chrome.storage.session.get(['token', 'server']).catch(() => ({}));
  if (s.token && s.server) { st.token = s.token; connect({ server: s.server }).catch(() => {}); }
});
chrome.storage.local.get(['server']).then((s) => { if (s.server && !st.server) st.server = s.server; }).catch(() => {});
