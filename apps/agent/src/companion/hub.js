// Shopz Companion hub: pairs a Chrome extension (the user's own browser) with one panel session and runs browser
// commands on it. The server keeps planning, policy, audit and voice – only the "hands" live in the user's browser.
//
// Pairing: the panel asks for a short code (POST /api/companion/pair), the user types it into the extension, the
// extension opens a WebSocket (/api/companion/ws) and sends { type:'hello', code }. One browser per session.
// Commands: { type:'cmd', id, name, args } → { type:'result', id, ok, data | error }.
// Events from the extension: { type:'event', name: 'gate_cleared' | 'tab_closed' | 'page', ... }.
import { randomBytes, randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GATE_FILE = path.resolve(HERE, '..', '..', '..', 'companion', 'gate.js');

/** The same hand-off rules the extension runs (apps/companion/gate.js), loaded once for the server. */
export function loadGate(file = GATE_FILE) {
  const ctx = { URL };
  ctx.globalThis = ctx;
  vm.runInNewContext(readFileSync(file, 'utf8'), ctx, { filename: file });
  return ctx.ShopzGate;
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const CODE_TTL_MS = 10 * 60 * 1000;
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // reconnect after a service-worker restart without a new code
const HELLO_TIMEOUT_MS = 15000;
const PING_MS = 20000;
const DEAD_MS = 65000;
export const TURN_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_CMD_TIMEOUT = { navigate: 25000, read: 15000, fetch: 15000, click: 15000, fill: 8000, scroll: 6000, highlight: 6000, screenshot: 10000, add_to_cart: 25000, wait_url: 200000, back: 15000, reload: 20000, snapshot: 12000, status: 5000 };
const LOGGED = new Set(['navigate', 'read', 'click', 'fill', 'scroll', 'screenshot', 'add_to_cart', 'back', 'reload']);
export const RESUME_WORDS = /^\s*(done|i'?m done|i am done|ok(ay)?,? done|finished|i'?m finished|continue|go on|go ahead|carry on|i'?m back|logged in|i('?ve| have) logged in|signed in|solved( it)?|fertig|weiter)\b[\s.!]*$/i;

const clip = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ''));
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };

export function makeCode(rand = randomInt) {
  let c = '';
  for (let i = 0; i < 6; i += 1) c += CODE_ALPHABET[rand(CODE_ALPHABET.length)];
  return c;
}
export const normalizeCode = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);

