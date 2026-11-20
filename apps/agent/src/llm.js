// Amazon Bedrock Converse API. Never throws: returns null when the SDK, credentials or model are unavailable,
// on any error and on timeout, so every caller keeps a deterministic fallback.

let sdk = null; // { region, client, ConverseCommand }
let sdkMissing = false;
let lastOk = null; // null = not tried yet
let cooldownUntil = 0;
const logged = new Set();

const CONFIG_ERRORS = new Set([
  'CredentialsProviderError', 'AccessDeniedException', 'UnrecognizedClientException', 'ExpiredTokenException',
  'InvalidSignatureException', 'ResourceNotFoundException', 'TokenRefreshRequired',
]);

function warnOnce(err) {
  const key = `${(err && err.name) || 'Error'}: ${String((err && err.message) || err).slice(0, 160)}`;
  if (logged.has(key)) return;
  logged.add(key);
  console.warn(`[llm] Bedrock unavailable, using fallback (${key})`);
}

function isConfigError(err) {
  if (!err) return false;
  if (CONFIG_ERRORS.has(err.name)) return true;
  if (err.name === 'ValidationException' && /model|inference profile|throughput/i.test(err.message || '')) return true;
  return /credential|region is missing/i.test(err.message || '');
}

async function getClient(region) {
  if (sdk && sdk.region === region) return sdk;
  let mod;
  try {
    mod = await import('@aws-sdk/client-bedrock-runtime');
  } catch (err) {
    sdkMissing = true;
    throw err;
  }
  sdk = { region, client: new mod.BedrockRuntimeClient({ region }), ConverseCommand: mod.ConverseCommand };
  return sdk;
}

function stripFence(text) {
  const m = text.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?\s*```$/);
  return m ? m[1].trim() : text;
}

export async function complete({ system, user, maxTokens = 400, json = false, timeoutMs = 8000 } = {}) {
  const modelId = process.env.BEDROCK_MODEL_ID;
  if (!modelId) {
    lastOk = false;
    warnOnce({ name: 'Config', message: 'BEDROCK_MODEL_ID is not set' });
    return null;
  }
  if (sdkMissing || !user || Date.now() < cooldownUntil) return null;
  const region = process.env.AWS_REGION || 'us-east-1';
  const ac = new AbortController();
  let timer;
  try {
    const { client, ConverseCommand } = await getClient(region);
    const systemText = [system, json ? 'Reply with one JSON object only, no prose and no code fences.' : null].filter(Boolean).join('\n\n');
    const input = {
      modelId,
      messages: [{ role: 'user', content: [{ text: String(user) }] }],
      inferenceConfig: { maxTokens, temperature: 0 },
    };
    if (systemText) input.system = [{ text: systemText }];
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(Object.assign(new Error(`timeout after ${timeoutMs} ms`), { name: 'TimeoutError' }));
      }, timeoutMs);
    });
    const res = await Promise.race([client.send(new ConverseCommand(input), { abortSignal: ac.signal }), timeout]);
    const blocks = (res && res.output && res.output.message && res.output.message.content) || [];
    let text = blocks.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('').trim();
    if (json) text = stripFence(text);
    lastOk = true;
    return text || null;
  } catch (err) {
    lastOk = false;
    warnOnce(err);
    // Missing credentials / model access will not fix itself within one demo turn: skip calls for a while
    // instead of paying the credential lookup again. Transient errors (timeout, throttling) back off briefly.
    cooldownUntil = Date.now() + (isConfigError(err) ? 60000 : 10000);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** true when the last call succeeded or none was tried yet (false while a failure back-off is active). */
export function llmAvailable() {
  if (!process.env.BEDROCK_MODEL_ID || sdkMissing) return false;
  return lastOk !== false || Date.now() >= cooldownUntil;
}
