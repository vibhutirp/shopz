// Live web: read real Shopify stores over their public storefront endpoints (no key, no login).
//   GET https://<host>/search/suggest.json?q=…&resources[type]=product  → title, price, image, url, availability, description
//   GET https://<host>/products/<handle>.js                              → variants, stock, prices in cents
//   GET https://<host>/products/<handle>                                 → page HTML: schema.org Product JSON-LD, OpenGraph, visible text
// Polite by design: only on a user request, a normal browser user agent, robots.txt checked, per-store cool-down on HTTP 429.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { sha256Hex } from '../../../../packages/contracts/index.js';

// An honest agent name: Shopify's edge answers 429 to a bare Chrome user agent without the other browser headers,
// and a store can recognise (and robots.txt-target) Shopz this way.
export const AGENT_UA = 'Shopz/0.1 (personal shopping agent; fetches a page only when its user asks)';
const MAX_BYTES = 3_000_000;
const MAX_REDIRECTS = 3;

/** Normalize a user-entered store ("https://www.Allbirds.com/products/x" → "www.allbirds.com"); null when it is not a public hostname. */
export function normalizeHost(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/\.$/, '');
  if (s.length > 100 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s)) return null;
  if (isIP(s) || /(^|\.)(localhost|local|internal|lan|home|arpa|invalid|test|example)$/.test(s)) return null;
  if (!/\.[a-z]{2,}$/.test(s)) return null;
  return s;
}

/** Store label for speech and cards: "www.allbirds.com" → "allbirds.com". */
export function shopLabel(host) {
  return String(host || '').replace(/^(www|shop|store|us)\./, '');
}

const PRIVATE_V4 = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12],
  [0xc0000000, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xe0000000, 3],
];
export function isPrivateAddress(ip) {
  const v = isIP(ip);
  if (v === 4) {
    const n = ip.split('.').reduce((a, b) => ((a << 8) >>> 0) + Number(b), 0) >>> 0;
    return PRIVATE_V4.some(([base, bits]) => ((n >>> (32 - bits)) << (32 - bits)) >>> 0 === base);
  }
  if (v === 6) {
    const a = ip.toLowerCase();
    if (a === '::' || a === '::1') return true;
    if (a.startsWith('::ffff:')) return isPrivateAddress(a.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(a);
  }
  return true;
}

/** SSRF guard: every address the host resolves to must be public. */
export async function assertPublicHost(host, resolver = lookup) {
  const h = normalizeHost(host);
  if (!h) throw Object.assign(new Error('not a public store address'), { code: 'BAD_HOST' });
  let addrs;
  try { addrs = await resolver(h, { all: true }); } catch { throw Object.assign(new Error(`cannot resolve ${h}`), { code: 'DNS' }); }
  const list = Array.isArray(addrs) ? addrs : [addrs];
  if (!list.length || list.some((a) => isPrivateAddress(a.address || a))) throw Object.assign(new Error(`${h} is not a public address`), { code: 'PRIVATE' });
  return h;
}

// ---------------------------------------------------------------- robots.txt (RFC 9309 subset: groups, Allow/Disallow, * and $)
export function parseRobots(text) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === 'allow' || key === 'disallow') cur.rules.push({ allow: key === 'allow', path: val });
  }
  return groups;
}
function ruleMatches(rulePath, path) {
  if (!rulePath) return false;
  const anchored = rulePath.endsWith('$');
  const body = (anchored ? rulePath.slice(0, -1) : rulePath).split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + body + (anchored ? '$' : '')).test(path);
}
/** Longest matching rule wins, Allow wins a tie. Groups for our agent name win over "*". */
export function robotsAllows(groups, path, agent = 'shopz') {
  const a = agent.toLowerCase();
  let chosen = groups.filter((g) => g.agents.some((x) => x !== '*' && a.includes(x)));
  if (!chosen.length) chosen = groups.filter((g) => g.agents.includes('*'));
  let best = null;
  for (const g of chosen) {
    for (const r of g.rules) {
      if (!ruleMatches(r.path, path)) continue;
      const len = r.path.length;
      if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
    }
  }
  return best ? best.allow : true;
}

