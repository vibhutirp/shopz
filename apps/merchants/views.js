// Server-rendered HTML for the fictional Shopz merchant stores (RunHub, DailyCart).
// No external resources: CSS is inline, every image is an inline SVG generated here.
// Rule for templates: always put whitespace between sibling elements, so the visible text of a
// section (browser innerText, whitespace collapsed) equals htmlToText() of the same HTML.
import { SECTIONS, DEMO_ZIP, TAX_RATE, computeTotals, today, addDays, isoDate, weekdayName } from '../../packages/contracts/index.js';
import { WIDTH_LABELS, CATEGORY_LABELS, SELLERS, returnsFor } from './catalog.js';

export const RIBBON_TEXT = 'Demo store – fictional products, ratings and reviews';

export const DEMO_ADDRESS = Object.freeze({ name: 'Alex Demo', address: '500 Market St', city: 'San Francisco', state: 'CA', zip: DEMO_ZIP });
export const TEST_CARD = Object.freeze({ number: '4242 4242 4242 4242', exp: '12/30', cvc: '123' });

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const THEMES = {
  runhub: { accent: '#2563eb', dark: '#1d4ed8', soft: '#eff6ff', ink: '#1e3a8a', search: 'Search running shoes' },
  dailycart: { accent: '#16a34a', dark: '#15803d', soft: '#f0fdf4', ink: '#14532d', search: 'Search shoes, coffee and more' },
};

// ------------------------------------------------------------------ helpers

export function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function money(n) {
  return '$' + Number(n).toFixed(2);
}

export function thousands(n) {
  return String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** ETA facts for "today + days" (calendar days). */
export function etaFor(days) {
  const d = addDays(today(), Number(days) || 0);
  const weekday = weekdayName(d);
  const monthDay = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return {
    iso: isoDate(d),
    weekday,
    monthDay,
    long: `Arrives ${weekday}, ${monthDay}`,
    short: `Arrives ${weekday.slice(0, 3)}, ${monthDay}`,
  };
}

function fmtDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  return u.toString();
}

function hidden(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('\n');
}

function stars(value, cls = '') {
  const pct = Math.max(0, Math.min(100, (Number(value) / 5) * 100));
  return `<span class="stars ${cls}" style="--pct:${pct.toFixed(1)}%" role="img" aria-label="${esc(Number(value).toFixed(1))} out of 5 stars"><i></i></span>`;
}

/** The most helpful critical review: the flagged one, else the most helpful review with ≤ 3 stars. */
export function criticalReview(p) {
  const flagged = p.reviews.find((r) => r.critical);
  if (flagged) return flagged;
  return [...p.reviews].filter((r) => r.stars <= 3).sort((a, b) => b.helpful - a.helpful)[0] || null;
}

// ------------------------------------------------------------------ text extraction (sections API)

const BLOCK_TAGS = 'address|article|aside|blockquote|br|button|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|input|label|legend|li|main|nav|ol|option|p|pre|section|select|summary|table|tbody|td|textarea|tfoot|th|thead|tr|ul';
const BLOCK_RE = new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi');

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    if (k === 'nbsp') return ' ';
    const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}

/** Visible text of an HTML fragment, whitespace collapsed to single spaces (mirrors innerText for our templates). */
export function htmlToText(html) {
  const stripped = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(svg|style|script|template|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(BLOCK_RE, ' ')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(stripped).replace(/\s+/g, ' ').trim();
}

function typedValue(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/** data-* attributes of the first tag as typed values, keys snake_case (data-in-stock → in_stock). data-section is skipped. */
export function dataFields(html) {
  const open = String(html).match(/<[a-z][^>]*>/i);
  const fields = {};
  if (!open) return fields;
  const re = /\sdata-([a-z0-9-]+)="([^"]*)"/gi;
  let m;
  while ((m = re.exec(open[0]))) {
    const key = m[1].toLowerCase().replace(/-/g, '_');
    if (key === 'section') continue;
    fields[key] = typedValue(decodeEntities(m[2]));
  }
  return fields;
}

// ------------------------------------------------------------------ inline SVG art (stylized, no real brand marks)

const f1 = (n) => Math.round(n * 10) / 10;

function emblem(kind, cx, cy, color) {
  switch (kind) {
    case 'triangle':
      return `<polygon points="${cx - 12},${cy - 12} ${cx + 15},${cy} ${cx - 12},${cy + 12}" fill="${color}"/>`;
    case 'hexagon': {
      const pts = [0, 1, 2, 3, 4, 5].map((i) => `${f1(cx + 13 * Math.cos((Math.PI / 3) * i))},${f1(cy + 13 * Math.sin((Math.PI / 3) * i))}`).join(' ');
      return `<polygon points="${pts}" fill="${color}"/>`;
    }
    case 'wing':
      return `<path d="M ${cx - 18},${cy + 8} Q ${cx - 2},${cy - 20} ${cx + 20},${cy - 12} Q ${cx + 2},${cy - 6} ${cx - 2},${cy + 10} Z" fill="${color}"/>`;
    default:
      return `<polygon points="${cx},${cy - 13} ${cx + 13},${cy} ${cx},${cy + 13} ${cx - 13},${cy}" fill="${color}"/>`;
  }
}