export function createCompanionHub({ audit = null, emit = () => {}, now = () => Date.now(), gate = loadGate(), log = () => {} } = {}) {
  const codes = new Map(); // code → { session_id, expires }
  const links = new Map(); // session_id → link
  const turns = new Map(); // session_id → { turn_id, kind, resolve, timer, url }
  const tokens = new Map(); // reconnect token → { session_id, expires }
  let cmdSeq = 0;
  let turnSeq = 0;

  async function auditLog(session_id, type, actor, summary, data = {}) {
    if (!audit) return null;
    try { return await audit.append(session_id, type, actor, summary, { ...data, via: 'companion' }, {}); } catch { return null; }
  }

  function status(session_id) {
    const l = links.get(String(session_id));
    const t = turns.get(String(session_id));
    return {
      connected: Boolean(l && l.conn.open),
      browser: l ? l.browser : null,
      extension_version: l ? l.version : null,
      since: l ? new Date(l.since).toISOString() : null,
      tab_url: l ? l.tabUrl : null,
      your_turn: t ? { turn_id: t.turn_id, kind: t.kind, url: t.url, message: t.message } : null,
    };
  }
  const pushStatus = (session_id) => emit(session_id, 'companion', status(session_id));

  /** New pairing code for a session (replaces an older unused code of the same session). */
  function pair(session_id) {
    const s = String(session_id);
    for (const [c, v] of codes) if (v.session_id === s || v.expires < now()) codes.delete(c);
    let code;
    do { code = makeCode(); } while (codes.has(code));
    const expires = now() + CODE_TTL_MS;
    codes.set(code, { session_id: s, expires });
    return { code, expires_at: new Date(expires).toISOString(), ttl_s: CODE_TTL_MS / 1000 };
  }

  /** A fresh WebSocket from an extension. It must say hello with a valid code within 15 s. */
  function attach(conn, { remoteAddress = '' } = {}) {
    let link = null;
    const helloTimer = setTimeout(() => { if (!link) conn.close(4001, 'no pairing code'); }, HELLO_TIMEOUT_MS);
    helloTimer.unref?.();
    conn.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { conn.close(1003, 'json only'); return; }
      if (!msg || typeof msg !== 'object') return;
      if (!link) {
        if (msg.type !== 'hello') { conn.close(4001, 'say hello first'); return; }
        const code = normalizeCode(msg.code);
        const byToken = !code && typeof msg.token === 'string' ? tokens.get(msg.token) : null;
        const entry = byToken || codes.get(code);
        if (!entry || entry.expires < now()) {
          conn.send(JSON.stringify({ type: 'pair_failed', error: byToken === null && !code ? 'Please pair again with a new code from the Shopz panel.' : 'This code is wrong or expired. Get a new one in the Shopz panel.' }));
          conn.close(4003, 'bad code');
          return;
        }
        if (byToken) tokens.delete(msg.token); else codes.delete(code); // one use each
        const token = randomBytes(18).toString('base64url');
        tokens.set(token, { session_id: entry.session_id, expires: now() + TOKEN_TTL_MS });
        for (const [k, v] of tokens) if (v.expires < now()) tokens.delete(k);
        clearTimeout(helloTimer);
        const old = links.get(entry.session_id);
        if (old && old.conn !== conn) { try { old.conn.close(4000, 'replaced by a new browser'); } catch { /* ignore */ } }
        link = {
          session_id: entry.session_id, conn, pending: new Map(), since: now(), version: clip(msg.version || '', 20),
          browser: clip(msg.browser || 'Chrome', 60), tabUrl: null, remoteAddress, allowLocal: Boolean(msg.allow_local),
        };
        links.set(entry.session_id, link);
        conn.send(JSON.stringify({ type: 'paired', token, session: entry.session_id.slice(0, 8), server_time: new Date(now()).toISOString() }));
        log(`${byToken ? 're' : ''}paired session ${entry.session_id.slice(0, 8)} (${link.browser})`);
        auditLog(entry.session_id, 'companion_connected', 'user', byToken ? `Your browser reconnected (${link.browser})` : `Your browser is connected (${link.browser})`, { browser: link.browser, extension_version: link.version, reconnect: Boolean(byToken) });
        pushStatus(entry.session_id);
        link.pingTimer = setInterval(() => {
          if (now() - conn.lastSeen > DEAD_MS) { conn.close(4008, 'no heartbeat'); return; }
          conn.ping();
          conn.send(JSON.stringify({ type: 'ping', t: now() }));
        }, PING_MS);
        link.pingTimer.unref?.();
        return;
      }
      if (msg.type === 'result' && msg.id && link.pending.has(msg.id)) {
        const p = link.pending.get(msg.id);
        link.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.data ?? {});
        else p.reject(Object.assign(new Error(clip(msg.error || 'browser command failed', 300)), { refused: Boolean(msg.refused), code: msg.code || null }));
        return;
      }
      if (msg.type === 'event') onEvent(link, msg);
    });
    conn.on('close', () => {
      clearTimeout(helloTimer);
      if (!link) return;
      clearInterval(link.pingTimer);
      for (const p of link.pending.values()) { clearTimeout(p.timer); p.reject(Object.assign(new Error('your browser disconnected'), { disconnected: true })); }
      link.pending.clear();
      if (links.get(link.session_id) === link) {
        links.delete(link.session_id);
        auditLog(link.session_id, 'companion_disconnected', 'system', 'Your browser disconnected – Shopz works from the server again', {});
        const t = turns.get(link.session_id);
        if (t) finishTurn(link.session_id, 'disconnected');
        pushStatus(link.session_id);
      }
    });
  }

  function onEvent(link, msg) {
    const s = link.session_id;
    if (msg.name === 'page' && msg.url) {
      link.tabUrl = clip(msg.url, 400);
      emit(s, 'companion.page', { url: link.tabUrl, title: clip(msg.title || '', 120) });
      const t = turns.get(s);
      if (t && t.kind === 'payment' && /(thank[_-]?you|\/orders?\/|order[-_]?confirm|\/order\/)/i.test(msg.url)) {
        finishTurn(s, 'order_page', { url: msg.url });
      }
      return;
    }
    if (msg.name === 'gate_cleared') {
      const t = turns.get(s);
      if (t && (!msg.turn_id || msg.turn_id === t.turn_id)) finishTurn(s, 'auto', { url: msg.url || null });
      return;
    }
    if (msg.name === 'turn_button') {
      const t = turns.get(s);
      if (t && (!msg.turn_id || msg.turn_id === t.turn_id)) finishTurn(s, 'tab_button');
      return;
    }
    if (msg.name === 'tab_closed') {
      link.tabUrl = null;
      const t = turns.get(s);
      if (t) finishTurn(s, 'tab_closed');
      pushStatus(s);
    }
  }

  /** Remote control for one session, or null when no browser is paired. */
  function remote(session_id) {
    const s = String(session_id);
    const link = links.get(s);
    if (!link || !link.conn.open) return null;
    return {
      session_id: s,
      browser: link.browser,
      allowLocal: link.allowLocal,
      get connected() { return link.conn.open; },
      cmd: (name, args = {}, opts = {}) => command(link, name, args, opts),
      yourTurn: (opts) => yourTurn(s, opts),
    };
  }

  function command(link, name, args, { timeoutMs = DEFAULT_CMD_TIMEOUT[name] || 15000, summary = null } = {}) {
    if (!link.conn.open) return Promise.reject(Object.assign(new Error('your browser disconnected'), { disconnected: true }));
    const id = `c${++cmdSeq}`;
    const s = link.session_id;
    const shown = summary || describe(name, args);
    if (LOGGED.has(name)) emit(s, 'companion.action', { id, name, summary: shown, url: args.url || link.tabUrl || null, state: 'start' });
    const t0 = now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        link.pending.delete(id);
        reject(Object.assign(new Error(`your browser did not answer "${name}" within ${Math.round(timeoutMs / 1000)} s`), { timeout: true }));
      }, timeoutMs);
      timer.unref?.();
      link.pending.set(id, { resolve, reject, timer });
      if (!link.conn.send(JSON.stringify({ type: 'cmd', id, name, args }))) {
        clearTimeout(timer); link.pending.delete(id);
        reject(Object.assign(new Error('your browser disconnected'), { disconnected: true }));
      }
    }).then(async (data) => {
      if (data && data.url) link.tabUrl = clip(data.url, 400);
      if (LOGGED.has(name)) {
        emit(s, 'companion.action', { id, name, summary: shown, url: data?.url || args.url || null, state: 'done', ms: now() - t0 });
        await auditLog(s, 'browser_action', 'agent', `In your browser: ${shown}`, { action: name, url: data?.url || args.url || null, ms: now() - t0, ok: true, ...(data?.gate?.kind ? { gate: data.gate.kind } : {}) });
      }
      return data;
    }, async (err) => {
      if (LOGGED.has(name) || err.refused) {
        emit(s, 'companion.action', { id, name, summary: shown, url: args.url || null, state: err.refused ? 'refused' : 'failed', error: clip(err.message, 160) });
        await auditLog(s, err.refused ? 'browser_action_refused' : 'browser_action', 'agent', err.refused ? `Refused in your browser: ${shown} (${clip(err.message, 100)})` : `In your browser: ${shown} failed (${clip(err.message, 100)})`, { action: name, url: args.url || null, ok: false, refused: Boolean(err.refused), error: clip(err.message, 200) });
      }
      throw err;
    });
  }

  function describe(name, a) {
    switch (name) {
      case 'navigate': return `opened ${hostOf(a.url)}${(() => { try { return new URL(a.url).pathname.slice(0, 60); } catch { return ''; } })()}`;
      case 'read': return 'read the page (text + product data)';
      case 'click': return `clicked ${a.label ? `"${clip(a.label, 40)}"` : a.selector ? clip(a.selector, 40) : 'an element'}`;
      case 'fill': return `filled ${a.label || a.selector || 'a field'}`;
      case 'scroll': return `scrolled to ${a.section || a.selector || 'the section'}`;
      case 'screenshot': return 'took a screenshot of the Shopz tab';
      case 'add_to_cart': return 'added the item to the store cart';
      case 'back': return 'went back';
      case 'reload': return 'reloaded the page';
      default: return name;
    }
  }

  /**
   * Hand the tab to the human (login, captcha, 2FA, payment). Resolves { resumed_by, ms } when the user says/taps
   * "done", the extension sees the check is gone, or (payment) the store shows an order page. wait:false = do not block.
   */
  function yourTurn(session_id, { kind, url = null, reason = null, wait = true, timeoutMs = TURN_TIMEOUT_MS } = {}) {
    const s = String(session_id);
    const old = turns.get(s);
    if (old) finishTurn(s, 'replaced');
    const turn_id = `turn_${++turnSeq}`;
    const message = gate.MESSAGES[kind] || 'Your turn in the Shopz tab.';
    const startedAt = now();
    const promise = new Promise((resolve) => {
      const timer = wait ? setTimeout(() => finishTurn(s, 'timeout'), timeoutMs) : null;
      timer?.unref?.();
      turns.set(s, { turn_id, kind, url, message, resolve, timer, startedAt, wait });
    });
    auditLog(s, 'human_handoff', 'agent', `Handed the tab to you: ${kind === 'payment' ? 'paying' : kind === 'captcha' ? 'a bot check' : kind === '2fa' ? 'a verification code' : 'signing in'}${url ? ` at ${hostOf(url)}` : ''}`, { kind, url, reason, turn_id, agent_waits: Boolean(wait) });
    emit(s, 'companion.your_turn', { turn_id, kind, url, message, wait: Boolean(wait) });
    const l = links.get(s);
    if (l && l.conn.open) l.conn.send(JSON.stringify({ type: 'your_turn', turn_id, kind, message }));
    return wait ? promise : Promise.resolve({ resumed_by: null, waiting: false, turn_id });
  }

  function finishTurn(session_id, by, extra = {}) {
    const s = String(session_id);
    const t = turns.get(s);
    if (!t) return false;
    turns.delete(s);
    clearTimeout(t.timer);
    const ms = now() - t.startedAt;
    const ok = !['timeout', 'disconnected', 'tab_closed', 'replaced'].includes(by);
    auditLog(s, 'human_resumed', ok ? 'user' : 'system', ok ? `You finished (${t.kind === 'payment' ? 'payment step' : t.kind}) – ${by === 'auto' ? 'Shopz saw the check is gone' : by === 'order_page' ? 'the store shows an order page' : by === 'voice' ? 'you said done' : 'you tapped done'}` : `Hand-off ended: ${by.replace('_', ' ')}`, { kind: t.kind, turn_id: t.turn_id, resumed_by: by, ms, ...extra });
    emit(s, 'companion.turn_done', { turn_id: t.turn_id, kind: t.kind, resumed_by: by, ok });
    const l = links.get(s);
    if (l && l.conn.open) l.conn.send(JSON.stringify({ type: 'turn_done', turn_id: t.turn_id }));
    t.resolve({ resumed_by: by, ok, ms, ...extra });
    return true;
  }

  /** Panel button "I'm done" or a "done"/"continue" utterance while a hand-off is open. */
  function resume(session_id, by = 'button') { return finishTurn(session_id, by); }
  const pendingTurn = (session_id) => { const t = turns.get(String(session_id)); return t ? { turn_id: t.turn_id, kind: t.kind, wait: t.wait } : null; };

  function unpair(session_id) {
    const l = links.get(String(session_id));
    if (l) l.conn.close(4000, 'disconnected in the panel');
    for (const [c, v] of codes) if (v.session_id === String(session_id)) codes.delete(c);
    for (const [k, v] of tokens) if (v.session_id === String(session_id)) tokens.delete(k);
    return { ok: true };
  }

  /** The demo stores (one presenter laptop): the most recently paired browser whose session is in demo mode. */
  function latest(filter = () => true) {
    let best = null;
    for (const l of links.values()) if (l.conn.open && filter(l.session_id) && (!best || l.since > best.since)) best = l;
    return best ? remote(best.session_id) : null;
  }

  return { pair, attach, remote, status, resume, pendingTurn, unpair, latest, yourTurn, gate, isResumeWord: (t) => RESUME_WORDS.test(String(t || '')) };
}