// ---------------------------------------------------------------- HTML readers
const decodeEntities = (s) => String(s || '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&');

/** HTML fragment → plain text with sentence breaks kept (block tags become newlines). */
export function htmlToText(html) {
  return decodeEntities(String(html || '')
    .replace(/<(script|style|noscript|template|svg|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/li|\/h[1-6]|\/div|\/tr|\/section|\/article|\/dd|\/dt)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n[ \n]*/g, '\n')
    .trim();
}

const asList = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
/** "1,299.00" → 1299, "191,95" → 191.95, "1.299,00" → 1299, 19.5 → 19.5; anything else → null. */
export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let t = String(v).trim().replace(/[^0-9.,-]/g, '');
  if (/^\d{1,3}(?:\.\d{3})*,\d{1,2}$/.test(t) || /^\d+,\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(/,/g, '');
  const n = Number(t);
  return t && Number.isFinite(n) ? n : null;
}
const firstImage = (img) => {
  for (const x of asList(img)) {
    if (typeof x === 'string' && x) return x;
    if (x && typeof x === 'object' && (x.url || x.contentUrl)) return x.url || x.contentUrl;
  }
  return null;
};
/** Absolute http(s) URL or null – never javascript:/data: (these values end up in the panel's href/src). */
const absUrl = (u, base) => {
  if (!u) return null;
  try { const x = new URL(String(u).startsWith('//') ? 'https:' + u : u, base); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch { return null; }
};

/** schema.org Product / ProductGroup from JSON-LD blocks (first product wins). */
export function parseJsonLd(html, baseUrl = 'https://example.invalid/') {
  const products = [];
  for (const m of String(html || '').matchAll(/<script[^>]+type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    const raw = m[1].trim().replace(/^<!\[CDATA\[|\]\]>$/g, '');
    try { data = JSON.parse(raw); } catch { try { data = JSON.parse(raw.replace(/[\u0000-\u001f]+/g, ' ')); } catch { continue; } }
    const stack = [data];
    while (stack.length) {
      const x = stack.shift();
      if (Array.isArray(x)) { stack.push(...x); continue; }
      if (!x || typeof x !== 'object') continue;
      if (x['@graph']) stack.push(...asList(x['@graph']));
      const types = asList(x['@type']).map(String);
      if (types.includes('Product') || types.includes('ProductGroup')) products.push(x);
    }
  }
  const p = products[0];
  if (!p) return null;
  const variants = asList(p.hasVariant);
  let offers = asList(p.offers).flatMap((o) => (o && o['@type'] === 'AggregateOffer' && o.offers ? asList(o.offers) : [o])).filter(Boolean);
  if (!offers.length && variants.length) offers = variants.flatMap((v) => asList(v.offers));
  const agg = asList(p.offers).find((o) => o && o['@type'] === 'AggregateOffer') || null;
  const offer = offers.find((o) => /InStock/i.test(String(o.availability || ''))) || offers[0] || {};
  const price = num(offer.price ?? offer.lowPrice ?? agg?.lowPrice ?? offer.priceSpecification?.price);
  const rating = p.aggregateRating && typeof p.aggregateRating === 'object' ? p.aggregateRating : null;
  const ship = asList(offer.shippingDetails)[0] || null;
  const brand = p.brand && typeof p.brand === 'object' ? p.brand.name : p.brand;
  const availability = offers.length ? (offers.some((o) => /InStock|LimitedAvailability|PreOrder/i.test(String(o.availability || ''))) ? 'in_stock'
    : offers.some((o) => /OutOfStock|SoldOut|Discontinued/i.test(String(o.availability || ''))) ? 'out_of_stock' : null) : null;
  return {
    name: p.name ? decodeEntities(String(p.name)) : null,
    brand: brand ? decodeEntities(String(brand)) : null,
    description: p.description ? htmlToText(String(p.description)) : null,
    price,
    currency: offer.priceCurrency || agg?.priceCurrency || offer.priceSpecification?.priceCurrency || null,
    availability,
    rating: rating ? num(rating.ratingValue) : null,
    rating_count: rating ? num(rating.reviewCount ?? rating.ratingCount) : null,
    image: absUrl(firstImage(p.image), baseUrl),
    url: absUrl(p.url || offer.url, baseUrl),
    sku: p.sku || offer.sku || null,
    shipping: ship ? {
      cost: num(ship.shippingRate?.value), currency: ship.shippingRate?.currency || null,
      days_max: num(ship.deliveryTime?.transitTime?.maxValue ?? ship.deliveryTime?.handlingTime?.maxValue),
    } : null,
    reviews: asList(p.review).slice(0, 5).map((r) => ({
      author: r?.author && typeof r.author === 'object' ? r.author.name : r?.author ?? null,
      rating: num(r?.reviewRating?.ratingValue), text: r?.reviewBody ? htmlToText(String(r.reviewBody)).slice(0, 400) : null,
    })).filter((r) => r.text),
  };
}

/** OpenGraph / product meta tags. */
export function parseOpenGraph(html, baseUrl = 'https://example.invalid/') {
  const meta = {};
  for (const m of String(html || '').matchAll(/<meta\s+[^>]*>/gi)) {
    const tag = m[0];
    const key = (tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const val = (tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i) || [])[1];
    if (key && val !== undefined && !(key.toLowerCase() in meta)) meta[key.toLowerCase()] = decodeEntities(val);
  }
  const price = num(meta['og:price:amount'] ?? meta['product:price:amount']);
  return {
    title: meta['og:title'] || null,
    description: meta['og:description'] || meta.description || null,
    image: absUrl(meta['og:image:secure_url'] || meta['og:image'], baseUrl),
    price,
    currency: meta['og:price:currency'] || meta['product:price:currency'] || null,
    site_name: meta['og:site_name'] || null,
  };
}

/** Visible text of the main product area (falls back to the whole body). */
export function visibleText(html, max = 20000) {
  const h = String(html || '');
  const main = (h.match(/<main\b[\s\S]*?<\/main>/i) || [])[0] || (h.match(/<body\b[\s\S]*<\/body>/i) || [])[0] || h;
  return htmlToText(main).slice(0, max);
}

export function looksBlocked(status, html) {
  if (status === 403 || status === 429 || status === 503) return true;
  return /g-recaptcha|h-captcha|cf-chl-|challenge-platform|are you a robot|verify you are human/i.test(String(html || '').slice(0, 60000));
}

// ---------------------------------------------------------------- Shopify JSON shapes
const cents = (v) => (v === null || v === undefined || v === '' ? null : Math.round(Number(v)) / 100);

/** /search/suggest.json → product summaries. */
export function parseSuggest(json, host) {
  const list = json?.resources?.results?.products;
  if (!Array.isArray(list)) return [];
  return list.filter((p) => p && p.handle && p.title).map((p) => {
    const price = num(p.price ?? p.price_min);
    const compare = num(p.compare_at_price_max);
    return {
      handle: String(p.handle),
      title: decodeEntities(String(p.title)).trim(),
      vendor: p.vendor ? decodeEntities(String(p.vendor)) : null,
      type: p.type || null,
      tags: Array.isArray(p.tags) ? p.tags.slice(0, 20).map(String) : [],
      price,
      compare_at: compare && price && compare > price ? compare : null,
      available: p.available !== false,
      image: absUrl(p.image || p.featured_image?.url, `https://${host}/`),
      url: `https://${host}/products/${encodeURIComponent(String(p.handle))}`, // always on the store itself
      description: p.body ? htmlToText(String(p.body)).slice(0, 4000) : '',
    };
  });
}

/** /products/<handle>.js → variants with stock, prices in currency units. */
export function parseProductJs(json, host) {
  if (!json || typeof json !== 'object' || !json.handle) return null;
  const optionNames = Array.isArray(json.options) ? json.options.map((o) => (typeof o === 'string' ? o : o?.name)).filter(Boolean) : [];
  const variants = (Array.isArray(json.variants) ? json.variants : []).map((v) => ({
    id: v.id, title: v.title, available: v.available !== false, price: cents(v.price), compare_at: cents(v.compare_at_price),
    options: [v.option1, v.option2, v.option3].filter((x) => x !== null && x !== undefined),
  }));
  return {
    handle: json.handle, title: decodeEntities(String(json.title || '')), vendor: json.vendor || null, type: json.type || null,
    available: json.available !== false, price: cents(json.price ?? json.price_min), option_names: optionNames, variants,
    image: absUrl(json.featured_image || (json.images || [])[0], `https://${host}/`),
    description: json.description ? htmlToText(String(json.description)).slice(0, 6000) : '',
  };
}

/** Variant for a requested size ("M", "10", "10.5") – exact option match, case-insensitive. */
export function pickVariant(variants, size) {
  const list = Array.isArray(variants) ? variants : [];
  if (!size) return list.find((v) => v.available) || list[0] || null;
  const want = String(size).toLowerCase().replace(/^size\s+/, '').trim();
  const alias = { xs: ['xs', 'x-small', 'extra small'], s: ['s', 'small'], m: ['m', 'medium'], l: ['l', 'large'], xl: ['xl', 'x-large', 'extra large'], xxl: ['xxl', '2xl', 'xx-large'] };
  const names = alias[want] || [want];
  const hit = (v) => v.options.some((o) => {
    const x = String(o).toLowerCase().trim();
    return names.includes(x) || names.some((n) => x === `${n} us` || x === `us ${n}` || x.split(/\s*[/|]\s*/).includes(n) || x.replace(/^(men'?s|women'?s|m|w)\s*/, '') === n);
  });
  return list.find((v) => hit(v) && v.available) || list.find(hit) || null;
}

// ---------------------------------------------------------------- the client
export function createShopifyClient({ fetchImpl = globalThis.fetch, resolver = lookup, now = () => Date.now(), userAgent = AGENT_UA, checkRobots = true } = {}) {
  const cool = new Map(); // host → until (ms) after HTTP 429 / Retry-After
  const robots = new Map(); // host → { at, groups }
  const hostOk = new Map(); // host → { at, ok, error }

  async function guard(host) {
    const c = hostOk.get(host);
    if (c && now() - c.at < 10 * 60 * 1000) { if (!c.ok) throw Object.assign(new Error(c.error), { code: 'BAD_HOST' }); return; }
    try { await assertPublicHost(host, resolver); hostOk.set(host, { at: now(), ok: true }); } catch (err) { hostOk.set(host, { at: now(), ok: false, error: err.message }); throw err; }
  }

  async function raw(url, { timeoutMs = 8000, accept = 'application/json' } = {}) {
    let u = new URL(url);
    if (u.protocol !== 'https:') throw new Error('https only');
    const until = cool.get(u.host);
    if (until && until > now()) throw Object.assign(new Error(`${shopLabel(u.host)} asked us to slow down`), { status: 429, cooling: true });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        await guard(u.host);
        const res = await fetchImpl(u.href, {
          redirect: 'manual', signal: ac.signal,
          headers: { 'user-agent': userAgent, accept, 'accept-language': 'en-US,en;q=0.9' },
        });
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          const next = new URL(res.headers.get('location'), u);
          if (next.protocol !== 'https:') throw new Error('redirect to non-https');
          u = next;
          continue;
        }
        if (res.status === 429) {
          const ra = Number(res.headers.get('retry-after'));
          cool.set(u.host, now() + (Number.isFinite(ra) && ra > 0 ? Math.min(ra, 300) : 60) * 1000);
        }
        const reader = res.body && res.body.getReader ? res.body.getReader() : null;
        let text = '';
        if (reader) {
          const chunks = []; let size = 0;
          for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > MAX_BYTES) { try { await reader.cancel(); } catch { /* ignore */ } break; } chunks.push(value); }
          text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
        } else text = await res.text();
        return { status: res.status, text, url: u.href, host: u.host };
      }
      throw new Error('too many redirects');
    } catch (err) {
      if (err && err.name === 'AbortError') throw Object.assign(new Error(`timeout after ${Math.round(timeoutMs / 1000)} s`), { timeout: true });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function allowed(host, path) {
    if (!checkRobots) return true;
    let r = robots.get(host);
    if (!r || now() - r.at > 30 * 60 * 1000) {
      try {
        const res = await raw(`https://${host}/robots.txt`, { timeoutMs: 4000, accept: 'text/plain' });
        r = { at: now(), groups: res.status === 200 ? parseRobots(res.text) : [] };
      } catch { r = { at: now(), groups: [] }; }
      robots.set(host, r);
    }
    return robotsAllows(r.groups, path);
  }

  async function getJson(host, path, opts) {
    if (!(await allowed(host, path.split('?')[0]))) throw Object.assign(new Error(`robots.txt of ${shopLabel(host)} disallows ${path.split('?')[0]}`), { code: 'ROBOTS' });
    const res = await raw(`https://${host}${path}`, opts);
    if (res.status !== 200) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    try { return { json: JSON.parse(res.text), url: res.url }; } catch { throw new Error('store did not answer with JSON'); }
  }

  /** Product search on one store → { products, ms }. */
  async function search(host, query, { limit = 6, timeoutMs = 8000 } = {}) {
    const t0 = now();
    const qs = `q=${encodeURIComponent(query)}&resources[type]=product&resources[limit]=${limit}&resources[options][unavailable_products]=last`;
    const { json, url } = await getJson(host, `/search/suggest.json?${qs}`, { timeoutMs });
    const finalHost = new URL(url).host;
    return { products: parseSuggest(json, finalHost), ms: now() - t0, host: finalHost };
  }

  /** Variants + stock for one product. */
  async function product(host, handle, { timeoutMs = 8000 } = {}) {
    const { json } = await getJson(host, `/products/${encodeURIComponent(handle)}.js`, { timeoutMs });
    return parseProductJs(json, host);
  }

  /** Product page: JSON-LD, OpenGraph, visible text, sha256 of the HTML. */
  async function page(host, handle, { timeoutMs = 12000 } = {}) {
    const path = `/products/${encodeURIComponent(handle)}`;
    if (!(await allowed(host, path))) throw Object.assign(new Error(`robots.txt of ${shopLabel(host)} disallows ${path}`), { code: 'ROBOTS' });
    const t0 = now();
    const res = await raw(`https://${host}${path}`, { timeoutMs, accept: 'text/html,application/xhtml+xml' });
    const jsonld = res.status === 200 ? parseJsonLd(res.text, res.url) : null;
    const og = res.status === 200 ? parseOpenGraph(res.text, res.url) : null;
    // A 200 page with product data is never "blocked" (many stores ship a captcha script for their newsletter form).
    if (!(jsonld || og?.title) && looksBlocked(res.status, res.text)) throw Object.assign(new Error(res.status === 429 ? `${shopLabel(host)} asked us to slow down` : `${shopLabel(host)} shows a bot check`), { status: res.status, blocked: true });
    if (res.status !== 200) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    return {
      url: res.url, status: res.status, ms: now() - t0, bytes: res.text.length, html_sha256: sha256Hex(res.text),
      jsonld, og, text: visibleText(res.text),
    };
  }

  return { search, product, page, allowed, cooling: (host) => (cool.get(host) || 0) > now() };
}
