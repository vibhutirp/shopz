// Live web: turn a free shopping request into { query, category, budget, size }.
// Regex first (instant, always available); an optional small local model (Ollama, JSON mode) may refine it.
import { parseBudget } from '../dates.js';

export const LIVE_CATEGORIES = Object.freeze({
  running_shoes: { label: 'running shoes', query: 'running shoes', core: 'shoes', re: /\b(?:running|trail|road|race|racing|marathon)?\s*(?:shoes?|sneakers?|runners?|trainers?|kicks)\b/i },
  headphones: { label: 'headphones', query: 'headphones', core: 'headphones', re: /\b(?:head\s?phones?|ear\s?buds?|earphones?|headsets?|in-ears?|over-ears?)\b/i },
  coffee: { label: 'coffee', query: 'coffee', core: 'coffee', re: /\b(?:coffee|espresso|decaf|cold brew|whole beans?|ground beans?|beans?|roast)\b/i },
  clothing: { label: 'clothing', query: 'jacket', core: 'jacket', re: /\b(?:jackets?|coats?|parkas?|shell|rain\s?wear|shirts?|t-shirts?|tees?|hoodies?|sweaters?|sweatshirts?|pants|trousers|shorts|leggings|tights|joggers?|socks|vests?|dress(?:es)?|jeans|beanies?|hats?|caps?)\b/i },
});

const LEAD = /^(?:(?:hi|hey|hello|ok(?:ay)?|so|well|actually|now|please|shopz|um+|uh+|and|also|then|instead)\s+|(?:can|could|would) you\s+(?:please\s+)?|i(?:'d| would)? (?:like|love|want)(?: to (?:buy|get|find|order|see))?\s+|i(?:'m| am) (?:looking|searching|shopping) for\s+|(?:i )?(?:really )?(?:need|want)(?: to (?:buy|get|find|order))?\s+|(?:look|search|shop) for\s+|looking for\s+|(?:find|get|show|buy|order|grab|pick)(?: me| us)?\s+|help me (?:find|buy|choose|pick)\s+|me\s+|some\s+|an?\s+|the\s+|new\s+|good\s+|great\s+|nice\s+|cheap\s+|(?:a )?pairs? of\s+|(?:a )?(?:bag|box|pack) of\s+)+/i;
const BUDGET = /\b(?:for\s+)?(?:under|below|less than|max(?:imum)?|at most|up to|no more than|not more than|budget(?:\s+(?:of|is|around|about))?|around|about|cap(?:ped)? at|tops)\s*(?:of\s*)?(?:\$|usd\s*)?\s*\d+(?:\.\d{1,2})?\s*(?:dollars|bucks|usd|\$)?|\$\s*\d+(?:\.\d{1,2})?|\b\d+(?:\.\d{1,2})?\s*(?:dollars|bucks|usd)\b/gi;
const SIZE = /\b(?:in\s+)?(?:a\s+)?(?:men'?s\s+|women'?s\s+)?size\s+(\d{1,2}(?:\.5)?|xxs|xs|s|m|l|xl|xxl|2xl|3xl|small|medium|large|x-?large)\b/i;
const CUT = /\s+(?:for|by|that|which|who|with|so|before|until|to|because|in time|this|next|within|arriving|delivered|please|instead|today|tomorrow|tonight)\b.*$/i;
const SIZE_WORD = { small: 'S', medium: 'M', large: 'L', 'x-large': 'XL', xlarge: 'XL' };

export function detectLiveCategory(text) {
  const t = String(text || '');
  // Coffee first: "coffee beans" must not become clothing; headphones before shoes ("running headphones").
  for (const id of ['coffee', 'headphones', 'running_shoes', 'clothing']) if (LIVE_CATEGORIES[id].re.test(t)) return id;
  return null;
}

export function parseSize(text) {
  const m = String(text || '').match(SIZE);
  if (!m) return null;
  const v = m[1].toLowerCase();
  return SIZE_WORD[v] || (/^\d/.test(v) ? v : v.toUpperCase());
}

/** Does this sentence ask for a (new) product search? */
export function looksLikeRequest(text) {
  const t = String(text || '').trim();
  if (detectLiveCategory(t)) return true;
  return /^(?:(?:can|could|would) you\s+)?(?:(?:please\s+)?(?:find|search|look for|shop for|get me|show me some|i need|i want|i'?m looking for|looking for|buy me|order me))\b/i.test(t)
    && !/\b(?:this|that|it|one|option|first|second|third|next|previous|reviews?|returns?|shipping|delivery|price)\b\s*[.!?]?$/i.test(t);
}

/** "I need wireless headphones under $100 by Friday" → { query: "wireless headphones", category: "headphones", budget: 100, size: null }. */
export function parseLiveRequest(text) {
  const raw = String(text || '').trim();
  const budget = parseBudget(raw);
  const size = parseSize(raw);
  const category = detectLiveCategory(raw);
  let q = raw.replace(/[“”"]/g, ' ').replace(/[!?.,;:]+(\s|$)/g, ' ').replace(BUDGET, ' ').replace(SIZE, ' ').replace(/\s+/g, ' ').trim();
  q = q.replace(LEAD, '').replace(CUT, '').replace(/\b(?:please|thanks|thank you)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  q = q.replace(/^(?:for|on|at|from)\s+/i, '').replace(/[^\p{L}\p{N}'&+ -]/gu, ' ').replace(/\s+/g, ' ').trim();
  const words = q.split(' ').filter(Boolean);
  if (words.length > 5) q = words.slice(-5).join(' ');
  if (!q || q.length < 2) q = category ? LIVE_CATEGORIES[category].query : '';
  return { query: q.toLowerCase(), category, budget, size, source: 'rules' };
}

const LLM_SYSTEM = 'You turn a shopping request into JSON. Reply with JSON only: {"query": "<2-4 word product search phrase>", "category": "running_shoes|headphones|coffee|clothing|other", "budget": <number or null>, "size": "<size or null>"}. Never add anything that is not in the request.';

/** Optional refinement by a small local model (Ollama /api/chat, JSON mode). Returns null on any problem. */
export async function refineWithLocalModel(text, { url = process.env.LIVE_LLM_URL, model = process.env.LIVE_LLM_MODEL || 'qwen2.5:3b-instruct', timeoutMs = 3500, fetchImpl = globalThis.fetch } = {}) {
  if (!url) return null;
  try {
    const res = await fetchImpl(`${String(url).replace(/\/+$/, '')}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ model, stream: false, format: 'json', options: { temperature: 0, num_predict: 80 }, messages: [{ role: 'system', content: LLM_SYSTEM }, { role: 'user', content: String(text).slice(0, 400) }] }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const out = JSON.parse(String(j?.message?.content || '{}'));
    const query = typeof out.query === 'string' ? out.query.toLowerCase().replace(/[^\p{L}\p{N}'&+ -]/gu, ' ').replace(/\s+/g, ' ').trim() : '';
    if (!query || query.split(' ').length > 6) return null;
    // The model may only narrow what the user said: every query word must appear in the request.
    const said = String(text).toLowerCase();
    if (!query.split(' ').every((w) => said.includes(w.replace(/s$/, '')))) return null;
    return {
      query,
      category: Object.hasOwn(LIVE_CATEGORIES, out.category) ? out.category : null,
      budget: Number.isFinite(Number(out.budget)) && Number(out.budget) > 0 ? Number(out.budget) : null,
      size: typeof out.size === 'string' && out.size.trim() && out.size.length <= 6 ? out.size.trim() : null,
    };
  } catch {
    return null;
  }
}
