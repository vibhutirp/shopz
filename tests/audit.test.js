import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../apps/agent/src/store.js';
import { createAudit } from '../apps/agent/src/audit.js';
import { SEEDED_PREFS, createPrefs } from '../apps/agent/src/prefs.js';
import { GENESIS_HASH, hashEvent } from '../packages/contracts/index.js';

async function memoryStore() {
  const dir = await mkdtemp(join(tmpdir(), 'shopz-audit-'));
  const store = await createStore({ uri: '', dataDir: dir });
  return { store, dir };
}

test('hash chain: serialized appends, emit after store, JSONL mirror, verify ok', async (t) => {
  const { store, dir } = await memoryStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(store.kind, 'memory');
  const emitted = [];
  const audit = createAudit(store, (sid, type, payload) => {
    emitted.push({ sid, type, seq: payload.event.seq, storedAlready: store._mem.audit.get(sid).length });
  });
  const sid = 'ses_test1';
  const types = ['session_started', 'utterance', 'preference_used', 'search_issued', 'ranking'];
  // fired without awaiting in between: must still be chained in call order
  const events = await Promise.all(types.map((type, i) => audit.append(sid, type, i === 1 ? 'user' : 'agent', `step ${i + 1}`, { i, when: new Date(0) })));

  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4, 5]);
  assert.deepEqual(events.map((e) => e.type), types);
  assert.equal(events[0].prev_hash, GENESIS_HASH);
  events.forEach((e, i) => {
    assert.equal(e.event_id, `evt_000${i + 1}`);
    assert.equal(e.user_id, 'u_demo');
    assert.equal(e.session_id, sid);
    assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(e.hash, hashEvent(e));
    if (i > 0) assert.equal(e.prev_hash, events[i - 1].hash);
  });
  assert.equal(events[0].data.when, '1970-01-01T00:00:00.000Z'); // data is stored as its JSON form

  assert.deepEqual(emitted.map((e) => [e.type, e.seq, e.storedAlready]), types.map((_, i) => ['audit', i + 1, i + 1]));

  const listed = await audit.list(sid);
  assert.deepEqual(listed, events);
  assert.deepEqual(await audit.verify(sid), { ok: true, count: 5, head_hash: events[4].hash });

  const lines = (await readFile(join(dir, 'audit-ses_test1.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines, events);
});

test('tampering one stored event breaks verify at that seq', async (t) => {
  const { store, dir } = await memoryStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const audit = createAudit(store, () => {});
  for (const type of ['session_started', 'utterance', 'price_observed', 'policy_decision']) await audit.append('ses_t', type, 'agent', type);
  assert.equal((await audit.verify('ses_t')).ok, true);

  store._mem.audit.get('ses_t')[2].summary = 'price_observed $99.00';
  const bad = await audit.verify('ses_t');
  assert.equal(bad.ok, false);
  assert.equal(bad.bad_seq, 3);
  assert.equal(bad.count, 4);

  store._mem.audit.get('ses_t')[2].summary = 'price_observed';
  assert.equal((await audit.verify('ses_t')).ok, true);
  store._mem.audit.get('ses_t').splice(1, 1); // drop seq 2
  const gap = await audit.verify('ses_t');
  assert.equal(gap.ok, false);
  assert.equal(gap.bad_seq, 2);
});

test('sessions are independent, unknown types rejected, chain resumes from the store', async (t) => {
  const { store, dir } = await memoryStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const audit = createAudit(store);
  await Promise.all([audit.append('a', 'session_started', 'system', 'a1'), audit.append('b', 'session_started', 'system', 'b1'), audit.append('a', 'utterance', 'user', 'a2')]);
  assert.deepEqual((await audit.list('a')).map((e) => e.seq), [1, 2]);
  assert.deepEqual((await audit.list('b')).map((e) => e.seq), [1]);
  await assert.rejects(audit.append('a', 'not_a_type', 'agent', 'x'), /unknown event type/);
  assert.equal((await audit.list('a')).length, 2);

  const again = createAudit(store); // e.g. after a restart against the same store
  const e3 = await again.append('a', 'error', 'system', 'resumed');
  assert.equal(e3.seq, 3);
  assert.deepEqual(await again.verify('a'), { ok: true, count: 3, head_hash: e3.hash });
  assert.deepEqual(await again.verify('nobody'), { ok: true, count: 0, head_hash: GENESIS_HASH });

  await audit.append('../../escape', 'session_started', 'system', 'x');
  const files = await readdir(dir);
  assert.ok(files.includes('audit-______escape.jsonl'), files.join(','));
});

test('prefs: idempotent seed, category lookup, usual, save', async (t) => {
  const { store, dir } = await memoryStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prefs = createPrefs(store);
  await prefs.seed();
  await prefs.seed();
  assert.equal((await store.prefs.list('u_demo')).length, 5);
  assert.ok(SEEDED_PREFS.every((p) => p.source === 'seeded_for_demo' && p.seeded === true && p.user_id === 'u_demo'));
  const shoes = await prefs.forCategory('u_demo', 'running_shoes');
  assert.deepEqual(shoes.map((p) => p.pref_id), ['pref_size_shoe', 'pref_avoid_vantex', 'pref_budget_shoes']);
  assert.deepEqual(shoes[0].value, { size: '10.5', width: 'wide' });
  assert.equal((await prefs.forCategory('u_demo', 'running_shoes', { includeAny: true })).length, 4);
  const coffee = await prefs.usual('u_demo', 'coffee');
  assert.equal(coffee.pref_id, 'pref_usual_coffee');
  assert.equal(coffee.value.sku, 'DC-MRW-HB-12');
  assert.equal(await prefs.usual('u_demo', 'running_shoes'), null);
  const saved = await prefs.save({ category: 'running_shoes', key: 'usual', value: { sku: 'RH-STW-GL5-W' }, kind: 'soft_preference', source: 'inferred_from_order' });
  assert.equal(saved.pref_id, 'pref_running_shoes_usual');
  assert.equal(saved.seeded, false);
  assert.equal((await prefs.usual('u_demo', 'running_shoes')).value.sku, 'RH-STW-GL5-W');
  await store.orders.insert({ order_id: 'RH-10482', user_id: 'u_demo', placed_at: new Date().toISOString() });
  assert.equal(await store.orders.countToday('u_demo'), 1);
  assert.equal((await store.orders.list('u_demo'))[0].order_id, 'RH-10482');
  assert.equal(await store.products.vectorSearch([0.1, 0.2], 3), null);
});
