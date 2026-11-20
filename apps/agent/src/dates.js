// Shopz – deadline and budget parsing for shopping requests. Pure functions, no I/O.
import { today, isoDate, addDays } from '../../../packages/contracts/index.js';

const WEEKDAY_INDEX = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};
const FULL_WEEKDAYS = new Set(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']);
const MONTH_INDEX = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3, may: 4, june: 5, jun: 5,
  july: 6, jul: 6, august: 7, aug: 7, september: 8, sep: 8, sept: 8, october: 9, oct: 9,
  november: 10, nov: 10, december: 11, dec: 11,
};
const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30,
  'a couple of': 2, 'couple of': 2, 'a couple': 2, 'a few': 3, few: 3,
};
const UNIT_DAYS = { day: 1, week: 7, month: 30 };

// A date phrase next to one of these words describes an event, not the date the goods are needed by.
const EVENT_WORDS = /\b(marathon|half|race|run|10k|5k|triathlon|trip|vacation|holiday|wedding|party|event|hike|competition|tournament|game|match|meet|birthday|conference|flight)\b/i;
const NEED_BY = /^(by|before|until|till|within|no later than)$/i;

const WD = '(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|wed|thurs|thur|thu|fri|sat)';
const MON = '(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)';
const PREP = '(?:(by|before|until|till|on|no later than)\\s+)?';
const NUM = '(\\d+|a couple of|couple of|a couple|a few|few|an|a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|twenty|thirty)';

function noon(d) {
  const c = new Date(d.getTime());
  c.setHours(12, 0, 0, 0);
  return c;
}

function daysBetween(a, b) {
  return Math.round((noon(b).getTime() - noon(a).getTime()) / 86400000);
}

function numberOf(word) {
  if (/^\d+$/.test(word)) return Number(word);
  return NUMBER_WORDS[word] ?? null;
}

function explicitDate(now, month, day, year) {
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  let y = year != null ? (year < 100 ? 2000 + year : year) : now.getFullYear();
  let d = new Date(y, month, day, 12, 0, 0, 0);
  if (d.getMonth() !== month) return null;
  if (year == null && daysBetween(now, d) < 0) {
    y += 1;
    d = new Date(y, month, day, 12, 0, 0, 0);
  }
  return d;
}

/** Next occurrence of a weekday strictly after `now`; with `nextWord` it must also be at least 2 days away. */
function weekdayDate(now, wd, nextWord) {
  for (let i = 1; i <= 14; i += 1) {
    const d = addDays(noon(now), i);
    if (d.getDay() !== wd) continue;
    if (nextWord && i < 2) continue;
    return d;
  }
  return null;
}

