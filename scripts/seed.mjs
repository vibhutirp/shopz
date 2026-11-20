#!/usr/bin/env node
// Seeds MongoDB Atlas for Shopz: demo preferences, the product catalog with Titan text embeddings,
// and the Atlas Vector Search index "products_vector". Safe to run more than once.
// Needs MONGODB_URI. Embeddings need AWS credentials with Bedrock access (else stored without vectors).
// The merchants must be running (npm run merchants) – the catalog is read from their JSON API.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../packages/contracts/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await loadEnv(path.join(ROOT, '.env'));

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'shopz';
const EMBED_MODEL = process.env.BEDROCK_EMBED_MODEL_ID || 'amazon.titan-embed-text-v2:0';
const DIMS = 512;

if (!uri) {
  console.log('No MONGODB_URI set – nothing to seed. The agent runs on its in-memory store.');
  process.exit(0);
}

const bases = [
  `http://localhost:${process.env.RUNHUB_PORT || 4001}`,
  `http://localhost:${process.env.DAILYCART_PORT || 4002}`,
];

async function loadCatalog() {
  const products = [];
  for (const base of bases) {
    const res = await fetch(`${base}/api/search?q=`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`${base} → ${res.status}`);
    const { results = [] } = await res.json();
    for (const p of results) {
      const full = await (await fetch(`${base}/api/products/${encodeURIComponent(p.sku)}`, { signal: AbortSignal.timeout(5000) })).json();
      products.push({ ...p, details: full });
    }
  }
  return products;
}

let embedClient = null;
let embedWarned = false;
async function embed(text) {
  try {
    if (!embedClient) {
      const { BedrockRuntimeClient } = await import('@aws-sdk/client-bedrock-runtime');
      embedClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });
    }
    const { InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime');
    const out = await embedClient.send(new InvokeModelCommand({
      modelId: EMBED_MODEL,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({ inputText: text, dimensions: DIMS, normalize: true }),
    }));
    return JSON.parse(new TextDecoder().decode(out.body)).embedding;
  } catch (err) {
    if (!embedWarned) console.warn(`! embeddings unavailable (${err.name || err.message}) – storing products without vectors`);
    embedWarned = true;
    return null;
  }
}

const docText = (p) => {
  const specs = p.details?.specs ? Object.entries(p.details.specs).map(([k, v]) => `${k}: ${v}`).join('; ') : '';
  return `${p.title}. Brand ${p.brand}. Category ${p.category}. Sold by ${p.store_name}. ${specs}`;
};

const { MongoClient } = await import('mongodb');
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
await client.connect();
const db = client.db(dbName);

// 1) preferences (same seed the agent uses)
const { SEEDED_PREFS } = await import('../apps/agent/src/prefs.js');
for (const pref of SEEDED_PREFS) {
  await db.collection('preferences').updateOne({ pref_id: pref.pref_id }, { $set: pref }, { upsert: true });
}
console.log(`✓ preferences: ${SEEDED_PREFS.length} (labeled seeded_for_demo)`);

// 2) products + embeddings
const catalog = await loadCatalog();
let withVectors = 0;
for (const p of catalog) {
  const embedding = await embed(docText(p));
  if (embedding) withVectors++;
  const { details, ...summary } = p;
  await db.collection('products').updateOne(
    { sku: p.sku },
    { $set: { ...summary, specs: details?.specs ?? null, demo_data: true, ...(embedding ? { embedding } : {}) } },
    { upsert: true },
  );
}
console.log(`✓ products: ${catalog.length} (${withVectors} with ${DIMS}-dim embeddings)`);

// 3) indexes
await db.collection('audit_events').createIndex({ session_id: 1, seq: 1 }, { unique: true });
await db.collection('orders').createIndex({ user_id: 1, placed_at: -1 });
try {
  await db.collection('products').createSearchIndex({
    name: 'products_vector',
    type: 'vectorSearch',
    definition: {
      fields: [
        { type: 'vector', path: 'embedding', numDimensions: DIMS, similarity: 'cosine' },
        { type: 'filter', path: 'category' },
        { type: 'filter', path: 'store' },
      ],
    },
  });
  console.log('✓ vector index products_vector requested (Atlas builds it in about a minute)');
} catch (err) {
  console.log(`• vector index not created: ${err.codeName || err.message}`);
}
await client.close();