function shoeSide(a, cushion, medial) {
  const t = cushion === 'max' ? 36 : cushion === 'low' ? 16 : 25;
  const Y = Math.round(178 - t / 2);
  const y = (dy) => f1(Y + dy);
  const B = Y + t;
  const lacePts = [0, 0.12, 0.24, 0.36, 0.48].map((u) => {
    const x = 214 + u * 156;
    const yy = Y - 90 + u * 68;
    return [f1(x), f1(yy)];
  });
  const laces = lacePts
    .map(([x, yy]) => `<line x1="${f1(x - 4)}" y1="${f1(yy + 1)}" x2="${f1(x + 5)}" y2="${f1(yy + 14)}" stroke="${a.lace}" stroke-width="4" stroke-linecap="round"/>` +
      `<circle cx="${f1(x - 6)}" cy="${f1(yy + 14)}" r="2.2" fill="${a.dark}"/>`)
    .join('');
  const midLine = cushion === 'low' ? '' : `<path d="M 66 ${f1(B - t * 0.45)} L 352 ${f1(B - t * 0.45)}" stroke="${a.accent}" stroke-width="3" stroke-linecap="round" opacity=".75"/>` +
    (cushion === 'max' ? `<path d="M 80 ${f1(B - t * 0.75)} L 330 ${f1(B - t * 0.75)}" stroke="#0f172a" stroke-width="2" stroke-linecap="round" opacity=".08"/>` : '');
  const body = [
    `<ellipse cx="208" cy="${B + 13}" rx="168" ry="7" fill="#0f172a" opacity=".09"/>`,
    `<path d="M 46 ${y(0)} C 38 ${y(-30)} 40 ${y(-60)} 56 ${y(-74)} C 66 ${y(-82)} 84 ${y(-74)} 100 ${y(-64)} C 116 ${y(-56)} 136 ${y(-60)} 150 ${y(-74)} L 188 ${y(-104)} C 196 ${y(-110)} 208 ${y(-108)} 210 ${y(-98)} L 214 ${y(-90)} C 260 ${y(-70)} 320 ${y(-44)} 356 ${y(-28)} C 378 ${y(-18)} 386 ${y(-6)} 380 ${y(0)} Z" fill="${a.primary}"/>`,
    `<path d="M 70 ${y(-52)} C 120 ${y(-38)} 190 ${y(-56)} 244 ${y(-66)}" stroke="#ffffff" stroke-width="7" stroke-linecap="round" opacity=".1" fill="none"/>`,
    `<path d="M 46 ${y(0)} C 38 ${y(-30)} 40 ${y(-60)} 56 ${y(-74)} C 62 ${y(-79)} 70 ${y(-79)} 78 ${y(-74)} C 72 ${y(-50)} 74 ${y(-22)} 92 ${y(0)} Z" fill="${a.dark}"/>`,
    `<path d="M 318 ${y(0)} C 322 ${y(-14)} 330 ${y(-28)} 340 ${y(-33)} C 356 ${y(-27)} 372 ${y(-18)} 380 ${y(-6)} L 380 ${y(0)} Z" fill="${a.dark}" opacity=".55"/>`,
    `<path d="M 57 ${y(-73)} C 67 ${y(-81)} 85 ${y(-73)} 100 ${y(-63)} C 116 ${y(-55)} 136 ${y(-59)} 150 ${y(-73)}" stroke="#0f172a" stroke-width="5" stroke-linecap="round" opacity=".45" fill="none"/>`,
    `<path d="M 204 ${y(-96)} C 250 ${y(-76)} 300 ${y(-54)} 296 ${y(-56)}" stroke="${a.dark}" stroke-width="12" stroke-linecap="round" opacity=".85" fill="none"/>`,
    laces,
    medial
      ? `<path d="M 120 ${y(0)} C 140 ${y(-22)} 190 ${y(-26)} 230 ${y(0)} Z" fill="${a.dark}" opacity=".35"/>`
      : emblem(a.emblem, 152, Y - 34, a.accent),
    `<path d="M 38 ${y(-2)} L 382 ${y(-2)} C 394 ${y(3)} 390 ${y(t * 0.62)} 362 ${B} L 64 ${B} C 44 ${B} 34 ${y(t * 0.5)} 38 ${y(-2)} Z" fill="${a.sole}" stroke="#0f172a" stroke-opacity=".08"/>`,
    midLine,
    `<path d="M 64 ${B} L 362 ${B} C 356 ${B + 6} 348 ${B + 7} 338 ${B + 7} L 72 ${B + 7} C 64 ${B + 7} 60 ${B + 4} 64 ${B} Z" fill="${a.outsole}"/>`,
  ].join('');
  return medial ? `<g transform="translate(416 0) scale(-1 1)">${body}</g>` : body;
}

const FOOT_OUTER = 'M 52 130 C 52 96 82 82 122 86 C 172 90 212 78 272 76 C 332 74 374 98 376 130 C 374 162 332 186 272 184 C 212 182 172 170 122 174 C 82 178 52 164 52 130 Z';
const FOOT_INNER = 'M 62 130 C 62 104 86 93 122 96 C 172 100 212 88 270 86 C 324 84 364 104 366 130 C 364 156 324 176 270 174 C 212 172 172 160 122 164 C 86 167 62 156 62 130 Z';

function shoeTop(a) {
  const laces = [0, 1, 2, 3, 4].map((i) => {
    const x = 150 + i * 17;
    return `<line x1="${x}" y1="117" x2="${x + 7}" y2="143" stroke="${a.lace}" stroke-width="4" stroke-linecap="round"/><circle cx="${x - 1}" cy="113" r="2.2" fill="${a.dark}"/><circle cx="${x + 8}" cy="147" r="2.2" fill="${a.dark}"/>`;
  }).join('');
  return [
    `<ellipse cx="214" cy="196" rx="156" ry="8" fill="#0f172a" opacity=".07"/>`,
    `<path d="${FOOT_OUTER}" fill="${a.sole}" stroke="#0f172a" stroke-opacity=".1"/>`,
    `<path d="${FOOT_INNER}" fill="${a.primary}"/>`,
    `<path d="M 300 90 C 340 92 366 108 366 130 C 366 152 340 168 300 170 C 316 150 316 110 300 90 Z" fill="${a.dark}" opacity=".45"/>`,
    `<ellipse cx="106" cy="130" rx="31" ry="20" fill="${a.dark}"/>`,
    `<ellipse cx="109" cy="130" rx="24" ry="14" fill="#e5e7eb"/>`,
    `<rect x="138" y="112" width="92" height="36" rx="14" fill="${a.dark}" opacity=".5"/>`,
    laces,
    `<rect x="55" y="121" width="10" height="18" rx="3" fill="${a.accent}"/>`,
    `<path d="M 250 92 C 280 88 300 88 318 92" stroke="${a.accent}" stroke-width="4" stroke-linecap="round" fill="none" opacity=".9"/>`,
  ].join('');
}

function shoeSole(a) {
  const inside = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 < 1;
  let lugs = '';
  for (let x = 66; x <= 364; x += 15) {
    for (let y = 96; y <= 166; y += 13) {
      if (inside(x, y, 112, 130, 50, 34) || inside(x, y, 300, 130, 64, 44)) {
        lugs += `<rect x="${x - 4.5}" y="${y - 3}" width="9" height="6" rx="2" fill="${a.sole}" opacity=".5"/>`;
      }
    }
  }
  return [
    `<ellipse cx="214" cy="198" rx="156" ry="7" fill="#0f172a" opacity=".07"/>`,
    `<path d="${FOOT_OUTER}" fill="${a.sole}" stroke="#0f172a" stroke-opacity=".12"/>`,
    `<ellipse cx="112" cy="130" rx="54" ry="38" fill="${a.outsole}"/>`,
    `<ellipse cx="300" cy="130" rx="68" ry="48" fill="${a.outsole}"/>`,
    lugs,
    `<path d="M 168 130 L 236 130" stroke="${a.accent}" stroke-width="5" stroke-linecap="round"/>`,
    emblem(a.emblem, 202, 112, a.accent),
  ].join('');
}

function bean(cx, cy, rot, color, s = 1) {
  return `<g transform="translate(${cx} ${cy}) rotate(${rot}) scale(${s})"><ellipse rx="11" ry="15" fill="${color}"/><path d="M 0 -13 C -6 -4 6 4 0 13" stroke="#000" stroke-opacity=".35" stroke-width="2.2" fill="none"/></g>`;
}

function bagBody(a) {
  return [
    `<ellipse cx="200" cy="230" rx="86" ry="6" fill="#000" opacity=".1"/>`,
    `<path d="M 142 62 L 258 62 L 266 214 C 266 222 260 228 252 228 L 148 228 C 140 228 134 222 134 214 Z" fill="${a.bag}"/>`,
    `<path d="M 142 62 L 156 62 L 150 228 L 148 228 C 140 228 134 222 134 214 Z" fill="#000" opacity=".12"/>`,
    `<path d="M 244 62 L 258 62 L 266 214 C 266 222 260 228 252 228 L 250 228 Z" fill="#000" opacity=".18"/>`,
    `<rect x="138" y="50" width="124" height="16" rx="3" fill="${a.bag}"/>`,
    `<rect x="138" y="50" width="124" height="16" rx="3" fill="#000" opacity=".18"/>`,
    `<circle cx="200" cy="86" r="6" fill="#000" opacity=".22"/>`,
    `<circle cx="200" cy="86" r="2.5" fill="#fff" opacity=".35"/>`,
  ].join('');
}

