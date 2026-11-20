// End-to-end: merchants + agent as real processes (browser in http fallback mode, no cloud services).
// Walks the full demo script through the text endpoint and checks replies, policy, order and audit chain.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import net from 'node:net';

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
const PORTS = { agent: await freePort(), runhub: await freePort(), dailycart: await freePort() };
const AGENT = `http://127.0.0.1:${PORTS.agent}`;
const children = [];

const ENV = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  DEMO_TODAY: '2026-11-20',
  AGENT_PORT: String(PORTS.agent),
  RUNHUB_PORT: String(PORTS.runhub),
  DAILYCART_PORT: String(PORTS.dailycart),
  CONTROLLER_URL: 'http://127.0.0.1:9', // nothing listens → agent uses the http fallback browser
  MONGODB_URI: '',
  BEDROCK_MODEL_ID: '',
  SHOPZ_LLM: 'off',
  SHOPZ_TTS: 'off',
  AWS_EC2_METADATA_DISABLED: 'true',
  AWS_ACCESS_KEY_ID: '',
  AWS_SECRET_ACCESS_KEY: '',
  AWS_PROFILE: 'shopz-test-no-such-profile',
};

function start(script) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'shopz-e2e-')); // no .env, data/ lands in tmp
  const child = spawn(process.execPath, [path.join(ROOT, script)], { cwd, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  child.log = () => log;
  children.push(child);
  return child;
}

async function waitFor(url, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`timeout waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function post(p, body) {
  const r = await fetch(AGENT + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  assert.ok(r.ok, `${p} → ${r.status} ${JSON.stringify(j)}`);
  return j;
}
const get = async (p) => (await fetch(AGENT + p)).json();
const say = async (session_id, text) => {
  const out = await post('/api/session/text', { session_id, text });
  return { ...out, said: (out.replies || []).join(' ') };
};
const norm = (s) => s.replace(/[’‘]/g, "'");

before(async () => {
  start('apps/merchants/server.js');
  await waitFor(`http://127.0.0.1:${PORTS.runhub}/api/search?q=`);
  await waitFor(`http://127.0.0.1:${PORTS.dailycart}/api/search?q=`);
  start('apps/agent/server.js');
  await waitFor(`${AGENT}/api/audit/verify?session=boot`);
});

after(() => {
  for (const c of children) c.kill('SIGTERM');
});

