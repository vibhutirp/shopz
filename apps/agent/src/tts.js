// Amazon Polly text-to-speech (mp3). Never throws: returns null so the panel falls back to speechSynthesis.

let polly = null; // { region, client, SynthesizeSpeechCommand }
let sdkMissing = false;
let cooldownUntil = 0;
const logged = new Set();
const cache = new Map(); // voice|engine|text -> Buffer (demo lines repeat between takes)
const CACHE_MAX = 100;
const TIMEOUT_MS = 8000;

function warnOnce(err) {
  const key = `${(err && err.name) || 'Error'}: ${String((err && err.message) || err).slice(0, 160)}`;
  if (logged.has(key)) return;
  logged.add(key);
  console.warn(`[tts] Polly unavailable, panel uses browser speech (${key})`);
}

const isConfigError = (err) => Boolean(err) && (
  ['CredentialsProviderError', 'AccessDeniedException', 'UnrecognizedClientException', 'ExpiredTokenException', 'InvalidSignatureException'].includes(err.name)
  || /credential|region is missing/i.test(err.message || ''));

async function getPolly(region) {
  if (polly && polly.region === region) return polly;
  let mod;
  try {
    mod = await import('@aws-sdk/client-polly');
  } catch (err) {
    sdkMissing = true;
    throw err;
  }
  polly = { region, client: new mod.PollyClient({ region }), SynthesizeSpeechCommand: mod.SynthesizeSpeechCommand };
  return polly;
}

async function toBuffer(stream) {
  if (!stream) return null;
  if (typeof stream.transformToByteArray === 'function') return Buffer.from(await stream.transformToByteArray());
  if (stream instanceof Uint8Array) return Buffer.from(stream);
  if (typeof stream[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  if (typeof stream.arrayBuffer === 'function') return Buffer.from(await stream.arrayBuffer());
  return null;
}

export async function synthesize(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 2900);
  if (!t || sdkMissing || Date.now() < cooldownUntil) return null;
  const voice = process.env.POLLY_VOICE || 'Matthew';
  const engine = process.env.POLLY_ENGINE || 'neural';
  const key = `${voice}|${engine}|${t}`;
  if (cache.has(key)) return cache.get(key);
  const ac = new AbortController();
  let timer;
  try {
    const { client, SynthesizeSpeechCommand } = await getPolly(process.env.AWS_REGION || 'us-east-1');
    const run = (async () => {
      const res = await client.send(new SynthesizeSpeechCommand({ Text: t, TextType: 'text', OutputFormat: 'mp3', VoiceId: voice, Engine: engine }), { abortSignal: ac.signal });
      return toBuffer(res && res.AudioStream);
    })();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(Object.assign(new Error(`timeout after ${TIMEOUT_MS} ms`), { name: 'TimeoutError' }));
      }, TIMEOUT_MS);
    });
    const buf = await Promise.race([run, timeout]);
    if (!buf || buf.length === 0) return null;
    cache.set(key, buf);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return buf;
  } catch (err) {
    warnOnce(err);
    cooldownUntil = Date.now() + (isConfigError(err) ? 60000 : 5000);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
