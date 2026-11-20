// MongoDB Atlas Vector Search next to the stores' own search.
// Active only with the MongoDB store (`npm run seed` builds the catalog embeddings and the products_vector index);
// otherwise the plain merchant search is returned unchanged.
// The stores' JSON API stays the source of truth: a semantic hit the store search missed becomes a candidate only
// after its store returns it live (current price, stock and delivery), never from the seeded copy in Atlas.

export const VECTOR_SOURCE = 'atlas_vector_search';

/**
 * @param {object} o
 * @param {object} o.store            createStore() result; needs kind === 'mongo' and products.vectorSearch
 * @param {Function} o.searchMerchants search.js searchMerchants (same signature is returned)
 * @param {Function} o.embed          async text → number[] | null (embed.js embedText)
 * @param {number} [o.k]              semantic hits to ask Atlas for
 */
export function createSemanticSearch({ store, searchMerchants, embed, k = 8 } = {}) {
  if (!store || store.kind !== 'mongo' || typeof store.products?.vectorSearch !== 'function') return searchMerchants;
  if (typeof searchMerchants !== 'function' || typeof embed !== 'function') return searchMerchants;

  return async function semanticSearch(args = {}) {
    const { query = '', category = '', merchants = [] } = args;
    const t0 = Date.now();
    const text = String(query || '').trim();
    const [base, vector] = await Promise.all([
      searchMerchants(args),
      text ? embed(category ? `${text}. Category ${category}` : text).catch(() => null) : Promise.resolve(null),
    ]);
    const results = Array.isArray(base?.results) ? [...base.results] : [];
    const perStore = Array.isArray(base?.perStore) ? [...base.perStore] : [];
    const seen = base?.seen ?? results.length;
    if (!text) return { ...base, seen, perStore, results };
    if (!vector) {
      perStore.push({ store: VECTOR_SOURCE, count: 0, added: 0, ms: Date.now() - t0, error: 'embeddings unavailable' });
      return { ...base, seen, perStore, results };
    }

    const allowed = new Map((merchants || []).map((m) => [m.id, m]));
    const filter = category ? { category: { $eq: category } } : null;
    let docs = await store.products.vectorSearch(vector, k, filter);
    if (!docs && filter) docs = await store.products.vectorSearch(vector, k); // index built without filter fields
    const hits = (docs || []).filter((d) => d && d.sku && allowed.has(d.store) && (!category || d.category === category));
    if (!docs) {
      perStore.push({ store: VECTOR_SOURCE, count: 0, added: 0, ms: Date.now() - t0, error: 'vector index unavailable' });
      return { ...base, seen, perStore, results };
    }

    const key = (r) => `${r.store}:${r.sku}`;
    const scoreOf = new Map(hits.map((d) => [key(d), typeof d.score === 'number' ? d.score : null]));
    for (const r of results) {
      if (scoreOf.has(key(r))) r.vector_score = scoreOf.get(key(r));
    }
    const have = new Set(results.map(key));
    const fresh = hits.filter((d) => !have.has(key(d)));
    const added = (await Promise.all(fresh.map(async (d) => {
      try {
        const live = await searchMerchants({ query: d.title || d.sku, category, merchants: [allowed.get(d.store)] });
        const item = (live?.results || []).find((r) => r && r.sku === d.sku);
        return item ? { ...item, found_by: VECTOR_SOURCE, vector_score: scoreOf.get(key(d)) } : null;
      } catch {
        return null; // the store could not confirm it live → not a candidate
      }
    }))).filter(Boolean);

    perStore.push({ store: VECTOR_SOURCE, count: hits.length, added: added.length, ms: Date.now() - t0 });
    return { ...base, seen: seen + added.length, perStore, results: [...results, ...added] };
  };
}
