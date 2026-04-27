// ─────────────────────────────────────────────────────────────────────────────
// Finnhub data layer
// ─────────────────────────────────────────────────────────────────────────────
// Free tier: 60 calls/min. Klíč v process.env.FINNHUB_API_KEY.
// Endpointy: /quote, /stock/metric?metric=all, /stock/profile2
// Vrací { data, error, status } — error obsahuje lidsky čitelnou hlášku.
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');

const BASE = 'https://finnhub.io/api/v1';
const TIMEOUT_MS = 8000;

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'BiasEngine-FairValue/2.0',
        'Accept': 'application/json',
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(new Error('timeout')); });
  });
}

// Lidská hláška podle HTTP statusu / těla
function errorMessage(status, body) {
  const b = (body || '').toLowerCase();
  if (status === 401) return 'Finnhub: API klíč je neplatný (401)';
  if (status === 403) {
    if (b.includes('access') || b.includes('subscription')) return 'Finnhub: endpoint není dostupný v tvém plánu (403)';
    return 'Finnhub: přístup odmítnut (403)';
  }
  if (status === 429) return 'Finnhub: vyčerpán rate limit 60/min (429)';
  if (status === 404) return 'Finnhub: ticker nebo endpoint neexistuje (404)';
  if (status >= 500)  return `Finnhub: server error (${status})`;
  return `Finnhub: HTTP ${status}`;
}

async function fhFetch(path) {
  const key = process.env.FINNHUB_API_KEY || '';
  if (!key) {
    return { error: 'Chybí FINNHUB_API_KEY v env proměnných Netlify', status: 0 };
  }
  const sep = path.includes('?') ? '&' : '?';
  const url = `${BASE}${path}${sep}token=${encodeURIComponent(key)}`;
  try {
    const r = await httpsGet(url);
    if (r.statusCode < 200 || r.statusCode >= 300) {
      return { error: errorMessage(r.statusCode, r.body), status: r.statusCode, body: r.body.slice(0, 200) };
    }
    let data;
    try { data = JSON.parse(r.body); }
    catch (e) { return { error: 'Finnhub: invalid JSON', status: r.statusCode, body: r.body.slice(0, 200) }; }
    if (data && data.error) {
      return { error: `Finnhub: ${data.error}`, status: r.statusCode };
    }
    return { data, status: r.statusCode };
  } catch (e) {
    return { error: `Finnhub network: ${e.message}`, status: 0 };
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

// Quote: { c: current, d: change, dp: change%, h: high, l: low, o: open, pc: prev close, t: timestamp }
async function fetchQuote(symbol) {
  return await fhFetch(`/quote?symbol=${encodeURIComponent(symbol)}`);
}

// Metrics: { metric: { peTTM, psTTM, pbAnnual, epsInclExtraItemsTTM, ... }, series: {...} }
async function fetchMetrics(symbol) {
  return await fhFetch(`/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all`);
}

// Profile: { country, currency, exchange, ipo, marketCapitalization, name, ticker, finnhubIndustry, ... }
async function fetchProfile(symbol) {
  return await fhFetch(`/stock/profile2?symbol=${encodeURIComponent(symbol)}`);
}

// Health-check ping (jednorázové ověření, že klíč funguje)
async function healthCheck() {
  const r = await fetchProfile('AAPL');
  if (r.error) return { ok: false, error: r.error, status: r.status };
  if (!r.data || !r.data.ticker) return { ok: false, error: 'Empty response', status: r.status };
  return { ok: true, sample: { ticker: r.data.ticker, name: r.data.name, exchange: r.data.exchange } };
}

module.exports = { fetchQuote, fetchMetrics, fetchProfile, healthCheck };
