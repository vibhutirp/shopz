// Filter + weighted ranking of search results into ProductOption[] (docs/AGENT-MODULES.md, CONTRACTS §4).
import { DEMO_ZIP, addDays, isoDate, today } from '../../../packages/contracts/index.js';

const WEIGHTS = { rating: 0.30, pref_fit: 0.25, price: 0.30, delivery: 0.15 };
const EPS = 1e-9;
const WHY = {
  fit: 'Best fit for wide feet and the top rating.',
  price: 'Cheapest pick that still arrives before your date.',
  delivery: 'Most cushion and the fastest delivery.',
  fallback: 'Solid all-round pick inside your budget.',
};
const WIDE_EXTRA = new Set(['4E', '6E', 'EEEE', 'XW', 'XWIDE', 'EXTRAWIDE']);
const WIDE = new Set([...WIDE_EXTRA, '2E', 'EE', 'W', 'WIDE']);

const norm = (s) => String(s ?? '').trim().toLowerCase();
const widthKey = (w) => String(w ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const round3 = (x) => Math.round(x * 1000) / 1000;
const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const isWideWanted = (width) => WIDE.has(widthKey(width));

function dayNumber(iso) {
  const m = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000 : null;
}

function etaOf(r) {
  const eta = r.eta_date || (r.delivery && r.delivery.eta_date) || (r.details && r.details.eta_date);
  if (eta) return String(eta).slice(0, 10);
  const days = Number(r.delivery_days ?? (r.details && r.details.delivery_days));
  return Number.isFinite(days) ? isoDate(addDays(today(), days)) : null;
}

const priceOf = (r) => Number(r.price && typeof r.price === 'object' ? r.price.amount : r.price);

const isShoe = (r) => /shoe/i.test(String(r.category || '')) || nonEmpty(r.widths) !== null;

const nonEmpty = (v) => ((Array.isArray(v) && v.length) || (typeof v === 'string' && v.trim()) ? v : null);

function widthsOf(r) {
  const w = nonEmpty(r.widths) ?? nonEmpty(r.details && r.details.widths) ?? [];
  return (Array.isArray(w) ? w : String(w).split(/[,/;]/)).map(widthKey).filter(Boolean);
}

const sizeNum = (s) => {
  const m = String(s ?? '').match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : NaN;
};

/** true / false, or null when the product has no size data. Accepts lists, "8–13" ranges and {min,max}. */
function sizeAvailable(r, size) {
  const raw = r.sizes ?? (r.details && r.details.sizes);
  const want = sizeNum(size);
  if (raw == null || (Array.isArray(raw) && raw.length === 0) || raw === '') return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const lo = sizeNum(raw.min);
    const hi = sizeNum(raw.max);
    return Number.isFinite(lo) && Number.isFinite(hi) ? want >= lo && want <= hi : null;
  }
  const items = Array.isArray(raw) ? raw : String(raw).split(/[,;/]/);
  return items.some((it) => {
    const range = String(it).match(/^\s*(?:US\s*)?(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*$/i);
    if (range) return want >= Number(range[1]) && want <= Number(range[2]);
    return sizeNum(it) === want;
  });
}

function reviewList(details) {
  if (!details) return [];
  const r = details.reviews;
  if (Array.isArray(r)) return r;
  if (r && typeof r === 'object') {
    for (const k of ['items', 'list', 'reviews', 'entries']) if (Array.isArray(r[k])) return r[k];
  }
  return [];
}

/** Text of the most helpful critical review (explicit quote field if present, else derived from the list). */
function criticalReviewText(details) {
  if (!details) return '';
  const r = details.reviews && typeof details.reviews === 'object' && !Array.isArray(details.reviews) ? details.reviews : {};
  const direct = r.critical_quote ?? details.critical_quote ?? r.critical ?? details.critical_review;
  if (typeof direct === 'string' && direct.trim()) return direct;
  if (direct && typeof direct === 'object' && (direct.text || direct.title)) return `${direct.title || ''} ${direct.text || ''}`;
  const list = reviewList(details);
  const helpful = (x) => Number(x.helpful ?? x.helpful_count ?? x.helpful_votes ?? 0) || 0;
  let pool = list.filter((x) => x && (x.critical === true || x.is_critical === true || x.data_critical === true));
  if (!pool.length) pool = list.filter((x) => x && Number(x.stars ?? x.rating) <= 3);
  if (!pool.length) return '';
  const top = pool.reduce((best, x) => (helpful(x) > helpful(best) ? x : best), pool[0]);
  return `${top.title || ''} ${top.text || top.body || ''}`;
}

function cushionOf(details) {
  if (!details) return '';
  const specs = details.specs;
  if (Array.isArray(specs)) {
    const row = specs.find((s) => s && /cushion/i.test(String(s.label ?? s.name ?? s.key ?? '')));
    if (row) return norm(row.value ?? row.text);
  } else if (specs && typeof specs === 'object') {
    const key = Object.keys(specs).find((k) => /cushion/i.test(k));
    if (key) return norm(typeof specs[key] === 'object' ? specs[key].value : specs[key]);
  }
  return norm(details.cushion);
}

function sellerOf(r) {
  const s = r.details && r.details.seller;
  if (typeof s === 'string' && s) return s;
  if (s && typeof s === 'object' && (s.name || s.title)) return s.name || s.title;
  return r.seller || r.sold_by || (r.details && r.details.sold_by) || r.store_name || null;
}

function returnPolicyOf(r) {
  const d = r.details || {};
  const ret = d.returns;
  if (typeof ret === 'string' && ret) return ret;
  if (ret && typeof ret === 'object') {
    const t = ret.policy_text ?? ret.text ?? ret.policy ?? ret.summary;
    if (t) return String(t);
  }
  return d.return_policy || r.return_policy || null;
}

function prefFit(r, width) {
  if (!isShoe(r) || !isWideWanted(width)) return 1;
  const widths = widthsOf(r);
  let fit = widths.some((w) => WIDE_EXTRA.has(w)) ? 1.0 : widths.some((w) => WIDE.has(w)) ? 0.8 : 0;
  if (/narrow/i.test(criticalReviewText(r.details))) fit -= 0.1;
  return clamp01(fit);
}

/** Min-max over the candidates; `higherIsBetter=false` flips (cheapest = 1). All equal → 1. */
function minMax(values, higherIsBetter = true) {
  const known = values.filter((v) => Number.isFinite(v));
  const lo = Math.min(...known);
  const hi = Math.max(...known);
  return values.map((v) => {
    if (!Number.isFinite(v)) return 0;
    if (hi - lo < EPS) return 1;
    return higherIsBetter ? (v - lo) / (hi - lo) : (hi - v) / (hi - lo);
  });
}

function filterReason(r, { avoid, budget, deadline, size, width }) {
  if (avoid.has(norm(r.brand))) return 'avoided_brand';
  if (Number.isFinite(budget) && priceOf(r) > budget + EPS) return 'over_budget';
  const eta = etaOf(r);
  if (deadline && eta && eta > deadline) return 'arrives_after_deadline';
  if (r.in_stock === false || r.in_stock === 'false') return 'out_of_stock';
  if (size && (isShoe(r) || r.sizes != null) && sizeAvailable(r, size) === false) return 'size_unavailable';
  if (isShoe(r) && isWideWanted(width) && !widthsOf(r).some((w) => WIDE.has(w))) return 'no_wide_fit';
  return null;
}

function preferencesUsed(r, { avoidBrands, budget, size, width }) {
  const used = [];
  const shoe = isShoe(r);
  if (shoe && (size || isWideWanted(width))) used.push('pref_size_shoe');
  for (const b of avoidBrands) used.push(`pref_avoid_${slug(b)}`);
  if (shoe && Number.isFinite(budget)) used.push('pref_budget_shoes');
  return [...new Set(used)];
}

/**
 * → { ranked: ProductOption[] (max 3), filtered: [{ sku, title, reason, brand, merchant_id }], matched }
 * Score = 0.30·rating + 0.25·pref_fit + 0.30·price + 0.15·delivery.
 * rating = clamp((stars − 4) / 1, 0, 1); price and delivery are min-max normalized over the remaining candidates
 * (cheapest = 1; most days before the deadline = 1; all equal → 1); pref_fit comes from widths + critical review.
 */
export function filterAndRank(results, { budget, deadline_iso, size = '10.5', width = 'wide', avoid_brands = [] } = {}) {
  const avoidBrands = (avoid_brands || []).filter(Boolean);
  const ctx = {
    avoid: new Set(avoidBrands.map(norm)),
    avoidBrands,
    budget: budget === null || budget === undefined || budget === '' ? NaN : Number(budget),
    deadline: deadline_iso ? String(deadline_iso).slice(0, 10) : null,
    size,
    width,
  };

  const filtered = [];
  const candidates = [];
  const seenKeys = new Set();
  for (const r of Array.isArray(results) ? results : []) {
    if (!r || !r.sku) continue;
    const key = `${r.store || r.merchant_id || ''}:${r.sku}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const reason = filterReason(r, ctx);
    if (reason) filtered.push({ sku: r.sku, title: r.title, reason, brand: r.brand ?? null, merchant_id: r.store || r.merchant_id || null });
    else candidates.push(r);
  }

  const todayDay = dayNumber(isoDate(today()));
  const deadlineDay = dayNumber(ctx.deadline);
  const slack = candidates.map((r) => {
    const eta = dayNumber(etaOf(r));
    if (eta === null) return NaN;
    return deadlineDay !== null ? deadlineDay - eta : todayDay - eta; // more days to spare = better
  });
  const priceN = minMax(candidates.map(priceOf), false);
  const deliveryN = minMax(slack, true);
  const scored = candidates.map((r, i) => {
    const stars = Number(r.rating && typeof r.rating === 'object' ? r.rating.stars : r.rating);
    const components = {
      price: priceN[i],
      rating: Number.isFinite(stars) ? clamp01((stars - 4) / 1) : 0,
      delivery: deliveryN[i],
      pref_fit: prefFit(r, ctx.width),
    };
    const score = WEIGHTS.rating * components.rating + WEIGHTS.pref_fit * components.pref_fit
      + WEIGHTS.price * components.price + WEIGHTS.delivery * components.delivery;
    return { r, components, score };
  });

  const best = {};
  for (const k of ['price', 'rating', 'delivery', 'pref_fit']) best[k] = Math.max(...scored.map((s) => s.components[k]));
  const isBest = (s, k) => s.components[k] >= best[k] - EPS;
  const wideContext = isWideWanted(ctx.width);

  scored.sort((a, b) => (Math.abs(b.score - a.score) > EPS ? b.score - a.score : a.r.sku < b.r.sku ? -1 : a.r.sku > b.r.sku ? 1 : 0));

  const observedAt = new Date().toISOString();
  const ranked = scored.slice(0, 3).map((s, i) => {
    const r = s.r;
    let why = WHY.fallback;
    if (wideContext && isShoe(r) && isBest(s, 'rating') && isBest(s, 'pref_fit')) why = WHY.fit;
    else if (isBest(s, 'price')) why = WHY.price;
    else if (isBest(s, 'delivery') && cushionOf(r.details) === 'max') why = WHY.delivery;
    const rating = r.rating && typeof r.rating === 'object' ? r.rating : { stars: Number(r.rating) || null, count: r.rating_count ?? r.review_count ?? null };
    return {
      option_id: 'opt_' + String(i + 1).padStart(2, '0'),
      sku: r.sku,
      merchant_id: r.store || r.merchant_id || null,
      store_name: r.store_name || null,
      title: r.title,
      brand: r.brand ?? null,
      category: r.category ?? null,
      demo_data: true,
      url: r.url || null,
      price: { amount: priceOf(r), currency: r.currency || (r.price && r.price.currency) || 'USD', observed_at: observedAt, snapshot_id: null },
      rating: { stars: rating.stars ?? null, count: rating.count ?? null },
      in_stock: r.in_stock !== false,
      delivery: { eta_date: etaOf(r), shipping_cost: Number(r.shipping_cost ?? 0) || 0, zip: DEMO_ZIP },
      seller: sellerOf(r),
      return_policy: returnPolicyOf(r),
      rank: {
        position: i + 1,
        score: round3(s.score),
        components: {
          price: round3(s.components.price),
          rating: round3(s.components.rating),
          delivery: round3(s.components.delivery),
          pref_fit: round3(s.components.pref_fit),
        },
      },
      why,
      preferences_used: preferencesUsed(r, ctx),
    };
  });

  return { ranked, filtered, matched: candidates.length };
}
