// Amazon Titan Text Embeddings v2 through Bedrock InvokeModel – same model and settings as scripts/seed.mjs,
// so query vectors live in the same space as the seeded catalog. Never throws: returns null without the SDK,
// credentials or model access, on any error and on timeout, and then pauses for a few minutes so a missing
// setup does not slow every search down.

export const EMBED_DIMS = 512;
const COOLDOWN_MS = 5 * 60 * 1000;

let sdk = null; // { region, client, InvokeModelCommand }
let sdkMissing = false;
let cooldownUntil = 0;
const logged = new Set();

function warnOnce(err) {
  const key = `${(err && err.name) || 'Error'}: ${String((err && err.message) || err).slice(0, 160)}`;
  if (logged.has(key)) return;
  logged.add(key);
  console.warn(`[embed] Titan embeddings unavailable, vector search skipped (${key})`);
}

async function getClient(region) {
  if (sdk && sdk.region === region) return sdk;
  const mod = await import('@aws-sdk/client-bedrock-runtime');
  sdk = { region, client: new mod.BedrockRuntimeClient({ region }), InvokeModelCommand: mod.InvokeModelCommand };
  return sdk;
}

/** Text → 512-dim normalized vector, or null. */
export async function embedText(text, { timeoutMs = 2500 } = {}) {
  const input = String(text ?? '').trim().slice(0, 2000);
  if (!input || sdkMissing || Date.now() < cooldownUntil) return null;
  const modelId = process.env.BEDROCK_EMBED_MODEL_ID || 'amazon.titan-embed-text-v2:0';
  const region = process.env.AWS_REGION || 'us-east-1';
  const ac = new AbortController();
  let timer;
  try {
    let client;
    let InvokeModelCommand;
    try {
      ({ client, InvokeModelCommand } = await getClient(region));
    } catch (err) {
      sdkMissing = true;
      warnOnce(err);
      return null;
    }
    const call = client.send(new InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({ inputText: input, dimensions: EMBED_DIMS, normalize: true }),
    }), { abortSignal: ac.signal });
    // The race also covers credential lookup, which an abort signal does not always stop.
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(Object.assign(new Error(`timeout after ${timeoutMs} ms`), { name: 'TimeoutError' }));
      }, timeoutMs);
    });
    const out = await Promise.race([call, timeout]);
    const vector = JSON.parse(new TextDecoder().decode(out.body))?.embedding;
    if (!Array.isArray(vector) || vector.length !== EMBED_DIMS) throw new Error('unexpected embedding shape');
    return vector;
  } catch (err) {
    cooldownUntil = Date.now() + COOLDOWN_MS;
    warnOnce(err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
