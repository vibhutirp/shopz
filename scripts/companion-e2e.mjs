#!/usr/bin/env node
// Shopz Companion end-to-end: the real extension (apps/companion) in Playwright Chromium (--load-extension), paired
// with a running agent. The test plays the human: it types the pairing code into the extension popup, clicks
// "Place order" on the payment page, signs in on the login page. Everything else is the agent through the extension.
//
//   AGENT=http://localhost:3000 RUNHUB=http://localhost:4001 [LIVE_STORE=www.allbirds.com] [OUT=dir] \
//   PLAYWRIGHT=/path/to/node_modules/playwright node scripts/companion-e2e.mjs
// The agent must run with COMPANION_DEBUG=1 (test hook /api/companion/cmd). LIVE_STORE='' skips the real-store part.
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '..', 'apps', 'companion');
const AGENT = (process.env.AGENT || 'http://localhost:3000').replace(/\/+$/, '');
const RUNHUB = (process.env.RUNHUB || 'http://localhost:4001').replace(/\/+$/, '');
const LIVE_STORE = process.env.LIVE_STORE ?? 'www.allbirds.com';
const OUT = process.env.OUT || mkdtempSync(path.join(os.tmpdir(), 'companion-e2e-'));
mkdirSync(OUT, { recursive: true });
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');