function coffeeFront(a) {
  const dots = [0, 1, 2, 3, 4].map((i) => `<circle cx="${184 + i * 8}" cy="191" r="2.6" fill="${i < a.roastLevel ? a.accent : '#ffffff'}" opacity="${i < a.roastLevel ? 1 : 0.3}"/>`).join('');
  return [
    bagBody(a),
    `<rect x="156" y="106" width="88" height="96" rx="10" fill="${a.label}"/>`,
    `<ellipse cx="200" cy="130" rx="10" ry="14" fill="${a.accent}"/>`,
    `<path d="M 200 117 C 194 126 206 134 200 143" stroke="${a.label}" stroke-width="2.5" fill="none"/>`,
    `<rect x="172" y="153" width="56" height="7" rx="3.5" fill="#fff" opacity=".9"/>`,
    `<rect x="178" y="166" width="44" height="5" rx="2.5" fill="#fff" opacity=".6"/>`,
    `<rect x="184" y="177" width="32" height="5" rx="2.5" fill="${a.accent}" opacity=".9"/>`,
    dots,
    bean(300, 214, 30, a.bean),
    bean(324, 222, -25, a.bean, 0.9),
    bean(98, 220, 65, a.bean, 0.95),
  ].join('');
}

function coffeeBack(a) {
  const lines = [64, 52, 70, 46, 60, 38].map((w, i) => `<rect x="166" y="${108 + i * 11}" width="${w}" height="5" rx="2.5" fill="#94a3b8"/>`).join('');
  const bars = [3, 1, 2, 1, 3, 2, 1, 1, 3, 1, 2, 3, 1, 2].reduce((acc, w) => {
    acc.svg += `<rect x="${acc.x}" y="182" width="${w}" height="18" fill="#334155"/>`;
    acc.x += w + 2;
    return acc;
  }, { x: 172, svg: '' }).svg;
  return [
    bagBody(a),
    `<rect x="156" y="98" width="88" height="110" rx="8" fill="#fff" opacity=".92"/>`,
    lines,
    `<rect x="166" y="174" width="68" height="1.5" fill="#cbd5e1"/>`,
    bars,
  ].join('');
}

function coffeeBeans(a) {
  const pts = [[150, 110, 20], [182, 92, -30], [214, 116, 60], [246, 96, 10], [270, 128, -50], [168, 146, 80], [204, 154, -15], [238, 150, 35], [136, 134, -60], [196, 124, 15], [228, 128, -80], [262, 162, 50], [150, 172, 5], [186, 182, -40], [220, 182, 70]];
  return [
    `<ellipse cx="204" cy="140" rx="128" ry="82" fill="#ffffff" opacity=".7"/>`,
    pts.map(([x, y, r], i) => bean(x, y, r, a.bean, 1 + (i % 3) * 0.08)).join(''),
  ].join('');
}

function coffeeCup(a) {
  return [
    `<ellipse cx="200" cy="200" rx="104" ry="20" fill="#ffffff" stroke="#e2e8f0" stroke-width="2"/>`,
    `<ellipse cx="200" cy="198" rx="70" ry="11" fill="#f1f5f9"/>`,
    `<path d="M 262 126 C 296 122 298 168 256 168" stroke="${a.label}" stroke-width="11" stroke-linecap="round" fill="none"/>`,
    `<path d="M 134 110 L 266 110 C 264 162 246 194 200 196 C 154 194 136 162 134 110 Z" fill="${a.label}"/>`,
    `<ellipse cx="200" cy="110" rx="66" ry="12" fill="#0f172a" opacity=".25"/>`,
    `<ellipse cx="200" cy="111" rx="58" ry="9" fill="${a.bean}"/>`,
    `<path d="M 176 90 C 166 76 188 68 178 52" stroke="#94a3b8" stroke-width="4" stroke-linecap="round" fill="none" opacity=".6"/>`,
    `<path d="M 202 92 C 192 76 214 68 204 48" stroke="#94a3b8" stroke-width="4" stroke-linecap="round" fill="none" opacity=".5"/>`,
    `<path d="M 228 90 C 218 76 240 68 230 54" stroke="#94a3b8" stroke-width="4" stroke-linecap="round" fill="none" opacity=".4"/>`,
  ].join('');
}

const VIEWS = {
  shoe: [['side', 'Side view'], ['medial', 'Inner side'], ['top', 'Top view'], ['sole', 'Outsole']],
  coffee: [['front', 'Front of bag'], ['back', 'Back of bag'], ['beans', 'Whole beans'], ['cup', 'Brewed']],
};

export function productArt(p, view) {
  const a = p.art;
  let inner;
  if (a.kind === 'coffee') {
    inner = view === 'back' ? coffeeBack(a) : view === 'beans' ? coffeeBeans(a) : view === 'cup' ? coffeeCup(a) : coffeeFront(a);
  } else {
    const cushion = p.specs.cushion;
    inner = view === 'medial' ? shoeSide(a, cushion, true) : view === 'top' ? shoeTop(a) : view === 'sole' ? shoeSole(a) : shoeSide(a, cushion, false);
  }
  const label = (VIEWS[a.kind] || VIEWS.shoe).find(([k]) => k === view)?.[1] || 'Product';
  return `<svg viewBox="0 0 416 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(`${label}: ${p.title} (illustration)`)}">${inner}</svg>`;
}

function logoSvg(storeId) {
  const t = THEMES[storeId] || THEMES.runhub;
  const mark = storeId === 'dailycart'
    ? '<path d="M8 12.5h16l-2.2 9.5H10.2z" fill="#fff"/><path d="M12 12.5c0-4.5 8-4.5 8 0" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round"/>'
    : '<path d="M8 20.5l5.5-8 4 5.5 6.5-8.5" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>';
  return `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="32" height="32" rx="9" fill="${t.accent}"/>${mark}</svg>`;
}

