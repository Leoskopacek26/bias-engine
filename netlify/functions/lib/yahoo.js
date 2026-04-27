// ─────────────────────────────────────────────────────────────────────────────
// Yahoo Finance — POUZE cenový fallback, žádná valuace.
// Bez klíče. Endpoint: /v8/finance/chart/{symbol}
// Vrací { price, currency, instrumentType, exchange, fiftyTwoWeekHigh, fiftyTwoWeekLow }
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');

const TIMEOUT_MS = 6000;

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BiasEngine/2.0)',
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

async function fetchPrice(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
  try {
    const r = await httpsGet(url);
    if (r.statusCode < 200 || r.statusCode >= 300) {
      return { error: `Yahoo HTTP ${r.statusCode}`, status: r.statusCode };
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

    const instrumentType = meta.instrumentType || 'EQUITY';  // EQUITY | ETF | CRYPTOCURRENCY | FUTURE | INDEX
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
      },
    };
  } catch (e) {
    return { error: `Yahoo network: ${e.message}` };
  }
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

module.exports = { fetchPrice };
