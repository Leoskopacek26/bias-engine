// ─────────────────────────────────────────────────────────────────────────────
// In-memory TTL cache pro Netlify Functions
// ─────────────────────────────────────────────────────────────────────────────
// Funguje DOKUD je funkce warm. Netlify drží Lambdas typicky 5–15 minut po
// posledním requestu, takže cache hit rate je dobrá pro burst usage.
// Pro trvalý cross-cold-start cache by byl potřeba Netlify Blobs / Redis.
// ─────────────────────────────────────────────────────────────────────────────

const TTL = {
  price:     5 * 60 * 1000,        //  5 min
  fund:      12 * 60 * 60 * 1000,  // 12 h
  fairvalue: 12 * 60 * 60 * 1000,  // 12 h
  health:    10 * 60 * 1000,       // 10 min
};

// { key: { value, expires } }
const store = new Map();

function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

function set(key, value, ttlMs) {
  store.set(key, { value, expires: Date.now() + ttlMs });
}

function clear() {
  store.clear();
}

function size() {
  return store.size;
}

function stats() {
  const now = Date.now();
  let expired = 0;
  let totalSize = 0;
  for (const [, entry] of store) {
    if (now > entry.expires) expired++;
    try { totalSize += JSON.stringify(entry.value).length; } catch {}
  }
  return { entries: store.size, expired, approxBytes: totalSize };
}

module.exports = { get, set, clear, size, stats, TTL };
