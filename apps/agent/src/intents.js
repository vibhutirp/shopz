// Shopz – intent router. Regex first, sentence by sentence. Pure, no I/O.
// route(text, { state, optionCount, options }) → [{ intent, args }]

const CATEGORY_RULES = [
  ['running_shoes', /\b(shoes?|sneakers?|running|runners?|trainers?)\b/i],
  ['coffee', /\b(coffee|beans?|espresso|roast|blend)\b/i],
];

/** Category from free text: shoe/shoes/sneaker/running → running_shoes; coffee/beans/espresso → coffee. */
export function detectCategory(text) {
  const t = String(text || '');
  for (const [category, re] of CATEGORY_RULES) if (re.test(t)) return category;
  return null;
}

const ORDINAL_INDEX = {
  first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2, fourth: 3, '4th': 3, fifth: 4, '5th': 4,
};
const NUMBER_INDEX = { one: 0, two: 1, three: 2, four: 3, five: 4, 1: 0, 2: 1, 3: 2, 4: 3, 5: 4 };

const LEAD_FILLER = /^(?:(?:wait|hold on|hang on|one sec(?:ond)?|ok(?:ay)?|alright|all right|right|hmm+|h?um+|uh+|er+m?|so|and|well|hey|oh|actually|now|cool|great|nice|perfect|sorry|please|shopz)\s+)+/;
const TRAIL_FILLER = /(?:\s+(?:please|thanks|thank you|for me|now|right now))+$/;
const FILLER_ONLY = /^(?:wait|hold on|hang on|one sec(?:ond)?|ok(?:ay)?|alright|all right|right|hmm+|h?um+|uh+|er+m?|so|well|hey|oh|cool|great|nice|perfect|sorry|thanks|thank you|got it|i see|interesting|mhm|uh huh|wow)$/;

