// User preferences. The demo profile is pre-seeded and labeled as such (source 'seeded_for_demo').

function deepFreeze(o) {
  if (o && typeof o === 'object') {
    Object.values(o).forEach(deepFreeze);
    Object.freeze(o);
  }
  return o;
}

const seeded = (pref_id, category, key, value, kind) => ({
  pref_id, user_id: 'u_demo', category, key, value, kind,
  source: 'seeded_for_demo', seeded: true, learned_at: null, last_used_at: null,
});

export const SEEDED_PREFS = deepFreeze([
  seeded('pref_size_shoe', 'running_shoes', 'size', { size: '10.5', width: 'wide' }, 'hard_constraint'),
  seeded('pref_avoid_vantex', 'running_shoes', 'brand', { brand: 'Vantex', reason: 'sizing' }, 'avoid'),
  seeded('pref_budget_shoes', 'running_shoes', 'budget', { max: 140, currency: 'USD' }, 'budget'),
  seeded('pref_usual_coffee', 'coffee', 'usual', { sku: 'DC-MRW-HB-12', merchant_id: 'dailycart', title: 'Morrow House Blend', last_price: 18.40 }, 'soft_preference'),
  seeded('pref_address', 'any', 'address', { zip: '94103' }, 'hard_constraint'),
]);

const clone = (v) => JSON.parse(JSON.stringify(v));
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
const slug = (s) => norm(s).replace(/[^a-z0-9_]/g, '') || 'x';

export function createPrefs(store) {
  /** Idempotent: upserts the seeded demo profile (resets it to the seeded values). */
  async function seed() {
    for (const p of SEEDED_PREFS) await store.prefs.upsert(clone(p));
    return SEEDED_PREFS.map(clone);
  }

  /** Preferences whose category equals `category`. Global ('any') prefs only with { includeAny: true }. */
  async function forCategory(user_id = 'u_demo', category, { includeAny = false } = {}) {
    const all = await store.prefs.list(user_id);
    const want = norm(category);
    return all.filter((p) => norm(p.category) === want || (includeAny && p.category === 'any'));
  }

  async function usual(user_id = 'u_demo', category) {
    const list = await forCategory(user_id, category);
    return list.find((p) => p.key === 'usual') || null;
  }

  /** Upsert a (learned or user-stated) preference; fills the UserPreference defaults. */
  async function save(pref = {}) {
    const full = {
      ...pref,
      pref_id: pref.pref_id || `pref_${slug(pref.category)}_${slug(pref.key)}`,
      user_id: pref.user_id || 'u_demo',
      source: pref.source || 'user_stated',
      seeded: pref.seeded ?? false,
      learned_at: pref.learned_at ?? new Date().toISOString(),
      last_used_at: pref.last_used_at ?? null,
    };
    await store.prefs.upsert(full);
    return full;
  }

  return { seed, forCategory, usual, save };
}