function collectCandidates(text, now) {
  const t = String(text || '').toLowerCase().replace(/[’']/g, "'");
  const out = [];
  const push = (index, prep, date, kind) => { if (date) out.push({ index, prep: prep || '', date, kind }); };
  let m;

  const numeric = /\b(?:(by|before|until|till|on)\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g;
  while ((m = numeric.exec(t))) push(m.index, m[1], explicitDate(now, Number(m[2]) - 1, Number(m[3]), m[4] ? Number(m[4]) : null), 'date');

  const monthDay = new RegExp(`\\b${PREP}${MON}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'g');
  while ((m = monthDay.exec(t))) push(m.index, m[1], explicitDate(now, MONTH_INDEX[m[2]], Number(m[3]), null), 'date');

  const dayMonth = new RegExp(`\\b${PREP}(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON}\\b`, 'g');
  while ((m = dayMonth.exec(t))) push(m.index, m[1], explicitDate(now, MONTH_INDEX[m[3]], Number(m[2]), null), 'date');

  const weekday = new RegExp(`\\b${PREP}(?:(this|next|coming)\\s+)?${WD}\\b`, 'g');
  while ((m = weekday.exec(t))) {
    const name = m[3];
    // Abbreviations ("sat", "wed") only count with a preposition or this/next in front of them.
    if (!FULL_WEEKDAYS.has(name) && !m[1] && !m[2]) continue;
    push(m.index, m[1], weekdayDate(now, WEEKDAY_INDEX[name], m[2] === 'next'), 'weekday');
  }

  const relative = new RegExp(`\\b(by|before|within|in)\\s+(?:about\\s+|around\\s+)?${NUM}\\s+(day|week|month)s?\\b`, 'g');
  while ((m = relative.exec(t))) {
    const n = numberOf(m[2]);
    if (n != null) push(m.index, m[1], addDays(noon(now), n * UNIT_DAYS[m[3]]), 'relative');
  }

  const keyword = /\b(?:(by|before|until|within)\s+)?(tomorrow|today|tonight|next week|next month|the end of the week|end of the week|this weekend|the weekend)\b/g;
  while ((m = keyword.exec(t))) {
    const k = m[2];
    let d = null;
    if (k === 'tomorrow') d = addDays(noon(now), 1);
    else if (k === 'today' || k === 'tonight') d = noon(now);
    else if (k === 'next week') d = addDays(noon(now), 7);
    else if (k === 'next month') d = addDays(noon(now), 30);
    else if (k.includes('end of the week')) d = weekdayDate(now, 5, false);
    else d = weekdayDate(now, 6, false);
    push(m.index, m[1], d, 'keyword');
  }
  return { t, out };
}

/**
 * Deadline from free text → ISO date (YYYY-MM-DD) or null.
 * "by next Friday", "by Friday", "next week", "in three weeks", "in 10 days", "by Nov 27", "by 11/27".
 * "next <weekday>" = first such weekday strictly after `now` that is at least 2 days away.
 * With `ignoreEventDates`, a date tied to an event ("for a half marathon in three weeks") is not a
 * need-by date unless it is introduced by "by/before/until/within".
 */
export function parseDeadline(text, now = today(), { ignoreEventDates = false } = {}) {
  const base = noon(now instanceof Date ? now : new Date(now));
  const { t, out } = collectCandidates(text, base);
  let candidates = out;
  if (ignoreEventDates) {
    candidates = out.filter((c) => {
      if (NEED_BY.test(c.prep)) return true;
      const clauseStart = Math.max(t.lastIndexOf('.', c.index), t.lastIndexOf(',', c.index), t.lastIndexOf(';', c.index), -1);
      return !EVENT_WORDS.test(t.slice(clauseStart + 1, c.index));
    });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => (NEED_BY.test(b.prep) - NEED_BY.test(a.prep)) || a.index - b.index);
  return isoDate(candidates[0].date);
}

/** Budget from free text → number or null ("under 140", "under $140", "max 150", "$140", "140 dollars"). */
export function parseBudget(text) {
  const t = String(text || '').toLowerCase();
  const notQuantity = '(?!\\s*(?:days?|weeks?|months?|hours?|minutes?|years?|pairs?|items?|units?|oz|ounces?|mm|%|stars?|reviews?))';
  const patterns = [
    new RegExp(`\\b(?:under|below|less than|max(?:imum)?|at most|up to|no more than|not more than|budget(?:\\s+(?:of|is|around|about))?|around|about|cap(?:ped)? at|tops)\\s*(?:of\\s*)?(?:\\$|usd\\s*)?\\s*(\\d+(?:\\.\\d{1,2})?)\\b${notQuantity}`),
    /\$\s*(\d+(?:\.\d{1,2})?)/,
    /\b(\d+(?:\.\d{1,2})?)\s*(?:dollars|bucks|usd)\b/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

/** "2026-11-27" → "Fri 11/27" (constraint chip label). */
export function shortDate(iso) {
  const d = new Date(`${iso}T12:00:00`);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  return `${wd} ${d.getMonth() + 1}/${d.getDate()}`;
}

/** Whole calendar days from `now` to an ISO date. */
export function daysUntil(iso, now = today()) {
  return daysBetween(now instanceof Date ? now : new Date(now), new Date(`${iso}T12:00:00`));
}