const ICONS = {
  truck: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h11v9H3zM14 9h4l3 3v3h-7z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="7" cy="17" r="2" fill="currentColor"/><circle cx="17" cy="17" r="2" fill="currentColor"/></svg>',
  cart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h2l2.4 10.5h10.2L20 7H6.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="9" cy="19" r="1.6" fill="currentColor"/><circle cx="17" cy="19" r="1.6" fill="currentColor"/></svg>',
  check: '<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="22" fill="currentColor"/><path d="M14 24.5l7 7 13-14" stroke="#fff" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7l-5 5 5 5M4 12h11a5 5 0 010 10h-2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// ------------------------------------------------------------------ layout

function css(storeId) {
  const t = THEMES[storeId] || THEMES.runhub;
  return `
:root{--accent:${t.accent};--accent-dark:${t.dark};--accent-soft:${t.soft};--accent-ink:${t.ink};--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--bg:#f5f6f8;--ok:#15803d;--bad:#b91c1c}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif;-webkit-font-smoothing:antialiased;min-height:100vh;display:flex;flex-direction:column}
main.wrap{flex:1;width:100%}
a{color:inherit}
h1,h2,h3{margin:0;line-height:1.25}
h2{font-size:18px;margin-bottom:10px;letter-spacing:-.2px}
h3{font-size:15px;margin-bottom:6px}
svg{display:block}
.ribbon{background:#111827;color:#fde68a;text-align:center;font-size:13px;font-weight:600;letter-spacing:.2px;padding:7px 12px}
header.site{background:#fff;border-bottom:1px solid var(--line)}
.wrap{max-width:1120px;margin:0 auto;padding:0 24px}
.head{display:flex;align-items:center;gap:22px;height:66px}
.logo{display:flex;align-items:center;gap:10px;text-decoration:none;font-weight:800;font-size:21px;letter-spacing:-.4px}
.logo svg{width:34px;height:34px}
.logo b{color:var(--accent)}
.search{flex:1;display:flex;max-width:500px}
.search input{flex:1;height:40px;border:1px solid #cbd5e1;border-right:0;border-radius:10px 0 0 10px;padding:0 14px;font:inherit;background:#f8fafc;min-width:0}
.search input:focus{outline:none;border-color:var(--accent);background:#fff}
.search button{height:40px;border:0;border-radius:0 10px 10px 0;padding:0 18px;background:var(--accent);color:#fff;font:600 14px system-ui,sans-serif;cursor:pointer}
.nav{display:flex;align-items:center;gap:18px;margin-left:auto;font-size:14px;font-weight:500}
.nav a{text-decoration:none;color:#334155;white-space:nowrap}
.nav a:hover{color:var(--accent)}
.nav .cart-link{display:flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:10px;padding:7px 12px}
.nav .cart-link svg{width:18px;height:18px}
.crumbs{font-size:13px;color:var(--muted);margin:16px 0 12px}
.crumbs a{text-decoration:none;color:var(--muted)}
.crumbs a:hover{color:var(--accent)}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:20px 22px}
section[data-section]{scroll-margin-top:18px;transition:box-shadow .2s}
.muted{color:var(--muted)}
.small{font-size:13px}
.stars{position:relative;display:inline-block;font-size:16px;line-height:1;letter-spacing:1px;color:#d6dae1;vertical-align:-2px;white-space:nowrap}
.stars::before{content:"★★★★★"}
.stars i{position:absolute;left:0;top:0;bottom:0;width:var(--pct);overflow:hidden;color:#f59e0b;font-style:normal}
.stars i::before{content:"★★★★★"}
.stars.sm{font-size:13px}
.stars.lg{font-size:20px}
.pdp-top{display:grid;grid-template-columns:minmax(0,1.08fr) minmax(0,1fr);gap:18px;align-items:start}
.buycol{display:grid;gap:16px}
.gallery{padding:14px}
.shot{margin:0;background:linear-gradient(160deg,#f8fafc,#e8edf4);border-radius:11px;overflow:hidden}
.shot svg{width:100%;height:auto}
.shot figcaption{font-size:12px;color:var(--muted);text-align:center;padding:0 0 8px}
.thumbs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:10px}
.thumbs .shot{border:1px solid var(--line)}
.gallery .note{margin:10px 2px 0;font-size:12px;color:var(--muted)}
.brand-line{font-size:13px;font-weight:700;color:var(--accent)}
.title{font-size:25px;font-weight:750;letter-spacing:-.5px;margin:2px 0 6px}
.rating-line{display:flex;align-items:center;gap:8px;font-size:14px}
.rating-line a{text-decoration:none}
.rating-line a:hover{color:var(--accent)}
.price-row{display:flex;align-items:center;gap:10px;margin:12px 0 2px;flex-wrap:wrap}
.price{font-size:32px;font-weight:800;letter-spacing:-.8px}
.tag-sim{font-size:12px;font-weight:700;color:#92400e;background:#fef3c7;border:1px solid #fde68a;border-radius:999px;padding:2px 10px}
.stock{font-weight:650;font-size:14px;display:flex;align-items:center;gap:8px}
.stock.in{color:var(--ok)}
.stock.out{color:var(--bad)}
.soldby{font-size:14px;color:#334155;margin-top:2px}
.opt-label{font-size:13px;font-weight:650;margin:14px 0 6px;color:#334155}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{position:relative;cursor:pointer}
.chip input{position:absolute;opacity:0;pointer-events:none}
.chip span{display:block;min-width:50px;padding:6px 10px;text-align:center;border:1px solid #cbd5e1;border-radius:9px;font-size:14px;font-weight:500;background:#fff}
.chip:hover span{border-color:var(--accent)}
.chip input:checked+span{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent);background:var(--accent-soft);color:var(--accent-ink);font-weight:700}
.buy-row{display:flex;gap:12px;align-items:center;margin-top:16px}
.qty{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:650}
.qty input{width:64px;height:46px;border:1px solid #cbd5e1;border-radius:10px;padding:0 10px;font:inherit}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:46px;padding:0 22px;border-radius:11px;border:0;font:650 15px/1 system-ui,sans-serif;cursor:pointer;text-decoration:none}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover{background:var(--accent-dark)}
.btn-primary[disabled]{background:#cbd5e1;color:#64748b;cursor:not-allowed}
.btn-ghost{background:#fff;color:var(--ink);border:1px solid #cbd5e1}
.btn-wide{flex:1}
.btn-block{width:100%}
.delivery{display:flex;gap:14px;align-items:flex-start}
.delivery .ico{width:42px;height:42px;border-radius:12px;background:var(--accent-soft);color:var(--accent);display:flex;align-items:center;justify-content:center;flex:none}
.delivery .ico svg{width:24px;height:24px}
.delivery h2{font-size:14px;color:var(--muted);font-weight:650;margin-bottom:2px}
.delivery .eta{font-size:18px;font-weight:750;margin:0;color:var(--ok)}
.delivery p{margin:0}
.stack{display:grid;gap:16px;margin-top:16px}
.specs-grid{display:grid;grid-template-columns:minmax(0,.85fr) minmax(0,1.15fr);gap:28px}
.about p{margin:0 0 10px;color:#334155}
.spec-table{width:100%;border-collapse:collapse;font-size:14px}
.spec-table th{text-align:left;font-weight:600;color:#475569;width:40%;padding:8px 12px;background:#f8fafc;border-bottom:1px solid var(--line)}
.spec-table td{padding:8px 12px;border-bottom:1px solid var(--line)}
.spec-table tr:first-child th,.spec-table tr:first-child td{border-top:1px solid var(--line)}
.rev-grid{display:grid;grid-template-columns:250px minmax(0,1fr);gap:30px}
.avg-row{display:flex;align-items:center;gap:12px}
.avg-big{font-size:46px;font-weight:800;letter-spacing:-1.5px;line-height:1}
.bars{display:grid;gap:7px;margin-top:16px}
.bar-row{display:grid;grid-template-columns:46px minmax(0,1fr) 38px;gap:8px;align-items:center;font-size:13px}
.bar{height:9px;border-radius:99px;background:#e9edf2;overflow:hidden}
.bar i{display:block;height:100%;background:#f59e0b;border-radius:99px}
.rev-note{font-size:12px;color:var(--muted);margin-top:14px}
.rev-head{font-size:13px;color:var(--muted);margin-bottom:6px}
.review{border-top:1px solid var(--line);padding:13px 2px}
.review[data-critical="true"]{background:#fffbeb;border:1px solid #fde68a;border-radius:12px;padding:13px 15px;margin:4px 0}
.review[data-critical="true"]+.review{border-top:0}
.rv-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rv-score{font-size:12px;color:var(--muted)}
.rv-title{font-weight:700}
.badge{font-size:11.5px;font-weight:700;color:#92400e;background:#fef3c7;border:1px solid #fde68a;border-radius:999px;padding:1px 9px}
.rv-meta{font-size:12.5px;color:var(--muted);margin:3px 0 5px}
.rv-text{margin:0 0 5px}
.rv-helpful{font-size:12.5px;color:var(--muted)}
.duo{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.policy{font-size:15px;font-weight:650;margin:0 0 8px}
.facts{margin:0;padding-left:18px;color:#334155;font-size:14px}
.facts li{margin:2px 0}
.hero{display:grid;grid-template-columns:1.05fr 1fr;align-items:center;gap:24px;background:linear-gradient(120deg,var(--accent-soft),#fff 70%);border:1px solid var(--line);border-radius:18px;padding:26px 34px;margin-top:20px}
.hero h1{font-size:40px;letter-spacing:-1.2px;margin-bottom:10px}
.hero p{font-size:17px;color:#334155;margin:0 0 18px}
.hero .art{background:#fff;border-radius:16px;border:1px solid var(--line)}
.hero .ctas{display:flex;gap:10px}
.props{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:16px 0 0}
.prop{background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px 16px;font-size:14px;display:flex;gap:10px;align-items:center}
.prop svg{width:22px;height:22px;color:var(--accent);flex:none}
.row-title{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:26px 0 12px}
.row-title h1,.row-title h2{font-size:22px;letter-spacing:-.4px;margin:0}
.pills{display:flex;gap:8px;margin:-4px 0 14px}
.pill{font-size:13px;font-weight:600;text-decoration:none;border:1px solid #cbd5e1;border-radius:999px;padding:5px 12px;background:#fff;color:#334155}
.pill.on{background:var(--accent);border-color:var(--accent);color:#fff}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}
.pcard{display:flex;flex-direction:column;background:#fff;border:1px solid var(--line);border-radius:14px;overflow:hidden;text-decoration:none;color:inherit;transition:box-shadow .15s,transform .15s}
.pcard:hover{box-shadow:0 10px 26px rgba(15,23,42,.09);transform:translateY(-2px)}
.pimg{display:block;background:linear-gradient(160deg,#f8fafc,#e8edf4)}
.pimg svg{width:100%;height:auto}
.pbody{padding:12px 14px 16px;display:grid;gap:3px}
.pbrand{font-size:12px;font-weight:700;color:var(--accent)}
.ptitle{font-weight:650;font-size:15px;line-height:1.3;text-decoration:none}
.prating{font-size:13px;color:#475569;display:flex;align-items:center;gap:6px}
.pprice{font-size:20px;font-weight:800;letter-spacing:-.4px;margin-top:4px}
.peta{font-size:13px;color:var(--ok);font-weight:600}
.peta.out{color:var(--bad)}
.pmeta{font-size:12.5px;color:var(--muted)}
.empty{padding:40px;text-align:center}
.page-title{font-size:26px;letter-spacing:-.5px;margin:22px 0 14px}
.co-grid{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(0,1fr);gap:20px;align-items:start}
.line{display:grid;grid-template-columns:160px minmax(0,1fr) auto;gap:18px;align-items:center}
.line .pimg{border-radius:10px;overflow:hidden}
.line-price{font-size:18px;font-weight:800}
.sum-row{display:flex;justify-content:space-between;gap:12px;padding:5px 0;font-size:14px}
.sum-row.total{border-top:1px solid var(--line);margin-top:8px;padding-top:12px;font-weight:800;font-size:17px}
.summary .btn{margin-top:14px}
.summary .mini{display:flex;gap:12px;align-items:center;padding-bottom:12px;margin-bottom:8px;border-bottom:1px solid var(--line)}
.summary .mini .pimg{width:84px;border-radius:8px;overflow:hidden;flex:none}
.steps{display:flex;gap:8px;margin:20px 0 14px;font-size:13px;font-weight:650}
.step{padding:6px 13px;border-radius:999px;background:#e2e8f0;color:#475569}
.step.on{background:var(--accent);color:#fff}
.step.done{background:var(--accent-soft);color:var(--accent-ink)}
.form{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin-bottom:16px}
.field{display:grid;gap:5px;font-size:13px;font-weight:650;color:#334155}
.field input{height:42px;border:1px solid #cbd5e1;border-radius:9px;padding:0 12px;font:15px system-ui,sans-serif;background:#fff;color:var(--ink);width:100%}
.field input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.c6{grid-column:span 6}.c4{grid-column:span 4}.c3{grid-column:span 3}.c2{grid-column:span 2}.c1{grid-column:span 1}
.opt-card{display:flex;gap:12px;align-items:center;border:1px solid var(--accent);background:var(--accent-soft);border-radius:11px;padding:12px 14px;margin:0 0 16px;font-size:14px}
.opt-card input{accent-color:var(--accent)}
.notice{display:flex;gap:10px;align-items:center;background:#fffbeb;border:1px solid #fde68a;color:#78350f;border-radius:10px;padding:10px 12px;font-size:13px;margin:0 0 14px}
.notice svg{width:20px;height:20px;flex:none}
.shipto{font-size:14px;color:#334155;margin:0 0 14px}
.confirm{text-align:center;padding:34px 30px;max-width:760px;margin:26px auto 0}
.confirm .ok{width:56px;height:56px;margin:0 auto;color:var(--ok)}
.confirm h1{font-size:30px;letter-spacing:-.6px;margin:14px 0 6px}
.confirm .lead{font-size:16px;color:#334155;margin:0 0 18px}
.confirm .box{text-align:left;border:1px solid var(--line);border-radius:12px;padding:14px 18px;margin:0 auto 16px}
.err{max-width:640px;margin:40px auto 0;text-align:center}
footer.site{margin-top:44px;border-top:1px solid var(--line);background:#fff;color:var(--muted);font-size:13px}
footer.site .wrap{padding:20px 24px;display:flex;justify-content:space-between;gap:20px}
`;
}

export function layout(ctx, { title, body, q = '' }) {
  const t = THEMES[ctx.id] || THEMES.runhub;
  const name = ctx.name;
  const split = ctx.id === 'dailycart' ? ['Daily', 'Cart'] : ['Run', 'Hub'];
  const nav = ctx.id === 'dailycart'
    ? [['/search?category=running_shoes', 'Running shoes'], ['/search?category=coffee', 'Coffee'], ['/search', 'All products']]
    : [['/search?category=running_shoes', 'Running shoes'], ['/search?q=wide', 'Wide fits'], ['/search', 'All products']];
  const perks = ctx.id === 'dailycart' ? 'Free shipping on every order · Test checkout only' : 'Free shipping · 30-day free returns · Test checkout only';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | ${esc(name)}</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(logoSvg(ctx.id))}">
<style>${css(ctx.id)}</style>
</head>
<body class="store-${esc(ctx.id)}">
<div class="ribbon" role="note">${esc(RIBBON_TEXT)}</div>
<header class="site">
<div class="wrap head">
<a class="logo" href="/" aria-label="${esc(name)} home">${logoSvg(ctx.id)} <span>${split[0]}<b>${split[1]}</b></span></a>
<form class="search" action="/search" method="get" role="search">
<input type="search" name="q" value="${esc(q)}" placeholder="${esc(t.search)}" aria-label="Search ${esc(name)}">
<button type="submit">Search</button>
</form>
<nav class="nav">
${nav.map(([href, label]) => `<a href="${href}">${esc(label)}</a>`).join('\n')}
<a class="cart-link" href="/cart">${ICONS.cart} <span>Cart</span></a>
</nav>
</div>
</header>
<main class="wrap">
${body}
</main>
<footer class="site">
<div class="wrap">
<span>© 2026 ${esc(name)} · A fictional demo store for Shopz. Products, ratings, reviews and sellers are made up.</span>
<span>${esc(perks)}</span>
</div>
</footer>
</body>
</html>`;
}

// ------------------------------------------------------------------ product cards

function cardFor(ctx, p) {
  const eta = etaFor(p.delivery_days);
  const fit = esc(p.category === 'running_shoes' ? `Widths: ${p.widths.join(', ')} · US 8–13` : p.pack || '');
  return `<a class="pcard" href="/p/${esc(p.sku)}" data-sku="${esc(p.sku)}">
<span class="pimg">${productArt(p, p.art.kind === 'coffee' ? 'front' : 'side')}</span>
<span class="pbody">
<span class="pbrand">${esc(p.brand)}</span>
<span class="ptitle">${esc(p.title)}</span>
<span class="prating">${stars(p.rating.stars, 'sm')} <span>${p.rating.stars.toFixed(1)} (${thousands(p.rating.count)})</span></span>
<span class="pprice">${money(p.price)}</span>
${p.in_stock ? `<span class="peta">${esc(eta.short)}</span>` : '<span class="peta out">Out of stock</span>'}
<span class="pmeta">Free shipping · ${fit}</span>
</span>
</a>`;
}

// ------------------------------------------------------------------ pages

export function renderHome(ctx, products) {
  const seller = SELLERS[ctx.id];
  const hero = products.find((p) => (ctx.id === 'dailycart' ? p.category === 'coffee' : true)) || products[0];
  const sub = ctx.id === 'dailycart'
    ? 'Running gear and fresh coffee, with free shipping on every order.'
    : 'Wide fits, honest reviews, free shipping and 30-day free returns.';
  const ctas = ctx.id === 'dailycart'
    ? '<a class="btn btn-primary" href="/search?category=coffee">Shop coffee</a> <a class="btn btn-ghost" href="/search?category=running_shoes">Shop running shoes</a>'
    : '<a class="btn btn-primary" href="/search?category=running_shoes">Shop running shoes</a> <a class="btn btn-ghost" href="/search?q=wide">Wide fits</a>';
  const props = ctx.id === 'dailycart'
    ? [[ICONS.truck, 'Free shipping on every order'], [ICONS.back, 'Easy returns on most items'], [ICONS.shield, 'Test checkout – no real payments']]
    : [[ICONS.truck, 'Free shipping, fast delivery'], [ICONS.back, '30-day free returns'], [ICONS.shield, 'Test checkout – no real payments']];
  const body = `
<div class="hero">
<div>
<h1>${esc(seller.tagline)}</h1>
<p>${esc(sub)}</p>
<div class="ctas">${ctas}</div>
</div>
<a class="art" href="/p/${esc(hero.sku)}" aria-label="${esc(hero.title)}">${productArt(hero, hero.art.kind === 'coffee' ? 'front' : 'side')}</a>
</div>
<div class="props">
${props.map(([icon, text]) => `<div class="prop">${icon} <span>${esc(text)}</span></div>`).join('\n')}
</div>
<div class="row-title"><h2>Popular right now</h2> <a class="muted small" href="/search">View all</a></div>
<div class="grid">
${products.map((p) => cardFor(ctx, p)).join('\n')}
</div>`;
  return layout(ctx, { title: seller.tagline.replace(/\.$/, ''), body });
}

export function renderSearch(ctx, { q, category, results, categories }) {
  const heading = q ? `Results for “${q}”` : category ? CATEGORY_LABELS[category] || category : 'All products';
  const pill = (cat, label) => {
    const href = '/search?' + qs({ q, category: cat });
    const on = (category || '') === (cat || '');
    return `<a class="pill${on ? ' on' : ''}" href="${esc(href.replace(/\?$/, ''))}">${esc(label)}</a>`;
  };
  const pills = categories.length > 1
    ? `<div class="pills">\n${pill('', 'All')}\n${categories.map((c) => pill(c, CATEGORY_LABELS[c] || c)).join('\n')}\n</div>`
    : '';
  const body = `
<div class="row-title"><h1>${esc(heading)}</h1> <span class="muted small">${results.length} result${results.length === 1 ? '' : 's'} at ${esc(ctx.name)}</span></div>
${pills}
${results.length
    ? `<div class="grid">\n${results.map((p) => cardFor(ctx, p)).join('\n')}\n</div>`
    : `<div class="card empty"><h2>No matches</h2> <p class="muted">Try “running shoes”${ctx.id === 'dailycart' ? ' or “coffee”' : ''}.</p> <a class="btn btn-primary" href="/search">Browse all products</a></div>`}`;
  return layout(ctx, { title: heading, body, q });
}

/** The seven product sections in contract order: [{ name, html }]. */
export function productSections(ctx, p, { size } = {}) {
  const isShoe = p.category === 'running_shoes';
  const eta = etaFor(p.delivery_days);
  const ret = returnsFor(ctx.id, p.category);
  const seller = SELLERS[ctx.id];
  const crit = criticalReview(p);
  const views = VIEWS[p.art.kind] || VIEWS.shoe;
  const sel = isShoe && p.sizes.includes(String(size)) ? String(size) : '10.5';
  const priceChanged = Math.abs(p.price - p.base.price) > 0.0001;
  const stockChanged = p.in_stock !== p.base.in_stock;

  const sec = (name, attrs, inner, cls = '') => {
    const data = Object.entries(attrs).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');
    return `<section id="${name}" data-section="${name}"${data} class="card ${cls}">\n${inner}\n</section>`;
  };

  const gallery = sec('gallery', { images: 4 }, `
<figure class="shot main">
${productArt(p, views[0][0])}
<figcaption>${esc(views[0][1])}</figcaption>
</figure>
<div class="thumbs">
${views.slice(1).map(([k, label]) => `<figure class="shot">\n${productArt(p, k)}\n<figcaption>${esc(label)}</figcaption>\n</figure>`).join('\n')}
</div>
<p class="note">Illustrations for the demo – not product photos.</p>`, 'gallery');

  const options = isShoe
    ? `<div class="opt-label">Size (US)</div>
<div class="chips" role="radiogroup" aria-label="Size">
${p.sizes.map((s) => `<label class="chip"><input type="radio" name="size" value="${esc(s)}"${s === sel ? ' checked' : ''}> <span>${esc(s)}</span></label>`).join('\n')}
</div>
<div class="opt-label">Width</div>
<div class="chips" role="radiogroup" aria-label="Width">
${p.widths.map((w, i) => `<label class="chip"><input type="radio" name="width" value="${esc(w)}"${i === 0 ? ' checked' : ''}> <span>${esc(w)} ${esc(WIDTH_LABELS[w] || '')}</span></label>`).join('\n')}
</div>`
    : `<div class="opt-label">Size</div>
<div class="chips" role="radiogroup" aria-label="Size">
<label class="chip"><input type="radio" name="variant" value="12oz" checked> <span>${esc(p.pack || '12 oz bag')}</span></label>
</div>`;

  const price = sec('price', { price: p.price.toFixed(2), currency: 'USD', 'in-stock': String(p.in_stock), sku: p.sku }, `
<div class="brand-line">${esc(p.brand)}</div>
<h1 class="title">${esc(p.title)}</h1>
<div class="rating-line">
${stars(p.rating.stars)}
<span>${p.rating.stars.toFixed(1)} out of 5</span>
<a href="#reviews" class="muted">${thousands(p.rating.count)} ratings</a>
</div>
<div class="price-row">
<span class="price">${money(p.price)}</span>
${priceChanged ? '<span class="tag-sim">Simulated price change</span>' : ''}
</div>
${p.in_stock
    ? '<div class="stock in">In stock</div>'
    : `<div class="stock out">Out of stock ${stockChanged ? '<span class="tag-sim">Simulated</span>' : ''}</div>`}
<div class="soldby">Sold by <strong>${esc(seller.name)}</strong></div>
<form class="buy-form" method="get" action="/cart">
${hidden({ sku: p.sku })}
${options}
<div class="buy-row">
<label class="qty">Qty <input type="number" name="qty" value="1" min="1" max="10" inputmode="numeric"></label>
<button type="submit" class="btn btn-primary btn-wide" data-testid="add-to-cart"${p.in_stock ? '' : ' disabled'}>Add to cart</button>
</div>
</form>`, 'buy');

  const delivery = sec('delivery', { eta: eta.iso, shipping: 0 }, `
<div class="ico">${ICONS.truck}</div>
<div>
<h2>Delivery</h2>
<p class="eta">${esc(eta.long)}</p>
<p>to ZIP ${esc(DEMO_ZIP)} · Free shipping</p>
</div>`, 'delivery');

  const specAttrs = isShoe ? { cushion: p.specs.cushion } : { roast: p.specs.roast };
  const specs = sec('specs', specAttrs, `
<h2>Specifications</h2>
<div class="specs-grid">
<div class="about">
<h3>About this item</h3>
<p>${esc(p.description)}</p>
</div>
<table class="spec-table">
<tbody>
${p.specs.items.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th> <td>${esc(v)}</td></tr>`).join('\n')}
</tbody>
</table>
</div>`);

  const counts = p.distribution.map((pct) => pct);
  const sorted = [...p.reviews].sort((a, b) => b.helpful - a.helpful);
  const reviewHtml = (r) => `<article class="review" data-review-id="${esc(r.id)}" data-stars="${r.stars}" data-helpful="${r.helpful}"${crit && r.id === crit.id ? ' data-critical="true"' : ''}>
<div class="rv-top">
${stars(r.stars, 'sm')}
<span class="rv-score">${r.stars} of 5</span>
<strong class="rv-title">${esc(r.title)}</strong>
${crit && r.id === crit.id ? '<span class="badge">Most helpful critical review</span>' : ''}
</div>
<div class="rv-meta">${esc(r.author)} · ${esc(fmtDate(r.date))}${r.verified ? ' · Verified purchase' : ''}${r.variant ? ` · ${esc(r.variant)}` : ''}</div>
<p class="rv-text">${esc(r.text)}</p>
<div class="rv-helpful">${r.helpful} ${r.helpful === 1 ? 'person' : 'people'} found this helpful</div>
</article>`;
  const reviews = sec('reviews', { avg: p.rating.stars.toFixed(1), count: p.rating.count, 'critical-quote': crit ? crit.text : '' }, `
<h2>Customer reviews</h2>
<div class="rev-grid">
<div class="rev-summary">
<div class="avg-row">
<div class="avg-big">${p.rating.stars.toFixed(1)}</div>
<div>
${stars(p.rating.stars, 'lg')}
<div class="muted small">out of 5 · ${thousands(p.rating.count)} reviews</div>
</div>
</div>
<div class="bars">
${[5, 4, 3, 2, 1].map((s, i) => `<div class="bar-row"><span>${s} star</span> <span class="bar"><i style="width:${counts[i]}%"></i></span> <span>${counts[i]}%</span></div>`).join('\n')}
</div>
<p class="rev-note">Ratings and reviews on this page are fictional demo data.</p>
</div>
<div class="rev-list">
<div class="rev-head">Top reviews · sorted by most helpful · showing ${p.reviews.length} of ${thousands(p.rating.count)}</div>
${sorted.map(reviewHtml).join('\n')}
</div>
</div>`);

  const returns = sec('returns', { 'window-days': ret.window_days, 'policy-text': ret.policy_text }, `
<h2>Returns</h2>
<p class="policy">${esc(ret.policy_text)}</p>
<ul class="facts">
<li>Return window: ${ret.window_days} days from delivery</li>
<li>Refunds go back to the original payment method</li>
</ul>`);

  const sellerSec = sec('seller', { seller: seller.name }, `
<h2>Seller</h2>
<p class="policy">Sold and shipped by ${esc(seller.name)}</p>
<ul class="facts">
<li>${esc(seller.kind)} · on ${esc(ctx.name)} since ${seller.since}</li>
<li>Seller rating ${seller.rating.toFixed(1)} out of 5 (${thousands(seller.rating_count)} ratings)</li>
<li>Ships from ${esc(seller.ships_from)}</li>
<li>${esc(seller.support)}</li>
</ul>`);

  const out = { gallery, price, delivery, specs, reviews, returns, seller: sellerSec };
  return SECTIONS.map((name) => ({ name, html: out[name] }));
}

