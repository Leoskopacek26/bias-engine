// ─────────────────────────────────────────────────────────────────────────────
// Price aggregator — Yahoo Finance (primary) + Stooq CSV (fallback)
// ─────────────────────────────────────────────────────────────────────────────
// Sjednocený fetchPrice(symbol) → { price, currency, type, source, ... }
// Bez API klíče. Použito pro stocks, ETFs i crypto.
//
//   Yahoo:  /v8/finance/chart/{symbol} (vrací JSON, vč. typu instrumentu)
//   Stooq:  /q/d/l/?s={symbol}&i=d (vrací CSV, last close)
//
// Vše prochází přes lib/queue (max 5 paralelních + retry on 429/503).
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');
const cache = require('./cache');
const { QUEUES } = require('./queue');

const TIMEOUT_MS = 7000;

// ── HTTP klient ────────────────────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BiasEngine/2.0)',
        'Accept': 'application/json, text/csv, */*',
      },
    }, res => {
      // Redirect podpora
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data, status: res.statusCode }));
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(new Error('timeout')); });
  });
}

// ── Yahoo Finance v8 chart ─────────────────────────────────────────────────
async function fetchYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
  const r = await QUEUES.price.run(() => httpsGet(url));
  if (!r || r.statusCode < 200 || r.statusCode >= 300) {
    return { error: `Yahoo HTTP ${r?.statusCode}`, status: r?.statusCode };
  }
  let data;
  try { data = JSON.parse(r.body); }
  catch (e) { return { error: 'Yahoo invalid JSON' }; }

  const result = data?.chart?.result?.[0];
  if (!result) return { error: data?.chart?.error?.description || 'Yahoo: žádný výsledek' };

  const meta = result.meta;
  if (!meta) return { error: 'Yahoo: chybí meta' };

  const price = meta.regularMarketPrice ?? meta.previousClose ?? null;
  if (!price || price <= 0) return { error: 'Yahoo: neplatná cena' };

  const instrumentType = meta.instrumentType || 'EQUITY';
  return {
    data: {
      symbol,
      price,
      currency: meta.currency || null,
      exchange: meta.exchangeName || null,
      instrumentType,
      type: classifyType(instrumentType),
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? null,
      previousClose: meta.previousClose ?? null,
      source: 'yahoo',
    },
  };
}

function classifyType(instrumentType) {
  switch ((instrumentType || '').toUpperCase()) {
    case 'EQUITY':         return 'stock';
    case 'ETF':            return 'etf';
    case 'MUTUALFUND':     return 'etf';
    case 'CRYPTOCURRENCY': return 'crypto';
    case 'CURRENCY':       return 'fx';
    case 'FUTURE':         return 'future';
    case 'INDEX':          return 'index';
    default:               return 'unknown';
  }
}

// ── Stooq CSV fallback ─────────────────────────────────────────────────────
// AAPL → aapl.us; BTC → btcusd; EURUSD → eurusd
function stooqSymbol(symbol) {
  const s = (symbol || '').toLowerCase().replace(/\./g, '-');
  if (/^(btc|eth|sol|ada|doge|dot|xrp|matic|avax|link)usd[t]?$/.test(s)) {
    return s.replace(/usdt$/, 'usd');
  }
  if (/[a-z]{3,4}usd$/.test(s) && s.length <= 8) return s; // fx
  // Default US stock
  return `${s}.us`;
}

async function fetchStooq(symbol) {
  const sym = stooqSymbol(symbol);
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(sym)}&i=d`;
  const r = await QUEUES.price.run(() => httpsGet(url));
  if (!r || r.statusCode < 200 || r.statusCode >= 300) {
    return { error: `Stooq HTTP ${r?.statusCode}`, status: r?.statusCode };
  }
  // CSV: Date,Open,High,Low,Close,Volume
  const lines = r.body.trim().split(/\r?\n/);
  if (lines.length < 2) return { error: 'Stooq: prázdný CSV' };
  const header = lines[0].toLowerCase();
  if (!header.includes('close')) return { error: 'Stooq: chybí close column' };
  const last = lines[lines.length - 1].split(',');
  if (last.length < 5) return { error: 'Stooq: malformed row' };
  const close = parseFloat(last[4]);
  if (!Number.isFinite(close) || close <= 0) return { error: 'Stooq: neplatná cena' };
  return {
    data: {
      symbol,
      price: close,
      currency: 'USD',  // Stooq US default
      exchange: null,
      instrumentType: null,
      type: 'unknown',
      fiftyTwoWeekHigh: null,
      fiftyTwoWeekLow: null,
      previousClose: null,
      source: 'stooq',
      asOf: last[0] || null,
    },
  };
}

// ── Public: jediný entry point ─────────────────────────────────────────────
async function fetchPrice(symbol, opts = {}) {
  const sym = (symbol || '').trim();
  if (!sym) return { error: 'Empty symbol' };

  const cacheKey = `price:${sym.toUpperCase()}`;
  if (!opts.skipCache) {
    const cached = cache.get(cacheKey);
    if (cached) return { data: { ...cached, _cached: true } };
  }

  // 1) Yahoo
  let attempt = await fetchYahoo(sym);
  if (attempt.data) {
    cache.set(cacheKey, attempt.data, cache.TTL.price);
    return attempt;
  }
  const yahooErr = attempt.error;

  // 2) Stooq fallback (jen pro US stocks / crypto / FX)
  attempt = await fetchStooq(sym);
  if (attempt.data) {
    cache.set(cacheKey, attempt.data, cache.TTL.price);
    return attempt;
  }
  const stooqErr = attempt.error;

  return { error: `Yahoo: ${yahooErr} | Stooq: ${stooqErr}` };
}

async function healthCheck() {
  const r = await fetchYahoo('AAPL');
  return {
    ok: !!r.data,
    sample: r.data ? { symbol: 'AAPL', price: r.data.price, source: r.data.source } : null,
    error: r.error || null,
  };
}

module.exports = { fetchPrice, fetchYahoo, fetchStooq, healthCheck };