const results = [];
const sessions = {};
let failed = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 300) });
  if (!ok) failed += 1;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` – ${String(detail).slice(0, 200)}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(p, body) {
  const r = await fetch(AGENT + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  return r.json();
}
async function audit(session) { return (await api(`/api/audit?session=${encodeURIComponent(session)}`)).events || []; }
async function waitAudit(session, pred, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const evs = await audit(session);
    const hit = evs.find(pred);
    if (hit) return hit;
    if (Date.now() > end) return null;
    await sleep(400);
  }
}
async function say(session, text, mode) {
  const r = await api('/api/session/text', { session_id: session, text, mode });
  return (r.replies || []).join(' ');
}

const userDir = mkdtempSync(path.join(os.tmpdir(), 'companion-profile-'));
const ctx = await chromium.launchPersistentContext(userDir, {
  headless: false,
  viewport: { width: 1280, height: 860 },
  args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--no-default-browser-check'],
});
let exitCode = 1;
try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  check('extension loaded (service worker)', Boolean(extId), extId);

  // ------------------------------------------------------------ pairing helper (the human's part: code into the popup)
  async function pair(mode, width = 1280) {
    const panel = await ctx.newPage();
    await panel.setViewportSize({ width, height: 860 });
    await panel.goto(`${AGENT}/?mode=${mode}`);
    await panel.waitForSelector('#companionBtn');
    const session = await panel.evaluate(() => sessionStorage.getItem('shopz.session_id'));
    await panel.click('#companionBtn');
    await panel.waitForSelector('.cmp-card .cmp-code', { timeout: 8000 });
    const code = (await panel.textContent('.cmp-card .cmp-code')).replace(/\s+/g, '');
    await panel.screenshot({ path: path.join(OUT, `pair-${mode}-${width}.png`) });
    const pop = await ctx.newPage();
    await pop.goto(`chrome-extension://${extId}/popup.html`);
    await pop.fill('#server', AGENT);
    await pop.fill('#code', code);
    await pop.click('#connect');
    await pop.waitForSelector('#onBox:not([hidden])', { timeout: 10000 });
    await panel.waitForSelector('.cmp-card.done', { timeout: 10000 });
    await panel.bringToFront();
    await panel.screenshot({ path: path.join(OUT, `paired-${mode}-${width}.png`) });
    await pop.close();
    const st = await api(`/api/companion/status?session=${encodeURIComponent(session)}`);
    return { panel, session, code, st };
  }
  const shopzTab = () => ctx.pages().find((p) => !p.url().startsWith(AGENT) && !p.url().startsWith('chrome-extension://') && p.url() !== 'about:blank');

  // ------------------------------------------------------------ 1. demo stores through the user's browser
  const demo = await pair('demo');
  check('pairing: code shown in panel, entered in popup, panel shows connected', demo.st.connected, `code ${demo.code}, ${demo.st.browser}`);
  check('audit: companion_connected', await waitAudit(demo.session, (e) => e.type === 'companion_connected', 5000));

  let reply = await say(demo.session, 'I need running shoes for a half marathon in three weeks.', 'demo');
  reply += ' ' + await say(demo.session, 'By next Friday.', 'demo');
  const tab1 = shopzTab();
  check('demo: product page opened in the Shopz tab', tab1 && /\/p\//.test(tab1.url()), tab1 ? tab1.url() : 'no tab');
  const actions = (await audit(demo.session)).filter((e) => e.type === 'browser_action');
  check('demo: browser actions in the audit chain', actions.length >= 1, `${actions.length} browser_action`);
  const read = (await audit(demo.session)).filter((e) => e.type === 'page_read');
  check('demo: pages read (snapshot from the user\'s tab)', read.length >= 1, `${read.length} page_read, reply: ${reply.slice(0, 120)}`);
  if (tab1) await tab1.screenshot({ path: path.join(OUT, 'demo-shopz-tab.png') });

  // Guard rails, through the real extension (debug hook): no pay click, no password typing, no browser pages.
  const pay = await api('/api/companion/cmd', { session_id: demo.session, name: 'navigate', args: { url: `${RUNHUB}/checkout/payment?sku=RH-STW-GL5-W&qty=1&name=A&address=B&city=C&state=D&zip=1` } });
  const refusedPay = await api('/api/companion/cmd', { session_id: demo.session, name: 'click', args: { selector: '[data-testid="place-order"]' } });
  check('guard: extension refuses to click "Place order"', refusedPay.ok === false && refusedPay.refused, refusedPay.error || JSON.stringify(refusedPay).slice(0, 120));
  const gateRead = await api('/api/companion/cmd', { session_id: demo.session, name: 'read', args: {} });
  check('gate: payment page classified as payment', gateRead.ok && gateRead.data.gate.kind === 'payment', JSON.stringify(gateRead.data?.gate || gateRead.error || pay.error));
  const refusedCard = await api('/api/companion/cmd', { session_id: demo.session, name: 'fill', args: { selector: 'input[name="card"]', value: '4000000000000002' } });
  check('guard: extension refuses to type a card number', refusedCard.ok === false && refusedCard.refused, refusedCard.error);
  const refusedUrl = await api('/api/companion/cmd', { session_id: demo.session, name: 'navigate', args: { url: 'chrome://settings' } });
  check('guard: extension refuses chrome:// pages', refusedUrl.ok === false && refusedUrl.refused, refusedUrl.error);
  const shot = await api('/api/companion/cmd', { session_id: demo.session, name: 'screenshot', args: {} });
  check('screenshot of the Shopz tab', shot.ok && /^data:image\/jpeg;base64,/.test(shot.data?.image || ''), shot.error || `${String(shot.data?.image || '').length} chars`);

  // Buy: the agent fills cart + shipping in the tab, the human clicks "Place order". Under the limit Shopz buys without
  // asking (policy AUTO_APPROVE) – then the "Buy that." call itself waits for the human at the payment page.
  sessions.demo = demo.session;
  await say(demo.session, 'Go back to the first one.', 'demo');
  let pBuy = api('/api/session/text', { session_id: demo.session, text: 'Buy that.', mode: 'demo' });
  let turn = await Promise.race([waitAudit(demo.session, (e) => e.type === 'human_handoff' && e.data.kind === 'payment', 40000), pBuy.then(() => null)]);
  if (!turn) {
    const first = await pBuy;
    const txt = (first.replies || []).join(' ');
    if (/confirm purchase/i.test(txt)) {
      check('demo buy: over the limit → Shopz asks "confirm purchase"', true, txt.slice(0, 120));
      pBuy = api('/api/session/text', { session_id: demo.session, text: 'confirm purchase', mode: 'demo' });
      turn = await waitAudit(demo.session, (e) => e.type === 'human_handoff' && e.data.kind === 'payment', 40000);
    } else check('demo buy: reached the payment page', false, txt.slice(0, 300));
  }
  if (turn) {
    check('demo buy: agent stops at the payment page, hand-off "payment"', true, turn.summary);
    await demo.panel.bringToFront();
    await demo.panel.waitForSelector('.cmp-turn', { timeout: 5000 }).catch(() => {});
    const turnText = await demo.panel.textContent('.cmp-turn').catch(() => '');
    check('panel shows "Your turn" for paying', /Your turn/i.test(turnText), turnText.slice(0, 120));
    await demo.panel.screenshot({ path: path.join(OUT, 'demo-your-turn-pay-1280.png') });
    const t = shopzTab();
    const banner = await t.evaluate(() => Boolean(document.querySelector('shopz-companion')));
    check('Shopz tab shows the hand-off banner', banner);
    await t.screenshot({ path: path.join(OUT, 'demo-tab-your-turn.png') });
    await t.click('[data-testid="place-order"]'); // the human pays (demo test card)
    const out = await pBuy;
    const order = (await audit(demo.session)).find((e) => e.type === 'order_confirmed');
    check('demo buy: order confirmed after the human placed it', Boolean(order), (out.replies || []).join(' ').slice(0, 200));
    check('demo buy: executor companion', order && order.data.executor === 'companion', JSON.stringify(order?.data?.executor));
    const resumed = (await audit(demo.session)).find((e) => e.type === 'human_resumed');
    check('demo buy: hand-off ended by the order page', resumed && resumed.data.resumed_by === 'order_page', resumed?.data?.resumed_by);
  }
  const v1 = await api(`/api/audit/verify?session=${encodeURIComponent(demo.session)}`);
  check('demo: audit chain verifies', v1.ok === true || v1.valid === true, JSON.stringify(v1).slice(0, 120));

  // ------------------------------------------------------------ 2. live mode: sign-in hand-off on a login page
  const live = await pair('live', 390);
  check('live pairing (second session replaces the first)', live.st.connected);
  sessions.live = live.session;
  const pBrowse = api('/api/session/text', { session_id: live.session, text: `open ${RUNHUB.replace(/^https?:\/\//, '')}/account`, mode: 'live' });
  const loginTurn = await waitAudit(live.session, (e) => e.type === 'human_handoff', 20000);
  check('login page → hand-off "login"', loginTurn && loginTurn.data.kind === 'login', loginTurn ? loginTurn.summary : 'none');
  await live.panel.bringToFront();
  await live.panel.waitForSelector('.cmp-turn', { timeout: 5000 }).catch(() => {});
  const lt = await live.panel.textContent('.cmp-turn').catch(() => '');
  check('panel (390 px) shows "Your turn: please sign in"', /Your turn/i.test(lt) && /sign in/i.test(lt), lt.slice(0, 120));
  await live.panel.screenshot({ path: path.join(OUT, 'live-your-turn-login-390.png') });
  const lt2 = shopzTab();
  await lt2.screenshot({ path: path.join(OUT, 'live-tab-login.png') });
  await lt2.fill('input[name="email"]', 'demo@example.com'); // the human signs in
  await lt2.fill('input[name="password"]', 'demo-only');
  await lt2.click('[data-testid="sign-in"]');
  const outBrowse = await pBrowse;
  const res = (await audit(live.session)).find((e) => e.type === 'human_resumed');
  check('after sign-in Shopz carries on by itself', res && res.data.resumed_by === 'auto', res ? res.data.resumed_by : 'none');
  check('agent read the account page after sign-in', /account/i.test((outBrowse.replies || []).join(' ')), (outBrowse.replies || []).join(' ').slice(0, 160));

  // ------------------------------------------------------------ 3. a real Shopify store through the user's browser
  if (LIVE_STORE) {
    const q = process.env.LIVE_QUERY || 'wool runners under 150 dollars';
    const r1 = await api('/api/session/text', { session_id: live.session, text: q, mode: 'live' });
    const txt = (r1.replies || []).join(' ');
    check('real store: search + pages via the user\'s browser', /from your browser/i.test(txt), txt.slice(0, 200));
    const pr = (await audit(live.session)).filter((e) => e.type === 'page_read' && e.data.url && e.data.url.includes(LIVE_STORE.replace(/^www\./, '')));
    check('real store: product page read from the Shopz tab (JSON-LD)', pr.length >= 1 && pr.some((e) => e.data.fields?.source === 'json-ld'), pr.map((e) => e.data.fields?.source).join(','));
    const r2 = await api('/api/session/text', { session_id: live.session, text: 'buy the first one', mode: 'live' });
    let t2 = (r2.replies || []).join(' ');
    if (/say confirm/i.test(t2)) t2 += ' ' + ((await api('/api/session/text', { session_id: live.session, text: 'confirm', mode: 'live' })).replies || []).join(' ');
    const cart = (await audit(live.session)).find((e) => e.type === 'cart_checked');
    check('real store: item in the store cart in the user\'s browser', cart && cart.data.line, cart ? cart.summary : t2.slice(0, 200));
    const ho = (await audit(live.session)).find((e) => e.type === 'handoff' && e.data.in_your_browser);
    check('real store: checkout open, hand-off to the human (Shopz never pays)', ho && ho.data.paid_by_shopz === false, ho ? `${ho.data.checkout_gate} ${ho.data.url}` : t2.slice(0, 200));
    const t3 = shopzTab();
    if (t3) await t3.screenshot({ path: path.join(OUT, 'live-real-store-checkout.png') });
    await live.panel.setViewportSize({ width: 1440, height: 900 });
    await live.panel.bringToFront();
    await live.panel.screenshot({ path: path.join(OUT, 'live-real-store-panel-1440.png'), fullPage: false });
  }
  const v2 = await api(`/api/audit/verify?session=${encodeURIComponent(live.session)}`);
  check('live: audit chain verifies', v2.ok === true || v2.valid === true, JSON.stringify(v2).slice(0, 120));
  exitCode = failed ? 1 : 0;
} catch (err) {
  check('run', false, err.stack || err.message);
} finally {
  writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ at: new Date().toISOString(), failed, sessions, results }, null, 1));
  console.log(`\n${results.length - failed}/${results.length} OK · screenshots + result.json in ${OUT}`);
  await ctx.close().catch(() => {});
  process.exit(exitCode);
}