/** { <name>: { text, fields } } for GET /api/products/:sku/sections – from the same HTML the page renders. */
export function sectionsPayload(ctx, p) {
  const sections = {};
  for (const { name, html } of productSections(ctx, p)) sections[name] = { text: htmlToText(html), fields: dataFields(html) };
  return sections;
}

export function renderProduct(ctx, p, { size } = {}) {
  const s = Object.fromEntries(productSections(ctx, p, { size }).map((x) => [x.name, x.html]));
  const cat = CATEGORY_LABELS[p.category] || p.category;
  const body = `
<nav class="crumbs" aria-label="Breadcrumb"><a href="/">${esc(ctx.name)}</a> › <a href="/search?category=${esc(p.category)}">${esc(cat)}</a> › <span>${esc(p.title)}</span></nav>
<div class="pdp-top">
${s.gallery}
<div class="buycol">
${s.price}
${s.delivery}
</div>
</div>
<div class="stack">
${s.specs}
${s.reviews}
<div class="duo">
${s.returns}
${s.seller}
</div>
</div>`;
  return layout(ctx, { title: p.title, body });
}

function optionLine(p, line) {
  if (p.category !== 'running_shoes') return `${esc(p.pack || '12 oz bag')} · Qty ${line.qty}`;
  return `Size ${esc(line.size)} · Width ${esc(line.width)} ${esc(WIDTH_LABELS[line.width] || '')} · Qty ${line.qty}`;
}

