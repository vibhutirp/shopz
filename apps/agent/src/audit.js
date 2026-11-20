// Append-only, hash-chained audit log per session (docs/CONTRACTS.md §4 AuditEvent).
import { AUDIT_TYPES, GENESIS_HASH, hashEvent } from '../../../packages/contracts/index.js';

// JSON round trip: what gets hashed is exactly what any reader of the JSON (panel, file, Mongo) sees.
const plain = (v) => (v === undefined || v === null ? {} : JSON.parse(JSON.stringify(v)));

export function createAudit(store, emit) {
  const tails = new Map(); // session_id -> promise of the last queued append
  const heads = new Map(); // session_id -> { seq, hash } of the last stored event

  function enqueue(session_id, job) {
    const run = (tails.get(session_id) || Promise.resolve()).then(job);
    const tail = run.then(() => {}, () => {});
    tails.set(session_id, tail);
    tail.then(() => { if (tails.get(session_id) === tail) tails.delete(session_id); });
    return run;
  }

  async function loadHead(session_id) {
    const known = heads.get(session_id);
    if (known) return known;
    const events = await store.audit.list(session_id);
    const last = events[events.length - 1];
    return last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: GENESIS_HASH };
  }

  async function append(session_id, type, actor, summary, data = {}, refs = {}) {
    if (!session_id) throw new TypeError('audit.append: session_id is required');
    if (!AUDIT_TYPES.includes(type)) throw new TypeError(`audit.append: unknown event type "${type}"`);
    const payload = { data: plain(data), refs: plain(refs) }; // snapshot now; the caller may mutate later
    return enqueue(session_id, async () => {
      const head = await loadHead(session_id);
      const seq = head.seq + 1;
      const event = {
        event_id: 'evt_' + String(seq).padStart(4, '0'),
        session_id: String(session_id),
        user_id: 'u_demo',
        seq,
        ts: new Date().toISOString(),
        type,
        actor: actor || 'system',
        summary: summary == null ? '' : String(summary),
        data: payload.data,
        refs: payload.refs,
        prev_hash: head.hash,
      };
      event.hash = hashEvent(event);
      try {
        await store.audit.append(event);
      } catch (err) {
        heads.delete(session_id); // reload the head from the store next time
        throw err;
      }
      heads.set(session_id, { seq, hash: event.hash });
      if (typeof emit === 'function') {
        try { emit(session_id, 'audit', { event }); } catch (err) { console.warn(`[audit] emit failed: ${err.message}`); }
      }
      return event;
    });
  }

  async function list(session_id) {
    await (tails.get(session_id) || Promise.resolve()); // include appends already queued
    return store.audit.list(session_id);
  }

  /** Recompute the chain: seq continuity (1..n), prev_hash links and every hash. */
  async function verify(session_id) {
    const events = await list(session_id);
    const head_hash = events.length ? events[events.length - 1].hash : GENESIS_HASH;
    let prev = GENESIS_HASH;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      let reason = null;
      if (e.seq !== i + 1) reason = 'seq_gap';
      else if (e.prev_hash !== prev) reason = 'prev_hash_mismatch';
      else if (hashEvent(e) !== e.hash) reason = 'hash_mismatch';
      if (reason) return { ok: false, count: events.length, head_hash, bad_seq: i + 1, reason };
      prev = e.hash;
    }
    return { ok: true, count: events.length, head_hash };
  }

  return { append, list, verify };
}
