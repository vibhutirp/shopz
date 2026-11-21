// Shopz agent server (plain node:http): panel static files, SSE events, HTTP API (docs/CONTRACTS.md §3).
import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadEnv, roundCents } from '../../packages/contracts/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PANEL_DIR = path.join(ROOT, 'apps', 'panel');
const MAX_BODY = 1024 * 1024;
const KEEPALIVE_MS = 15000;
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg', '.woff2': 'font/woff2', '.woff': 'font/woff',
};

const log = (component, msg) => console.log(`[${component}] ${msg}`);
const newSessionId = () => `ses_${randomBytes(4).toString('hex')}`;

async function main() {
  await loadEnv(path.join(ROOT, '.env'));
  // Components are imported after the .env is loaded, so module-level env reads see it.
  const { createStore } = await import('./src/store.js');
  const { createAudit } = await import('./src/audit.js');
  const { createPrefs } = await import('./src/prefs.js');
  const { searchMerchants, merchantsFromEnv, fetchJson } = await import('./src/search.js');
  const { filterAndRank } = await import('./src/rank.js');
  const { evaluate, DEFAULT_POLICY } = await import('./src/policy.js');
  const { createBrowser } = await import('./src/browser.js');
  const llmModule = await import('./src/llm.js');
  const { synthesize } = await import('./src/tts.js');
  const { createOrchestrator } = await import('./src/orchestrator.js');

  // ---------------------------------------------------------------- SSE hub
  const clients = new Map(); // session_id → Set<res>
  // Polling fallback for proxies that buffer streams (e.g. Cloudflare quick tunnels): GET /api/poll.
  const polls = new Map(); // session_id → { seq, events: [{ n, type, data }], waiters: Set<fn> }
  function pollBox(session_id) {
    let b = polls.get(session_id);
    if (!b) { b = { seq: 0, events: [], waiters: new Set() }; polls.set(session_id, b); }
    return b;
  }
  function emit(session_id, type, data) {
    const pb = polls.get(String(session_id));
    if (pb) {
      pb.events.push({ n: ++pb.seq, type, data: data ?? {} });
      if (pb.events.length > 400) pb.events.splice(0, pb.events.length - 400);
      for (const w of pb.waiters) w();
    }
    const set = clients.get(String(session_id));
    if (!set || !set.size) return;
    const payload = `event: ${type}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
    for (const res of set) {
      try { res.write(payload); } catch { /* client went away */ }
    }
  }

  const store = await createStore({ dataDir: path.join(ROOT, 'data') });
  log('store', `kind=${store.kind}`);
  const audit = createAudit(store, emit);
  const prefs = createPrefs(store);
  await prefs.seed();
  log('prefs', 'seeded demo profile (labeled seeded_for_demo)');
  const merchants = merchantsFromEnv();
  log('merchants', merchants.map((m) => `${m.name} ${m.base}`).join(' · '));
  const { createSemanticSearch } = await import('./src/semantic-search.js');
  const { embedText } = await import('./src/embed.js');
  const search = createSemanticSearch({ store, searchMerchants, embed: embedText });
  log('search', search === searchMerchants ? 'store JSON API' : 'store JSON API + Atlas Vector Search (products_vector, Titan v2)');
  const browser = await createBrowser({ merchants });
  log('browser', `mode=${browser.mode}`);
  const llmConfigured = Boolean(process.env.BEDROCK_MODEL_ID && (process.env.AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_REGION));
  log('llm', `configured=${llmConfigured ? 'yes' : 'no'}${llmConfigured ? '' : ' (deterministic fallbacks only)'}`);
  log('tts', `piper=${process.env.TTS_URL || 'off'} · polly=${process.env.AWS_REGION ? 'try' : 'off'} · panel falls back to speechSynthesis on 503`);
  const llm = { complete: (args) => llmModule.complete(args) };
  const orchestrator = createOrchestrator({
    audit, prefs, store, browser, merchants, emit, llm,
    searchMerchants: search, filterAndRank, evaluate, policy: DEFAULT_POLICY,
  });

  // ---------------------------------------------------------------- helpers
  function send(res, status, body, headers = {}) {
    if (res.headersSent) return;
    const isBuf = Buffer.isBuffer(body);
    const data = isBuf ? body : JSON.stringify(body ?? {});
    res.writeHead(status, {
      'Content-Type': isBuf ? 'application/octet-stream' : 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(data),
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(data);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (!raw) return resolve({});
        try { resolve(JSON.parse(raw)); } catch { reject(Object.assign(new Error('invalid JSON body'), { status: 400 })); }
      });
      req.on('error', reject);
    });
  }

  const sid = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null);

  async function serveStatic(req, res, pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { return send(res, 400, { error: 'bad path' }); }
    if (rel.includes('\0')) return send(res, 400, { error: 'bad path' });
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.resolve(PANEL_DIR, `.${path.posix.normalize(rel)}`);
    if (file !== PANEL_DIR && !file.startsWith(PANEL_DIR + path.sep)) return send(res, 403, { error: 'forbidden' });
    let target = file;
    try {
      const st = await stat(target);
      if (st.isDirectory()) target = path.join(target, 'index.html');
      const body = await readFile(target);
      res.writeHead(200, {
        'Content-Type': CONTENT_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      return res.end(body);
    } catch {
      return send(res, 404, { error: 'not found' });
    }
  }

  function openEvents(req, res, session_id) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    if (!clients.has(session_id)) clients.set(session_id, new Set());
    clients.get(session_id).add(res);
    const s = orchestrator.session(session_id);
    res.write(`event: state\ndata: ${JSON.stringify({ state: s.state, option_index: s.option_index })}\n\n`);
    const timer = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch { /* ignore */ } }, KEEPALIVE_MS);
    const close = () => {
      clearInterval(timer);
      const set = clients.get(session_id);
      if (set) { set.delete(res); if (!set.size) clients.delete(session_id); }
    };
    req.on('close', close);
    res.on('error', close);
  }

  async function postMerchant(base, pathname, body) {
    return fetchJson(`${String(base).replace(/\/+$/, '')}${pathname}`, { method: 'POST', body, timeoutMs: 4000 });
  }

  function newEventsSince(events, beforeSeq) {
    return (events || []).filter((e) => Number(e.seq) > beforeSeq);
  }

  async function lastSeq(session_id) {
    const events = await audit.list(session_id);
    return events.length ? Number(events[events.length - 1].seq) || 0 : 0;
  }

  // ---------------------------------------------------------------- routes
  async function api(req, res, url) {
    const p = url.pathname;
    const q = url.searchParams;

    if (req.method === 'GET' && p === '/api/health') {
      return send(res, 200, { ok: true, store: store.kind, browser: browser.mode, llm: llmConfigured });
    }
    if (req.method === 'GET' && p.startsWith('/api/art/')) {
      // Product illustration for the panel cards: the same fictional inline SVG the demo stores render.
      const sku = decodeURIComponent(p.slice('/api/art/'.length));
      const [{ CATALOG }, { productArt }] = await Promise.all([import('../merchants/catalog.js'), import('../merchants/views.js')]);
      const prod = CATALOG.find((x) => x.sku === sku);
      if (!prod) return send(res, 404, { error: 'unknown sku' });
      const views = prod.art.kind === 'coffee' ? ['front', 'back', 'beans', 'cup'] : ['side', 'medial', 'top', 'sole'];
      const view = views.includes(q.get('view')) ? q.get('view') : views[0];
      const svg = productArt(prod, view);
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(svg), 'Cache-Control': 'public, max-age=3600' });
      return res.end(svg);
    }
    if (req.method === 'GET' && p === '/api/poll') {
      const s = sid(q.get('session'));
      if (!s) return send(res, 400, { error: 'session is required' });
      const box = pollBox(s);
      const since = Number(q.get('since'));
      if (!Number.isFinite(since) || since < 0) {
        const st = orchestrator.session(s);
        return send(res, 200, { next: box.seq, events: [{ type: 'state', data: { state: st.state, option_index: st.option_index } }] }, { 'Cache-Control': 'no-store' });
      }
      const pick = () => box.events.filter((e) => e.n > since);
      if (!pick().length) {
        await new Promise((resolve) => {
          const done = () => { clearTimeout(t); box.waiters.delete(done); resolve(); };
          const t = setTimeout(done, 1200);
          box.waiters.add(done);
        });
      }
      const evs = pick();
      return send(res, 200, { next: evs.length ? evs[evs.length - 1].n : Math.max(since, 0), events: evs.map((e) => ({ type: e.type, data: e.data })) }, { 'Cache-Control': 'no-store' });
    }
    if (req.method === 'GET' && p === '/api/events') {
      const s = sid(q.get('session'));
      if (!s) return send(res, 400, { error: 'session is required' });
      return openEvents(req, res, s);
    }
    if (req.method === 'POST' && p === '/api/stt') {
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 15e6) return send(res, 413, { error: 'audio too large' }); chunks.push(c); }
      if (!process.env.STT_URL) return send(res, 503, { error: 'speech recognition unavailable' });
      try {
        const r = await fetch(process.env.STT_URL + '/stt', { method: 'POST', body: Buffer.concat(chunks), headers: { 'content-type': req.headers['content-type'] || 'application/octet-stream' }, signal: AbortSignal.timeout(30000) });
        const j = await r.json();
        return send(res, r.ok ? 200 : 502, { text: String(j.text || ''), error: j.error });
      } catch (e) { return send(res, 502, { error: 'speech recognition unavailable' }); }
    }
    if (req.method === 'GET' && p === '/api/tts') {
      const text = String(q.get('text') || '').slice(0, 1500);
      if (!text.trim()) return send(res, 400, { error: 'text is required' });
      const audio = await synthesize(text);
      if (!audio) return send(res, 503, { error: 'tts unavailable' });
      const body = Buffer.isBuffer(audio) ? audio : audio.audio;
      const ctype = Buffer.isBuffer(audio) ? 'audio/mpeg' : audio.type;
      res.writeHead(200, { 'Content-Type': ctype, 'Content-Length': body.length, 'Cache-Control': 'no-store' });
      return res.end(body);
    }
    if (req.method === 'GET' && p === '/api/audit') {
      const s = sid(q.get('session'));
      if (!s) return send(res, 400, { error: 'session is required' });
      return send(res, 200, { events: await audit.list(s) });
    }
    if (req.method === 'GET' && p === '/api/audit/verify') {
      const s = sid(q.get('session'));
      if (!s) return send(res, 400, { error: 'session is required' });
      const v = await audit.verify(s);
      return send(res, 200, v);
    }
    if (req.method !== 'POST') return send(res, 404, { error: 'not found' });

    const body = await readBody(req);
    switch (p) {
      case '/api/utterance': {
        const s = sid(body.session_id);
        const text = typeof body.text === 'string' ? body.text : '';
        if (!s || !text.trim()) return send(res, 400, { error: 'session_id and text are required' });
        orchestrator.handle(s, text, { sync: false }).catch((err) => emit(s, 'error', { message: err.message }));
        return send(res, 200, { ok: true });
      }
      case '/api/barge-in': {
        const s = sid(body.session_id);
        if (!s) return send(res, 400, { error: 'session_id is required' });
        orchestrator.bargeIn(s).catch((err) => emit(s, 'error', { message: err.message }));
        return send(res, 200, { ok: true });
      }
      case '/api/speaking': {
        const s = sid(body.session_id);
        if (!s || !body.say_id) return send(res, 400, { error: 'session_id and say_id are required' });
        orchestrator.speaking(s, String(body.say_id)).catch(() => {});
        return send(res, 200, { ok: true });
      }
      case '/api/speech-done': {
        const s = sid(body.session_id);
        if (!s || !body.say_id) return send(res, 400, { error: 'session_id and say_id are required' });
        orchestrator.speechDone(s, String(body.say_id)).catch((err) => emit(s, 'error', { message: err.message }));
        return send(res, 200, { ok: true });
      }
      case '/api/session/text': {
        const text = typeof body.text === 'string' ? body.text : '';
        if (!text.trim()) return send(res, 400, { error: 'text is required' });
        const s = sid(body.session_id) || newSessionId();
        const before = await lastSeq(s);
        const out = await orchestrator.handle(s, text, { sync: true });
        const events = newEventsSince(await audit.list(s), before);
        return send(res, 200, { session_id: s, replies: out.replies, state: out.state, events });
      }
      case '/api/chat': {
        const text = typeof body.message === 'string' ? body.message : typeof body.text === 'string' ? body.text : '';
        if (!text.trim()) return send(res, 400, { error: 'message is required' });
        const s = sid(body.session_id) || newSessionId();
        const out = await orchestrator.handle(s, text, { sync: true });
        return send(res, 200, { session_id: s, reply: out.replies.join(' ') });
      }
      case '/api/admin/price-bump': {
        // Operator hotkey: simulated +$10 on the first presented option. Not part of the user's audit trail.
        const s = sid(body.session_id);
        if (!s) return send(res, 400, { error: 'session_id is required' });
        const view = orchestrator.session(s);
        const opt = view.options && view.options[0];
        if (!opt) return send(res, 409, { error: 'no options presented yet' });
        const first = view.first_seen[opt.sku]?.price ?? opt.price?.amount;
        const price = roundCents(Number(first) + 10);
        const merchant = merchants.find((m) => m.id === opt.merchant_id);
        let base = merchant ? merchant.base : null;
        if (!base) { try { base = new URL(opt.url).origin; } catch { base = null; } }
        if (!base) return send(res, 409, { error: 'unknown merchant for the first option' });
        const r = await postMerchant(base, '/admin/scenario', { sku: opt.sku, price });
        log('admin', `price-bump ${opt.sku}: ${first} → ${price}`);
        return send(res, 200, { ok: true, sku: opt.sku, merchant_id: opt.merchant_id, before: Number(first), price, merchant: r ?? null });
      }
      case '/api/admin/reset': {
        const s = sid(body.session_id);
        const results = await Promise.all(merchants.map(async (m) => {
          try { await postMerchant(m.base, '/admin/reset', {}); return { store: m.id, ok: true }; } catch (err) { return { store: m.id, ok: false, error: err.message }; }
        }));
        if (s) orchestrator.reset(s);
        log('admin', `reset merchants (${results.map((r) => `${r.store}:${r.ok ? 'ok' : 'failed'}`).join(', ')})${s ? ` + session ${s}` : ''}`);
        return send(res, 200, { ok: results.every((r) => r.ok), merchants: results, session_id: s });
      }
      default:
        return send(res, 404, { error: 'not found' });
    }
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, { error: 'bad url' }); }
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, url.pathname);
      return send(res, 405, { error: 'method not allowed' });
    } catch (err) {
      console.error(`[agent] ${req.method} ${url.pathname} failed: ${err.message}`);
      return send(res, err.status || 500, { error: err.message || 'internal error' });
    }
  });

  const port = Number.parseInt(process.env.AGENT_PORT || '', 10) || 3000;
  server.listen(port, () => log('agent', `Shopz agent + panel listening on http://localhost:${port}`));

  const shutdown = async () => {
    log('agent', 'shutting down');
    for (const set of clients.values()) for (const res of set) { try { res.end(); } catch { /* ignore */ } }
    server.close();
    try { await store.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(`[agent] failed to start: ${err.stack || err.message}`);
  process.exit(1);
});