function summaryBox(ctx, p, line, { withItem = false } = {}) {
  const totals = computeTotals(p.price, line.qty, 0);
  const pct = (TAX_RATE * 100).toFixed(3);
  return `${withItem ? `<div class="mini"><span class="pimg">${productArt(p, p.art.kind === 'coffee' ? 'front' : 'side')}</span> <div><div class="ptitle">${esc(p.title)}</div> <div class="muted small">${optionLine(p, line)}</div></div></div>` : ''}
<div class="sum-row"><span>Subtotal (${line.qty} item${line.qty === 1 ? '' : 's'})</span> <span>${money(totals.subtotal)}</span></div>
<div class="sum-row"><span>Shipping</span> <span>Free</span></div>
<div class="sum-row"><span>Estimated tax (${pct.replace(/0+$/, '')}%)</span> <span>${money(totals.tax)}</span></div>
<div class="sum-row total"><span>Total</span> <span>${money(totals.total)}</span></div>`;
}

export function renderCart(ctx, p, line) {
  if (!p) {
    const body = `<h1 class="page-title">Your cart</h1>
<div class="card empty"><h2>Your cart is empty</h2> <p class="muted">Find something you like and add it to your cart.</p> <a class="btn btn-primary" href="/search">Browse products</a></div>`;
    return layout(ctx, { title: 'Cart', body });
  }
  const eta = etaFor(p.delivery_days);
  const body = `<h1 class="page-title">Your cart</h1>
<div class="co-grid">
<div class="card">
<div class="line" data-sku="${esc(p.sku)}" data-qty="${line.qty}">
<a class="pimg" href="/p/${esc(p.sku)}">${productArt(p, p.art.kind === 'coffee' ? 'front' : 'side')}</a>
<div>
<div class="pbrand">${esc(p.brand)}</div>
<a class="ptitle" href="/p/${esc(p.sku)}">${esc(p.title)}</a>
<div class="muted small">${optionLine(p, line)}</div>
${p.in_stock ? `<div class="peta">${esc(eta.long)} · Free shipping</div>` : '<div class="peta out">Out of stock – this item cannot be ordered right now</div>'}
<div class="muted small">Sold by ${esc(ctx.name)} · ${money(p.price)} each</div>
</div>
<div class="line-price">${money(computeTotals(p.price, line.qty).subtotal)}</div>
</div>
</div>
<aside class="card summary">
<h2>Order summary</h2>
${summaryBox(ctx, p, line)}
<form method="get" action="/checkout">
${hidden({ sku: p.sku, qty: line.qty, size: line.size, width: line.width })}
<button type="submit" class="btn btn-primary btn-block" data-testid="checkout"${p.in_stock ? '' : ' disabled'}>Checkout</button>
</form>
<p class="muted small">Test checkout – no real payment is taken.</p>
</aside>
</div>`;
  return layout(ctx, { title: 'Cart', body });
}

