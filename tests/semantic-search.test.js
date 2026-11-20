import test from 'node:test';
import assert from 'node:assert/strict';
import { createSemanticSearch, VECTOR_SOURCE } from '../apps/agent/src/semantic-search.js';

const MERCHANTS = [{ id: 'runhub', name: 'RunHub', base: 'http://127.0.0.1:9' }];
const item = (sku, extra = {}) => ({ sku, store: 'runhub', store_name: 'RunHub', title: `Shoe ${sku}`, category: 'running_shoes', price: 100, ...extra });

function stubSearch(byQuery) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    const results = (byQuery[args.query] || []).map((r) => ({ ...r }));
    return { seen: results.length, perStore: [{ store: 'runhub', count: results.length, ms: 1 }], results };
  };
  fn.calls = calls;
  return fn;
}

function mongoStub(answers) {
  const calls = [];
  return {
    kind: 'mongo',
    calls,
    products: {
      async vectorSearch(vector, k, filter) {
        calls.push({ vector, k, filter: filter ?? null });
        const a = answers.shift();
        return a === undefined ? null : a;
      },
    },
  };
}

test('memory store: plain merchant search is returned unchanged', () => {
  const search = stubSearch({});
  assert.equal(createSemanticSearch({ store: { kind: 'memory', products: { vectorSearch: async () => null } }, searchMerchants: search, embed: async () => [1] }), search);
});

test('mongo store: semantic hits merge in only after the store confirms them live', async () => {
  const docs = [
    { sku: 'A', store: 'runhub', category: 'running_shoes', title: 'Shoe A', score: 0.91, price: 1 },
    { sku: 'B', store: 'runhub', category: 'running_shoes', title: 'Shoe B', score: 0.83, price: 1 }, // stale seeded price
    { sku: 'C', store: 'shoebazaar', category: 'running_shoes', title: 'Shoe C', score: 0.8 }, // store not approved
    { sku: 'D', store: 'runhub', category: 'coffee', title: 'Beans D', score: 0.7 }, // other category
    { sku: 'E', store: 'runhub', category: 'running_shoes', title: 'Shoe E', score: 0.6 }, // store no longer has it
  ];
  const store = mongoStub([docs]);
  const search = stubSearch({ 'running shoes': [item('A')], 'Shoe B': [item('B', { price: 99 })], 'Shoe E': [] });
  const embedded = [];
  const semantic = createSemanticSearch({ store, searchMerchants: search, embed: async (t) => { embedded.push(t); return [0.1, 0.2]; } });
  const res = await semantic({ query: 'running shoes', category: 'running_shoes', merchants: MERCHANTS });

  assert.deepEqual(res.results.map((r) => r.sku), ['A', 'B']);
  assert.equal(res.results[0].vector_score, 0.91);
  assert.equal(res.results[0].found_by, undefined);
  assert.equal(res.results[1].found_by, VECTOR_SOURCE);
  assert.equal(res.results[1].price, 99, 'price comes from the live store, not from Atlas');
  assert.equal(res.seen, 2);
  const entry = res.perStore.find((p) => p.store === VECTOR_SOURCE);
  assert.equal(entry.count, 3);
  assert.equal(entry.added, 1);
  assert.equal(entry.error, undefined);
  assert.deepEqual(store.calls[0].filter, { category: { $eq: 'running_shoes' } });
  assert.match(embedded[0], /running shoes/);
});

test('mongo store: index without filter fields → retried without the pre-filter', async () => {
  const store = mongoStub([null, [{ sku: 'A', store: 'runhub', category: 'running_shoes', title: 'Shoe A', score: 0.9 }]]);
  const semantic = createSemanticSearch({ store, searchMerchants: stubSearch({ 'running shoes': [item('A')] }), embed: async () => [1] });
  const res = await semantic({ query: 'running shoes', category: 'running_shoes', merchants: MERCHANTS });
  assert.equal(store.calls.length, 2);
  assert.equal(store.calls[1].filter, null);
  assert.deepEqual(res.results.map((r) => r.sku), ['A']);
  assert.equal(res.perStore.find((p) => p.store === VECTOR_SOURCE).count, 1);
});

test('mongo store: no embeddings or no index → store results unchanged, gap recorded', async () => {
  const search = stubSearch({ 'running shoes': [item('A'), item('B')] });
  const noEmbed = createSemanticSearch({ store: mongoStub([]), searchMerchants: search, embed: async () => null });
  const r1 = await noEmbed({ query: 'running shoes', category: 'running_shoes', merchants: MERCHANTS });
  assert.deepEqual(r1.results.map((r) => r.sku), ['A', 'B']);
  assert.equal(r1.perStore.find((p) => p.store === VECTOR_SOURCE).error, 'embeddings unavailable');

  const noIndex = createSemanticSearch({ store: mongoStub([null, null]), searchMerchants: search, embed: async () => [1] });
  const r2 = await noIndex({ query: 'running shoes', category: 'running_shoes', merchants: MERCHANTS });
  assert.deepEqual(r2.results.map((r) => r.sku), ['A', 'B']);
  assert.equal(r2.perStore.find((p) => p.store === VECTOR_SOURCE).error, 'vector index unavailable');

  const throwing = createSemanticSearch({ store: mongoStub([]), searchMerchants: search, embed: async () => { throw new Error('boom'); } });
  const r3 = await throwing({ query: 'running shoes', category: 'running_shoes', merchants: MERCHANTS });
  assert.equal(r3.results.length, 2);
});

test('empty query (browse fallback) skips the vector step', async () => {
  const store = mongoStub([]);
  let called = false;
  const semantic = createSemanticSearch({ store, searchMerchants: stubSearch({ '': [item('A')] }), embed: async () => { called = true; return [1]; } });
  const res = await semantic({ query: '', category: 'running_shoes', merchants: MERCHANTS });
  assert.equal(called, false);
  assert.equal(store.calls.length, 0);
  assert.deepEqual(res.results.map((r) => r.sku), ['A']);
});