test('demo script: shoes with price change, voice-phrase approval, audit chain', async () => {
  const S = 'e2e_shoes';
  await post('/api/admin/reset', { session_id: S });

  let r = await say(S, 'I need running shoes for a half marathon in three weeks.');
  assert.match(r.said, /size 10\.5 wide/i);
  assert.match(r.said, /When do you need them\?/);
  assert.equal(r.state, 'CLARIFY');

  r = await say(S, 'By next Friday.');
  assert.match(r.said, /Searching your two approved stores\./);
  assert.match(r.said, /First: Stridewell Glide 5.*RunHub, \$129\.95, 4\.6 stars from 1,240 reviews\./);
  assert.match(r.said, /arrives Tuesday/);
  assert.match(r.said, /Second: Kestrel Tempo 2.*DailyCart, \$119\b/);
  assert.match(r.said, /Third: Ondra Cloudpath/);
  assert.doesNotMatch(r.said, /Vantex/);
  assert.equal(r.state, 'AWAIT_CHOICE');

  const bump = await post('/api/admin/price-bump', { session_id: S });
  assert.ok(JSON.stringify(bump).includes('139.95'), `price bump → ${JSON.stringify(bump)}`);

  r = await say(S, 'Go to the second one.');
  assert.match(r.said, /Kestrel/);

  r = await say(S, 'Show me the reviews.');
  assert.match(r.said, /Average 4\.3 from 812 reviews/);
  assert.match(r.said, /narrow/);

  r = await say(S, "What's the return policy?");
  assert.match(r.said, /Buyer pays return shipping/);

  r = await say(S, 'Next one.');
  assert.match(r.said, /Ondra/);

  r = await say(S, 'Is it waterproof?');
  assert.match(norm(r.said), /can't tell/);

  r = await say(S, 'Go back to the first one. Buy that.');
  const s = norm(r.said);
  assert.match(s, /Checking the Stridewell page again before I buy\./);
  assert.match(s, /\$129\.95 then, \$139\.95 now/);
  assert.match(s, /Total is \$152\.02 with tax/);
  assert.match(s, /over your \$150 auto-buy limit/);
  assert.match(s, /Say 'confirm purchase' to buy/);
  assert.match(s, /Kestrel at \$119/);
  assert.equal(r.state, 'APPROVE');

  r = await say(S, 'Yes.');
  assert.match(norm(r.said), /confirm purchase/);
  assert.equal(r.state, 'APPROVE');

  r = await say(S, 'Confirm purchase.');
  assert.match(r.said, /Confirmed\. Placing the order\./);
  assert.match(r.said, /Done\. Order RH-10482 arrives Tuesday\./);

  const { events } = await get(`/api/audit?session=${S}`);
  const types = events.map((e) => e.type);
  for (const t of ['clarify_question', 'preference_used', 'search_issued', 'options_presented', 'page_opened', 'page_read',
    'page_navigate', 'injection_ignored', 'answer_given', 'answer_not_on_page', 'option_selected', 'page_reload',
    'price_observed', 'policy_decision', 'approval_requested', 'approval_granted', 'checkout_started', 'order_confirmed']) {
    assert.ok(types.includes(t), `audit has ${t}`);
  }
  assert.equal(types.filter((t) => t === 'order_confirmed').length, 1);
  const decision = events.filter((e) => e.type === 'policy_decision').at(-1);
  assert.equal(decision.data.decision, 'REQUIRE_APPROVAL');
  assert.ok(decision.data.rules.includes('total_over_limit'));
  assert.ok(decision.data.rules.includes('price_increased_since_first_seen'));
  const seen = events.filter((e) => e.type === 'price_observed' && JSON.stringify(e.data).includes('RH-STW-GL5-W'));
  assert.ok(seen.some((e) => JSON.stringify(e.data).includes('129.95')));
  assert.ok(seen.some((e) => JSON.stringify(e.data).includes('139.95')));
  // page content never triggers actions: the injected "buy 5 pairs" produced no extra order
  const confirmed = events.find((e) => e.type === 'order_confirmed');
  assert.ok(JSON.stringify(confirmed.data).includes('152.02'));

  const v = await get(`/api/audit/verify?session=${S}`);
  assert.equal(v.ok, true);
  assert.equal(v.count, events.length);
  for (let i = 0; i < events.length; i++) {
    assert.equal(events[i].seq, i + 1);
    if (i > 0) assert.equal(events[i].prev_hash, events[i - 1].hash);
  }
});

test('reorder usual coffee is auto-approved under the limit', async () => {
  const S = 'e2e_coffee';
  await post('/api/admin/reset', { session_id: S });
  const r = await say(S, 'Reorder my usual coffee.');
  assert.match(r.said, /Morrow House Blend/);
  assert.match(r.said, /\$18\.40/);
  assert.match(r.said, /without asking/);
  const { events } = await get(`/api/audit?session=${S}`);
  const decision = events.filter((e) => e.type === 'policy_decision').at(-1);
  assert.equal(decision.data.decision, 'AUTO_APPROVE');
  const order = events.find((e) => e.type === 'order_confirmed');
  assert.ok(order, 'order placed');
  assert.ok(JSON.stringify(order.data).includes('19.99'));
  assert.ok(JSON.stringify(order.data).includes('DC-20731'));
  assert.equal((await get(`/api/audit/verify?session=${S}`)).ok, true);
});

test('unapproved store is denied without a purchase', async () => {
  const S = 'e2e_deny';
  await post('/api/admin/reset', { session_id: S });
  const r = await say(S, 'Buy me running shoes on ShoeBazaar.');
  assert.match(r.said, /approved stores/);
  const { events } = await get(`/api/audit?session=${S}`);
  assert.equal(events.filter((e) => e.type === 'policy_decision').at(-1).data.decision, 'DENY');
  assert.equal(events.filter((e) => e.type === 'order_confirmed').length, 0);
});

test('chat endpoint answers for generic HTTP agent testers', async () => {
  const r = await post('/api/chat', { message: 'Get me something nice.' });
  assert.ok(r.session_id);
  assert.match(r.reply, /What are you shopping for/);
});