function steps(active) {
  const names = ['Shipping', 'Payment', 'Confirmation'];
  return `<div class="steps">${names.map((n, i) => `<span class="step${i === active ? ' on' : i < active ? ' done' : ''}">${i + 1} ${n}</span>`).join(' ')}</div>`;
}

export function renderShipping(ctx, p, line) {
  const eta = etaFor(p.delivery_days);
  const a = DEMO_ADDRESS;
  const body = `${steps(0)}
<div class="co-grid">
<form class="card" method="get" action="/checkout/payment">
<h2>Shipping address</h2>
${hidden({ sku: p.sku, qty: line.qty, size: line.size, width: line.width })}
<div class="form">
<label class="field c6">Full name <input name="name" value="${esc(a.name)}" required autocomplete="off"></label>
<label class="field c6">Street address <input name="address" value="${esc(a.address)}" required autocomplete="off"></label>
<label class="field c3">City <input name="city" value="${esc(a.city)}" required autocomplete="off"></label>
<label class="field c1">State <input name="state" value="${esc(a.state)}" required autocomplete="off"></label>
<label class="field c2">ZIP <input name="zip" value="${esc(a.zip)}" required autocomplete="off" inputmode="numeric"></label>
</div>
<h2>Delivery method</h2>
<label class="opt-card"><input type="radio" name="ship" value="standard" checked> <span><strong>Free standard shipping</strong> · ${esc(eta.long)}</span></label>
<button type="submit" class="btn btn-primary btn-block" data-testid="continue">Continue</button>
</form>
<aside class="card summary">
<h2>Order summary</h2>
${summaryBox(ctx, p, line, { withItem: true })}
</aside>
</div>`;
  return layout(ctx, { title: 'Checkout – shipping', body });
}

