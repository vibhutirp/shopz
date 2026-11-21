// Minimal WebSocket (RFC 6455) for the Shopz Companion link: text frames, ping/pong, close. No extensions, no binary API.
// Server side: accept(req, socket) after an HTTP "upgrade". Client side (tests, tools): connect(url).
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const MAX_MESSAGE = 8 * 1024 * 1024; // a page read (text + JSON-LD) stays far below this

export function acceptKey(key) {
  return createHash('sha1').update(String(key) + GUID).digest('base64');
}

/** One frame → Buffer. Client frames must be masked (mask=true), server frames must not. */
export function encodeFrame(opcode, payload = Buffer.alloc(0), { mask = false, fin = true } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  const head = [((fin ? 0x80 : 0) | (opcode & 0x0f))];
  const m = mask ? 0x80 : 0;
  if (len < 126) head.push(m | len);
  else if (len < 65536) head.push(m | 126, (len >> 8) & 0xff, len & 0xff);
  else {
    head.push(m | 127, 0, 0, 0, 0);
    head.push((len >>> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff);
  }
  if (!mask) return Buffer.concat([Buffer.from(head), data]);
  const key = randomBytes(4);
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i += 1) out[i] = data[i] ^ key[i & 3];
  return Buffer.concat([Buffer.from(head), key, out]);
}

/**
 * Incremental frame parser. Returns { frames, rest } where frames = [{ fin, opcode, payload }].
 * Throws on frames over MAX_MESSAGE or (server side) unmasked client frames.
 */
export function parseFrames(buf, { requireMask = false, maxMessage = MAX_MESSAGE } = {}) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const masked = (b1 & 0x80) !== 0;
    if (requireMask && !masked) throw Object.assign(new Error('unmasked client frame'), { code: 1002 });
    if (b0 & 0x70) throw Object.assign(new Error('reserved bits set'), { code: 1002 });
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p); p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      const hi = buf.readUInt32BE(p);
      const lo = buf.readUInt32BE(p + 4);
      if (hi > 0) throw Object.assign(new Error('frame too large'), { code: 1009 });
      len = lo; p += 8;
    }
    if (len > maxMessage) throw Object.assign(new Error('frame too large'), { code: 1009 });
    const need = (masked ? 4 : 0) + len;
    if (buf.length - p < need) break;
    let payload;
    if (masked) {
      const key = buf.subarray(p, p + 4);
      payload = Buffer.alloc(len);
      for (let i = 0; i < len; i += 1) payload[i] = buf[p + 4 + i] ^ key[i & 3];
    } else payload = Buffer.from(buf.subarray(p, p + len));
    frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload });
    off = p + need;
  }
  return { frames, rest: buf.subarray(off) };
}

/** A connected socket with an EventEmitter API: 'message' (string), 'close' ({ code, reason }), 'error'. */
class Conn extends EventEmitter {
  constructor(socket, { isClient = false, maxMessage = MAX_MESSAGE } = {}) {
    super();
    this.socket = socket;
    this.isClient = isClient;
    this.maxMessage = maxMessage;
    this.buf = Buffer.alloc(0);
    this.parts = null; // fragmented message
    this.open = true;
    this.lastSeen = Date.now();
    socket.setNoDelay?.(true);
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('close', () => this.finish(1006, 'connection lost'));
    socket.on('error', (err) => { this.emit('error', err); this.finish(1006, err.message); });
  }

  onData(chunk) {
    this.lastSeen = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (this.buf.length > this.maxMessage + 16) { this.close(1009, 'message too large'); return; }
    let parsed;
    try { parsed = parseFrames(this.buf, { requireMask: !this.isClient, maxMessage: this.maxMessage }); } catch (err) { this.close(err.code || 1002, err.message); return; }
    this.buf = Buffer.from(parsed.rest);
    for (const f of parsed.frames) this.onFrame(f);
  }

  onFrame({ fin, opcode, payload }) {
    if (opcode === 0x8) { // close
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      if (this.open) { try { this.socket.write(encodeFrame(0x8, payload.subarray(0, 2), { mask: this.isClient })); } catch { /* ignore */ } }
      this.finish(code, payload.subarray(2).toString('utf8'));
      try { this.socket.end(); } catch { /* ignore */ }
      return;
    }
    if (opcode === 0x9) { this.write(0xA, payload); return; } // ping → pong
    if (opcode === 0xA) return; // pong
    if (opcode === 0x1 || opcode === 0x2) {
      if (fin) { this.deliver(payload); return; }
      this.parts = [payload];
      return;
    }
    if (opcode === 0x0 && this.parts) {
      this.parts.push(payload);
      const size = this.parts.reduce((a, b) => a + b.length, 0);
      if (size > this.maxMessage) { this.close(1009, 'message too large'); return; }
      if (fin) { const all = Buffer.concat(this.parts); this.parts = null; this.deliver(all); }
      return;
    }
    this.close(1002, 'unexpected frame');
  }

  deliver(payload) { this.emit('message', payload.toString('utf8')); }

  write(opcode, payload) {
    if (!this.open) return false;
    try { this.socket.write(encodeFrame(opcode, payload, { mask: this.isClient })); return true; } catch { return false; }
  }

  send(text) { return this.write(0x1, Buffer.from(String(text), 'utf8')); }
  ping() { return this.write(0x9, Buffer.alloc(0)); }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    const r = Buffer.from(String(reason).slice(0, 120), 'utf8');
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0); r.copy(p, 2);
    this.write(0x8, p);
    this.finish(code, reason);
    setTimeout(() => { try { this.socket.destroy(); } catch { /* ignore */ } }, 200).unref?.();
  }

  finish(code, reason) {
    if (!this.open) return;
    this.open = false;
    this.emit('close', { code, reason });
  }
}

/** Server: finish the upgrade handshake. Returns a Conn or null (and answers 400) when the request is not a WebSocket upgrade. */
export function accept(req, socket, { maxMessage = MAX_MESSAGE } = {}) {
  const key = req.headers['sec-websocket-key'];
  const ok = String(req.headers.upgrade || '').toLowerCase() === 'websocket' && key && String(req.headers['sec-websocket-version'] || '') === '13';
  if (!ok) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return null;
  }
  socket.write([
    'HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptKey(key)}`, '', '',
  ].join('\r\n'));
  return new Conn(socket, { isClient: false, maxMessage });
}

/** Client (Node): connect to ws://host:port/path. Resolves with a Conn. */
export function connect(url, { headers = {}, timeoutMs = 5000 } = {}) {
  const u = new URL(url);
  if (u.protocol !== 'ws:') return Promise.reject(new Error('only ws:// in the node client'));
  const key = randomBytes(16).toString('base64');
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: u.hostname, port: u.port || 80, path: u.pathname + u.search, timeout: timeoutMs,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13', ...headers },
    });
    req.on('upgrade', (res, socket, head) => {
      if (res.headers['sec-websocket-accept'] !== acceptKey(key)) { socket.destroy(); reject(new Error('bad accept key')); return; }
      const c = new Conn(socket, { isClient: true });
      if (head && head.length) c.onData(head);
      resolve(c);
    });
    req.on('response', (res) => reject(new Error(`HTTP ${res.statusCode} instead of an upgrade`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}
