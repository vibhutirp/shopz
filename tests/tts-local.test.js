// Local voice server (TTS_URL): a busy server (timeout) must not switch the voice off; a dead one may.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TTS_URL = 'http://tts.invalid:1';
process.env.AWS_REGION = '';
const realFetch = globalThis.fetch;
const { synthesize } = await import('../apps/agent/src/tts.js');

function wav() { return new Response(new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'audio/wav' } }); }

test('a timeout from the local voice server does not block the next sentence', async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    return wav();
  };
  try {
    await synthesize('First sentence that times out.');
    const out = await synthesize('Second sentence.');
    assert.ok(out && out.type === 'audio/wav', 'second sentence uses the local voice again');
    assert.equal(calls.filter((u) => u.startsWith('http://tts.invalid:1/tts?')).length, 2);
  } finally { globalThis.fetch = realFetch; }
});

test('a refused connection pauses the local voice server for a while', async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    return wav();
  };
  try {
    await synthesize('Third sentence, server down.');
    await synthesize('Fourth sentence.');
    assert.equal(calls.filter((u) => u.startsWith('http://tts.invalid:1/tts?')).length, 1, 'no second try during the pause');
  } finally { globalThis.fetch = realFetch; }
});