export function renderPayment(ctx, p, line, ship, token) {
  const c = TEST_CARD;
  const shipText = `${ship.name}, ${ship.address}, ${ship.city}, ${ship.state} ${ship.zip}`;
  const body = `${steps(1)}
<div class="co-grid">
<form class="card" method="post" action="/checkout/place">
<h2>Payment</h2>
<div class="notice">${ICONS.shield} <span>Test card only. This demo store never charges a real card.</span></div>
${hidden({ sku: p.sku, qty: line.qty, size: line.size, width: line.width, name: ship.name, address: ship.address, city: ship.city, state: ship.state, zip: ship.zip, token })}
<div class="form">
<label class="field c6">Card number <input name="card" value="${esc(c.number)}" required autocomplete="off" inputmode="numeric"></label>
<label class="field c3">Expiry (MM/YY) <input name="exp" value="${esc(c.exp)}" required autocomplete="off"></label>
<label class="field c3">CVC <input name="cvc" value="${esc(c.cvc)}" required autocomplete="off" inputmode="numeric"></label>
<label class="field c6">Name on card <input name="card_name" value="${esc(ship.name)}" autocomplete="off"></label>
</div>
<p class="shipto">Ship to: ${esc(shipText)} · <a href="/checkout?${esc(qs({ sku: p.sku, qty: line.qty, size: line.size, width: line.width }))}">Edit</a></p>
<button type="submit" class="btn btn-primary btn-block" data-testid="place-order"${p.in_stock ? '' : ' disabled'}>Place order</button>
</form>
<aside class="card summary">
<h2>Order summary</h2>
${summaryBox(ctx, p, line, { withItem: true })}
</aside>
</div>`;
  return layout(ctx, { title: 'Checkout – payment', body });
}

export function renderConfirmation(ctx, order) {
  const t = order.totals;
  const etaDate = new Date(order.delivery_eta + 'T12:00:00');
  const etaText = `Arrives ${weekdayName(etaDate)}, ${MONTHS[etaDate.getMonth()]} ${etaDate.getDate()}`;
  const s = order.ship_to;
  const body = `${steps(2)}
<div class="card confirm" data-testid="order-confirmation" data-order-id="${esc(order.order_id)}" data-total="${t.total.toFixed(2)}" data-subtotal="${t.subtotal.toFixed(2)}" data-tax="${t.tax.toFixed(2)}" data-shipping="${t.shipping.toFixed(2)}" data-currency="${esc(t.currency)}" data-eta="${esc(order.delivery_eta)}">
<div class="ok">${ICONS.check}</div>
<h1>Order ${esc(order.order_id)} confirmed</h1>
<p class="lead">Thanks, ${esc(s.name)}. ${esc(etaText)} to ${esc(`${s.address}, ${s.city}, ${s.state} ${s.zip}`)}.</p>
<div class="box">
${order.items.map((i) => `<div class="sum-row"><span>${esc(i.title)}${i.size ? ` · Size ${esc(i.size)} · ${esc(i.width)}` : ''} × ${i.qty}</span> <span>${money(i.unit_price * i.qty)}</span></div>`).join('\n')}
<div class="sum-row"><span>Shipping</span> <span>Free</span></div>
<div class="sum-row"><span>Tax</span> <span>${money(t.tax)}</span></div>
<div class="sum-row total"><span>Total charged to test card ending 4242</span> <span>${money(t.total)}</span></div>
</div>
<p class="muted small">Sold by ${esc(ctx.name)} · ${esc(order.return_policy)}</p>
<p class="muted small">Demo order – nothing ships and no real payment was taken.</p>
<a class="btn btn-ghost" href="/">Continue shopping</a>
</div>`;
  return layout(ctx, { title: `Order ${order.order_id} confirmed`, body });
}

export function renderMessage(ctx, { title, message, status = 404 }) {
  const body = `<div class="card err">
<h1 class="page-title">${esc(title)}</h1>
<p class="muted">${esc(message)}</p>
<a class="btn btn-primary" href="/">Back to ${esc(ctx.name)}</a>
</div>`;
  return layout(ctx, { title: `${status} – ${title}`, body });
}
