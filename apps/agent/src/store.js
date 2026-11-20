// Persistence: MongoDB Atlas when MONGODB_URI is set and reachable, otherwise in-memory Maps
// (+ audit events appended to data/audit-<session_id>.jsonl).
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isoDate, today } from '../../../packages/contracts/index.js';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const redact = (s) => String(s).replace(/\/\/[^@/\s]+@/g, '//***@');
const fileSafe = (s) => String(s ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) || '_';

const warned = new Set();
function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

export async function createStore({ uri = process.env.MONGODB_URI, db = process.env.MONGODB_DB || 'shopz', dataDir = 'data' } = {}) {
  if (uri) {
    try {
      return await createMongoStore(uri, db);
    } catch (err) {
      console.warn(`[store] MongoDB unavailable (${redact(err && err.message ? err.message : err)}), using the in-memory store`);
    }
  }
  return createMemoryStore(dataDir);
}

function createMemoryStore(dataDir) {
  const audit = new Map(); // session_id -> AuditEvent[] (sorted by seq)
  const prefs = new Map(); // user_id + pref_id -> UserPreference
  const orders = []; // { order, day }
  let dirReady = null;

  async function writeJsonl(event) {
    if (!dataDir) return;
    try {
      if (!dirReady) dirReady = mkdir(dataDir, { recursive: true });
      await dirReady;
      await appendFile(join(dataDir, `audit-${fileSafe(event.session_id)}.jsonl`), JSON.stringify(event) + '\n', 'utf8');
    } catch (err) {
      dirReady = null;
      warnOnce('jsonl', `[store] could not write the audit JSONL file (${err.message}); events stay in memory`);
    }
  }

  return {
    kind: 'memory',
    audit: {
      async append(event) {
        const copy = clone(event);
        const list = audit.get(copy.session_id) || [];
        if (list.some((e) => e.seq === copy.seq)) throw new Error(`duplicate audit seq ${copy.seq} for session ${copy.session_id}`);
        list.push(copy);
        list.sort((a, b) => a.seq - b.seq);
        audit.set(copy.session_id, list);
        await writeJsonl(copy);
      },
      async list(session_id) {
        return clone(audit.get(session_id) || []);
      },
    },
    prefs: {
      async list(user_id) {
        return [...prefs.values()].filter((p) => p.user_id === user_id).map(clone);
      },
      async upsert(pref) {
        const doc = clone(pref);
        delete doc._id;
        const key = `${doc.user_id}\u0000${doc.pref_id}`;
        prefs.set(key, { ...(prefs.get(key) || {}), ...doc });
      },
    },
    orders: {
      async insert(order) {
        const doc = clone(order);
        delete doc._id;
        orders.push({ order: doc, day: isoDate(today()) });
      },
      async countToday(user_id) {
        const day = isoDate(today());
        return orders.filter((o) => o.order.user_id === user_id && o.day === day).length;
      },
      async list(user_id) {
        return orders.filter((o) => o.order.user_id === user_id).map((o) => clone(o.order));
      },
    },
    products: {
      async vectorSearch() {
        return null; // no Atlas vector index in memory mode
      },
    },
    async close() {},
    // Test hook: direct access to the in-memory data (e.g. to simulate tampering).
    _mem: { audit, prefs, orders },
  };
}

async function createMongoStore(uri, dbName) {
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, appName: 'shopz-agent' });
  await client.connect();
  const database = client.db(dbName);
  const col = {
    audit: database.collection('audit_events'),
    prefs: database.collection('preferences'),
    orders: database.collection('orders'),
    products: database.collection('products'),
  };
  try {
    await col.audit.createIndex({ session_id: 1, seq: 1 }, { unique: true });
  } catch (err) {
    warnOnce('mongo-index', `[store] could not create the audit_events index (${redact(err.message)})`);
  }
  const noId = { projection: { _id: 0 } };

  return {
    kind: 'mongo',
    audit: {
      async append(event) {
        await col.audit.insertOne(clone(event)); // copy: the driver adds _id to the inserted object
      },
      async list(session_id) {
        return col.audit.find({ session_id }, noId).sort({ seq: 1 }).toArray();
      },
    },
    prefs: {
      async list(user_id) {
        return col.prefs.find({ user_id }, noId).toArray();
      },
      async upsert(pref) {
        const doc = clone(pref);
        delete doc._id;
        await col.prefs.updateOne({ user_id: doc.user_id, pref_id: doc.pref_id }, { $set: doc }, { upsert: true });
      },
    },
    orders: {
      async insert(order) {
        const doc = clone(order);
        delete doc._id;
        doc._day = isoDate(today()); // demo "today" (DEMO_TODAY aware) for countToday
        await col.orders.insertOne(doc);
      },
      async countToday(user_id) {
        return col.orders.countDocuments({ user_id, _day: isoDate(today()) });
      },
      async list(user_id) {
        return col.orders.find({ user_id }, { projection: { _id: 0, _day: 0 } }).toArray();
      },
    },
    products: {
      async vectorSearch(vector, k = 5, filter = null) {
        try {
          if (!Array.isArray(vector) || vector.length === 0) return null;
          const limit = Math.max(1, Math.min(Number(k) || 5, 100));
          const stage = { index: 'products_vector', path: 'embedding', queryVector: vector, numCandidates: Math.max(limit * 10, 50), limit };
          if (filter && typeof filter === 'object' && Object.keys(filter).length) stage.filter = filter; // pre-filter on indexed fields
          const docs = await col.products.aggregate([
            { $vectorSearch: stage },
            { $addFields: { score: { $meta: 'vectorSearchScore' } } },
            { $project: { _id: 0, embedding: 0 } },
          ]).toArray();
          return docs.length ? docs : null; // empty = no usable index / no catalog
        } catch (err) {
          warnOnce('vector', `[store] vector search unavailable (${redact(err.message)})`);
          return null;
        }
      },
    },
    async close() {
      try { await client.close(); } catch { /* ignore */ }
    },
  };
}