const AFFIRM = /^(?:(?:yes|yeah|yep|yup|sure|ok|okay|alright|please|absolutely|definitely|go ahead|do it|please do|sounds good|let'?s do it|lets do it|that one)\s*)+$/;
const REORDER = /\b(?:re-?\s?order|order (?:it |that |them |this )?again|buy (?:it |that |them |this )?again|(?:get|buy|order) (?:me )?(?:my |the )?usual|my usual|the usual)\b/;
// A negated reorder ("don't reorder", "reorder nothing") is never a reorder.
const NO_REORDER = /\b(?:don'?t|do not|never|no need to|not)\b.*\b(?:re-?\s?order|usual|again)\b|\b(?:re-?\s?order|order|buy)\s+(?:nothing|none|anything)\b/;
const isReorder = (n) => REORDER.test(n) && !NO_REORDER.test(n);
const CANCEL = /^(?:(?:no|nope|nah)(?:\s+(?:thanks|thank you|don'?t|do not|buy|it|that|this|them|cancel|stop|please))*|cancel(?: it| that| this| the order| the purchase| purchase| order)?|never ?mind|don'?t(?: buy(?: it| that| this| them)?)?|do not buy(?: it| that| this| them)?|stop|forget (?:it|that|about it)|i changed my mind|not now|abort)$/;
const ALT_PHRASE = /^(?:the )?(?:cheaper|cheapest|other)(?: one| option| pair)?(?: instead)?$/;
const ALT_VERB = /^(?:(?:i'?ll|i will|let'?s|lets|just|please|can you|could you|i'?d rather)\s+)*(?:get|take|go with|buy|do|switch to|try|order|have)\b.*\b(?:instead|cheaper|cheapest|other one|alternative)\b/;
const SELECT_PREFIX = /^(?:(?:i'?ll|i will|i'?d like to|i would like to|i want to|let'?s|lets|please|can you|could you|go ahead and|just|ok|okay|yes|yeah|then|i)\s+)+/;
const BUY_VERB = /^(?:buy|purchase|order|checkout|check out)\b\s*(.*)$/;
const PICK_VERB = /^(?:take|get|grab|go with|choose|pick|have|want|do|'d like|would like)\b\s*(.*)$/;
const NEXT = /^(?:(?:show me|go to|open|let'?s see|lets see|on to|onto|and|what about|how about)\s+)?(?:the\s+)?next(?:\s+(?:one|option|pair|pick|product|shoe|item))?(?:\s+please)?$|^skip(?: it| this(?: one)?| that(?: one)?)?$|^move on$|^keep going$|^continue$|^go on$|^another one$|^what'?s next$/;
const BACK = /^(?:go |take me |jump |head )?back(?: please)?$|^(?:go )?back to the previous(?: one| option| page| product)?$|\bprevious (?:one|option|page|product|pair|shoe)\b|^previous$|^the one before$|^(?:go )?back one$/;
const ORDINAL_REF = /\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|last)(?:\s+(?:one|option|pair|pick|shoe|shoes|product|item))?\b(?!\s+(?:review|reviews|photo|photos|picture|image|section|sentence|line|word|time))/;
const NUMBER_REF = /\b(?:option|number|no|pick)\s*#?\s*(one|two|three|four|five|[1-5])\b/;
const NAV_VERB = /\b(?:show|open|go|back|see|look|switch|take me|jump|return|bring up|pull up|about)\b/;
const QUESTION_START = /^(?:is|are|was|were|does|do|did|can|could|will|would|should|has|have|had|what|what'?s|whats|how|how'?s|why|when|where|which|who|whose|any)\b/;
const SHOW_VERB = /^(?:(?:can you|could you|would you|please|and)\s+)?(?:show|open|scroll|go|jump|take me|bring up|pull up|display|let me see|let'?s see|lets see|can i see|could i see|i want to see|i'?d like to see|read|check|look at|see|what about|how about|switch to|give me)\b/;
const SECTION_QUESTION = /^(?:what'?s|what is|what are|what do|what does|how'?s|how is|how are|how do|tell me about|tell me|read me|give me|any)\b/;
const SECTION_REST_OK = /^(?:the|its|it'?s|their|this|for|on|of|about|say|says|like|look|looks|it|one|here|them|they|me|in|to|me|please|again|section|page|\s)*$/;

const SECTION_PATTERNS = [
  ['returns', /\b(?:return policy|returns?|refunds?|exchanges?|send (?:it|them) back)\b/],
  ['reviews', /\b(?:reviews?|ratings?|stars|what (?:do )?(?:people|customers|buyers|others|runners) (?:say|think)|feedback)\b/],
  ['specs', /\b(?:specs?|specifications?|tech(?:nical)? details|details|features)\b/],
  ['delivery', /\b(?:delivery|shipping|arrival)\b/],
  ['gallery', /\b(?:gallery|photos?|pictures?|images?|pics)\b/],
  ['price', /\b(?:price|pricing|cost)\b/],
  ['seller', /\b(?:seller|sold by|who sells (?:it|them|this))\b/],
];

/** Lower-case, unify quotes/dashes, drop punctuation (keeps apostrophes and digits). */
export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[“”"]/g, ' ')
    .replace(/[–—]/g, ' ')
    .replace(/\s-\s/g, ' ')
    .replace(/[.,!?;:()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripFillers(n) {
  let out = n;
  for (let i = 0; i < 3; i += 1) {
    const before = out;
    if (!FILLER_ONLY.test(out)) out = out.replace(LEAD_FILLER, '');
    out = out.replace(TRAIL_FILLER, '').trim();
    if (out === before) break;
  }
  return out;
}

/** Split an utterance into sentences ("Go back to the first one. Buy that." → 2). */
export function splitSentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=\S)|;\s+|\s+and then\s+|,?\s+and\s+(?=(?:buy|purchase|order|get|take|grab|go with|check out|checkout)\b)/i)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** True when the text carries no command at all ("Wait.", "Okay, hmm."). */
export function isFillerOnly(text) {
  const parts = splitSentences(text);
  if (!parts.length) return true;
  return parts.every((p) => {
    const n = stripFillers(normalize(p));
    return !n || FILLER_ONLY.test(n);
  });
}

function brandIndex(n, ctx) {
  const options = Array.isArray(ctx?.options) ? ctx.options : [];
  for (let i = 0; i < options.length; i += 1) {
    const brand = String(options[i]?.brand || '').toLowerCase().trim();
    if (brand && new RegExp(`\\b${brand.replace(/[^a-z0-9 ]/g, '')}\\b`).test(n)) return i;
  }
  for (let i = 0; i < options.length; i += 1) {
    const words = String(options[i]?.title || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
    const model = words[1];
    if (model && !['wide', 'mens', "men's"].includes(model) && new RegExp(`\\b${model}\\b`).test(n)) return i;
  }
  return -1;
}

/** Which option a phrase points at → { index } | { current: true } | null. */
export function parseTarget(n, ctx = {}) {
  const count = ctx.optionCount || 3;
  let m = n.match(ORDINAL_REF);
  if (m) return { index: m[1] === 'last' ? count - 1 : ORDINAL_INDEX[m[1]] };
  m = n.match(NUMBER_REF);
  if (m) return { index: NUMBER_INDEX[m[1]] };
  const b = brandIndex(n, ctx);
  if (b >= 0) return { index: b };
  if (/\b(?:it|that|this|them|these|those|this one|that one|the one|this pair|that pair)\b/.test(n)) return { current: true };
  return null;
}

function sectionOf(n) {
  for (const [section, re] of SECTION_PATTERNS) {
    const m = n.match(re);
    if (m) return { section, match: m[0] };
  }
  return null;
}

function matchSection(n) {
  const hit = sectionOf(n);
  if (!hit) {
    if (/^how much(?: is it| does it cost| is this(?: one)?| are they| do they cost| is that)?$/.test(n)) return 'price';
    return null;
  }
  const rest = n.replace(hit.match, ' ').replace(/\s+/g, ' ').trim();
  if (SHOW_VERB.test(n)) return hit.section;
  if (SECTION_REST_OK.test(rest)) return hit.section; // "reviews", "the reviews", "returns?"
  if (SECTION_QUESTION.test(n)) {
    const tail = rest.replace(SECTION_QUESTION, '').trim();
    if (SECTION_REST_OK.test(tail)) return hit.section; // "what's the return policy", "what do the reviews say"
  }
  return null;
}

function matchSelect(n, ctx) {
  const core = n.replace(SELECT_PREFIX, '').trim();
  let m = core.match(BUY_VERB);
  if (m) {
    const rest = m[1].trim();
    if (!rest || /^(?:it|that|this|them|this one|that one|now|it now|these|those)$/.test(rest)) return { intent: 'select', args: {} };
    const t = parseTarget(rest, ctx);
    if (t) return { intent: 'select', args: t.index != null ? { index: t.index } : {} };
    return null;
  }
  m = core.match(PICK_VERB);
  if (m) {
    const t = parseTarget(m[1].trim(), ctx);
    if (t) return { intent: 'select', args: t.index != null ? { index: t.index } : {} };
  }
  return null;
}

function matchGoto(n, ctx) {
  const m = n.match(ORDINAL_REF) || n.match(NUMBER_REF);
  if (m) {
    const t = parseTarget(n, ctx);
    if (t && t.index != null) return { intent: 'goto_option', args: { index: t.index } };
  }
  const b = brandIndex(n, ctx);
  if (b >= 0 && (NAV_VERB.test(n) || /^(?:the )?\w+(?: \w+)?(?: one| again| please)?$/.test(n))) {
    return { intent: 'goto_option', args: { index: b } };
  }
  return null;
}

// ---------------------------------------------------------------- cart
const QTY_WORD = { a: 1, an: 1, one: 1, another: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, couple: 2, pair: 1 };
const QTY_RE = /^(?:(\d{1,2})|(a|an|one|another|two|three|four|five|six|seven|eight|nine|ten))\b\s*(?:more\s+)?(?:of\s+)?/;
const CART_WORD = /\b(?:cart|basket|bag)\b/;
const CART_NOUN = '(?:shopping\\s+)?(?:cart|basket)';
const CART_SHOW = new RegExp(`^(?:(?:can you |could you |please )?(?:show|open|view|see|check|let me see|pull up|bring up)\\s+(?:me\\s+)?(?:my|the)\\s+${CART_NOUN}|(?:what'?s|whats|what is|what do i have|what have i got)\\s+in\\s+(?:my|the)\\s+${CART_NOUN}|(?:my|the)\\s+${CART_NOUN}|${CART_NOUN}|(?:how much is|what'?s|whats|what is)\\s+(?:my|the)\\s+${CART_NOUN}(?:\\s+total)?(?:\\s+in total)?|(?:my\\s+|the\\s+)?${CART_NOUN}\\s+total)(?:\\s+(?:right now|so far|now))?$`);
const CART_CHECKOUT_ANY = new RegExp(`^(?:(?:i'?d like to|i want to|let'?s|lets|go ahead and|please|can you|could you)\\s+)*(?:check ?out|checkout|buy|purchase|order|pay for|get)\\s+(?:(?:everything|all|it all|all of it|all of them|all items|all the items|the items)(?:\\s+in\\s+(?:my|the)\\s+${CART_NOUN})?|(?:my|the)\\s+(?:whole\\s+)?${CART_NOUN}|what'?s in (?:my|the) ${CART_NOUN}|everything i (?:added|have))(?:\\s+now)?$`);
const CART_CHECKOUT_BARE = /^(?:(?:i'?d like to|i want to|let'?s|lets|go ahead and|please|ok|okay|then)\s+)*(?:check ?out|checkout|place (?:the|my) order|proceed to checkout|go to checkout)(?:\s+now)?$/;
const CART_ADD = new RegExp(`^(?:(?:can you|could you|please|also|and|then|i'?d like to|i want to|let'?s|lets|go ahead and)\\s+)*(?:add|put|throw|toss|stick|pop)\\s+(.*?)\\s*(?:(?:in|into|to|onto)\\s+(?:my|the)\\s+${CART_NOUN})?(?:\\s+(?:too|as well|also|please))*$`);
const CART_ADD_BARE = /^(?:(?:please|also)\s+)?add (?:it |this |that |this one |that one )?to (?:the |my )?cart$|^add to cart$/;
const CART_CLEAR = new RegExp(`^(?:(?:please|can you|could you)\\s+)?(?:empty|clear|reset)\\s+(?:my|the)\\s+${CART_NOUN}$|^(?:remove|delete|take out)\\s+everything(?:\\s+from\\s+(?:my|the)\\s+${CART_NOUN})?$`);
const CART_REMOVE = new RegExp(`^(?:(?:please|can you|could you|actually)\\s+)*(?:remove|delete|drop|take)\\s+(.+?)(?:\\s+(?:from|out of|off)\\s+(?:my|the)\\s+${CART_NOUN}|\\s+out(?:\\s+of\\s+(?:my|the)\\s+${CART_NOUN})?)?$`);
const CART_QTY = /^(?:(?:please|can you|could you|actually)\s+)*(?:make|change|set|update|turn)\s+(.*?)\s*(?:to|into)?\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b(.*)$/;

const qtyOf = (w) => (/^\d+$/.test(w) ? Number(w) : QTY_WORD[w] ?? null);

/** "two of these" → { qty: 2, rest: 'these' }; "the coffee" → { qty: 1, rest: 'the coffee' }. */
function splitQty(text) {
  const t = String(text || '').trim();
  const m = t.match(QTY_RE);
  if (!m) return { qty: 1, rest: t };
  const q = m[1] ? Number(m[1]) : qtyOf(m[2]);
  const rest = t.slice(m[0].length).trim();
  // "one" on its own is a pronoun ("add that one"), not a quantity
  if (!rest && (m[2] === 'one' || m[2] === 'a' || m[2] === 'an')) return { qty: 1, rest: t };
  return { qty: q || 1, rest };
}

/** Cart commands. ctx.cartCount = lines in the cart (bare "check out" / "remove the shoes" only mean the cart then). */
export function matchCart(n, ctx = {}) {
  const lines = Number(ctx.cartCount) || 0;
  if (!n) return null;
  if (CART_SHOW.test(n)) return { intent: 'cart_show', args: {} };
  if (CART_CHECKOUT_ANY.test(n)) return { intent: 'cart_checkout', args: {} };
  if (lines > 0 && CART_CHECKOUT_BARE.test(n)) return { intent: 'cart_checkout', args: {} };
  if (CART_CLEAR.test(n)) return { intent: 'cart_remove', args: { all: true } };
  if (CART_ADD_BARE.test(n)) return { intent: 'cart_add', args: { target: 'this', qty: 1 } };
  let m = n.match(CART_ADD);
  if (m && (CART_WORD.test(n) || /^(?:(?:please|also|and|then)\s+)*add\b/.test(n))) {
    const { qty, rest } = splitQty(m[1].replace(/\b(?:too|as well|also)\b/g, '').trim());
    return { intent: 'cart_add', args: { target: rest || 'this', qty } };
  }
  m = n.match(CART_REMOVE);
  // "remove …" can only mean the cart here; "take … out" needs a cart word or a non-empty cart ("take the first one" picks).
  if (m && (CART_WORD.test(n) || /^(?:(?:please|can you|could you|actually)\s+)*(?:remove|delete)\b/.test(n) || (lines > 0 && (/^(?:(?:please|can you|could you|actually)\s+)*drop\b/.test(n) || /\bout$/.test(n))))) {
    if (!/^(?:(?:please|can you|could you|actually)\s+)*take\b/.test(n) || /\bout\b/.test(n)) {
      return { intent: 'cart_remove', args: { target: m[1].trim() } };
    }
  }
  m = n.match(CART_QTY);
  if (m && (CART_WORD.test(n) || lines > 0)) {
    const qty = qtyOf(m[2]);
    const target = `${m[1]} ${m[3] || ''}`.replace(/\b(?:the quantity of|quantity|qty|of)\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (qty !== null) return { intent: 'cart_qty', args: { target: target || 'it', qty } };
  }
  return null;
}

function routeSentence(raw, ctx) {
  const n = stripFillers(normalize(raw));
  if (!n || FILLER_ONLY.test(n)) return null;
  const state = ctx.state || 'IDLE';
  const cart = matchCart(n, ctx);
  if (cart) return cart;

  if (n.replace(/^(?:yes|yeah|yep)\s+/, '') === 'confirm purchase') return { intent: 'confirm', args: { transcript: raw } };
  if (isReorder(n)) return { intent: 'reorder', args: { category: detectCategory(n) } };
  if (CANCEL.test(n)) return { intent: 'cancel', args: {} };
  if (ALT_PHRASE.test(n) || ALT_VERB.test(n) || (/\binstead\b/.test(n) && parseTarget(n, ctx)?.index != null)) {
    const t = parseTarget(n.replace(/\b(?:the )?(?:other|cheaper|cheapest) one\b/, ''), ctx);
    const b = brandIndex(n, ctx);
    const hint = b >= 0 ? String(ctx.options[b].brand || '').toLowerCase() : /cheap/.test(n) ? 'cheaper' : 'other';
    return { intent: 'alternative', args: t?.index != null ? { hint, index: t.index } : { hint } };
  }
  if ((state === 'APPROVE' || state === 'AWAIT_CHOICE') && AFFIRM.test(n)) return { intent: 'select', args: { affirm: true } };
  const sel = matchSelect(n, ctx);
  if (sel) return sel;
  if (NEXT.test(n)) return { intent: 'next', args: {} };
  const g = matchGoto(n, ctx);
  if (g) return g;
  if (BACK.test(n)) return { intent: 'back', args: {} };
  const section = matchSection(n);
  if (section) return { intent: 'show_section', args: { section } };
  if (/\?\s*$/.test(raw) || QUESTION_START.test(n)) return { intent: 'ask', args: { question: raw.trim() } };
  return null;
}

function routeSentences(text, ctx) {
  const out = [];
  for (const sentence of splitSentences(text)) {
    const r = routeSentence(sentence, ctx);
    if (r) out.push(r);
  }
  for (const r of out) if (r.intent === 'confirm') r.args.transcript = String(text).trim();
  return out;
}

/**
 * Map one utterance to intents. Unknown text in IDLE → request; in CLARIFY → answer_clarify;
 * elsewhere a question → ask; nothing recognisable → [] (caller may ask the LLM, then help text).
 */
export function route(text, ctx = { state: 'IDLE', optionCount: 3 }) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const c = { optionCount: 3, ...ctx };
  const state = c.state || 'IDLE';
  const whole = stripFillers(normalize(raw));

  // Cart commands work in every state ("what's in my cart?" while a question is open, too).
  const parts = splitSentences(raw).filter((p) => !isFillerOnly(p));
  if (parts.some((p) => matchCart(stripFillers(normalize(p)), c))) {
    if (state === 'IDLE' || state === 'CLARIFY' || state === 'DONE') {
      return parts.map((p) => matchCart(stripFillers(normalize(p)), c) || (state === 'CLARIFY' ? { intent: 'answer_clarify', args: { text: p } } : routeSentence(p, c) || { intent: 'request', args: { text: p } })).filter(Boolean);
    }
    return routeSentences(raw, c);
  }

  if (state === 'IDLE' || state === 'CLARIFY' || state === 'DONE') {
    if (isReorder(whole)) return [{ intent: 'reorder', args: { category: detectCategory(raw) } }];
    if (state === 'CLARIFY') {
      if (CANCEL.test(whole)) return [{ intent: 'cancel', args: {} }];
      return [{ intent: 'answer_clarify', args: { text: raw } }];
    }
    if (state === 'DONE' && !detectCategory(raw) && Array.isArray(c.options) && c.options.length) {
      const parts = splitSentences(raw).filter((p) => !isFillerOnly(p));
      const routed = routeSentences(raw, c);
      const navOnly = ['show_section', 'next', 'back', 'goto_option', 'ask'];
      if (routed.length && routed.length === parts.length && routed.every((r) => navOnly.includes(r.intent))) return routed;
    }
    return [{ intent: 'request', args: { text: raw } }];
  }
  return routeSentences(raw, c);
}
