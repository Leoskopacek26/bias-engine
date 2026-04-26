// ─────────────────────────────────────────────────────────────────────────────
// Fair Value endpoint — single ticker
// ─────────────────────────────────────────────────────────────────────────────
//   GET /.netlify/functions/fairvalue?symbol=AAPL
//   GET /.netlify/functions/fairvalue?symbol=AAPL&debug=1
//
// Orchestrátor:
//   1) Cache lookup (12 h)
//   2) Paralelně: Finnhub.fetchQuote + fetchMetrics + fetchProfile + Yahoo.fetchPrice
//   3) Normalize → NormalizedFundamentals
//   4) fairvalue-calc.valueOne()
//   5) Cache uložit + vrátit JSON
//
// Tenký orchestrátor — žádná matematika, žádný HTTP klient (vše v lib/).
// ─────────────────────────────────────────────────────────────────────────────

const finnhub  = require('./lib/finnhub');
const yahoo    = require('./lib/yahoo');
const { normalize, isCryptoTicker } = require('./lib/normalize');
const calc     = require('./lib/fairvalue-calc');
const cache    = require('./lib/cache');

async function calculateOne(symbol, opts = {}) {
  const sym = (symbol || '').toUpperCase().trim();
  if (!sym) return { error: 'Empty symbol', status: 'N/A' };

  // ── Cache hit? ────────────────────────────────────────────────────────────
  const cacheKey = `fv:${sym}`;
  const cached = cache.get(cacheKey);
  if (cached && !opts.skipCache) {
    return { ...cached, cached: true };
  }

  const debug = [];
  const t0 = Date.now();

  // ── Crypto: jen cena, žádné Finnhub volání ───────────────────────────────
  if (isCryptoTicker(sym)) {
    const yahooSymbol = sym.includes('-') ? sym : sym.replace(/USDT?$/, '-USD');
    const yp = await yahoo.fetchPrice(yahooSymbol);
    debug.push(`crypto path → Yahoo ${yahooSymbol} ${yp.error ? '✗ ' + yp.error : '✓'}`);
    const normalized = normalize({
      symbol: sym,
      yahooData: yp.data,
      fhMetrics: null,
      fhProfile: null,
      fhQuote: null,
    });
    const result = calc.valueOne(normalized);
    result.debug = (result.debug || []).concat(debug);
    result.fetchMs = Date.now() - t0;
    cache.set(cacheKey, result, cache.TTL.fairvalue);
    return result;
  }

  // ── Stock / ETF: paralelní fetch ─────────────────────────────────────────
  const fundCacheKey = `fund:${sym}`;
  const priceCacheKey = `price:${sym}`;

  let fhQuote = null, fhMetrics = null, fhProfile = null, yahooData = null;
  let fhQuoteErr = null, fhMetricsErr = null, fhProfileErr = null, yahooErr = null;

  // Cena z cache?
  const cachedPrice = cache.get(priceCacheKey);
  // Fundamenty z cache?
  const cachedFund = cache.get(fundCacheKey);

  const fetches = [];
  if (cachedPrice) {
    fhQuote = cachedPrice.fhQuote;
    yahooData = cachedPrice.yahooData;
    debug.push('price: cache HIT');
  } else {
    fetches.push(
      finnhub.fetchQuote(sym).then(r => {
        if (r.error) { fhQuoteErr = r.error; debug.push(`finnhub.quote ✗ ${r.error}`); }
        else { fhQuote = r.data; debug.push(`finnhub.quote ✓ price=${r.data?.c}`); }
      }),
      yahoo.fetchPrice(sym).then(r => {
        if (r.error) { yahooErr = r.error; debug.push(`yahoo ✗ ${r.error}`); }
        else { yahooData = r.data; debug.push(`yahoo ✓ price=${r.data.price} type=${r.data.type}`); }
      }),
    );
  }
  if (cachedFund) {
    fhMetrics = cachedFund.fhMetrics;
    fhProfile = cachedFund.fhProfile;
    debug.push('fund: cache HIT');
  } else {
    fetches.push(
      finnhub.fetchMetrics(sym).then(r => {
        if (r.error) { fhMetricsErr = r.error; debug.push(`finnhub.metrics ✗ ${r.error}`); }
        else { fhMetrics = r.data?.metric || null; debug.push(`finnhub.metrics ✓ keys=${fhMetrics ? Object.keys(fhMetrics).length : 0}`); }
      }),
      finnhub.fetchProfile(sym).then(r => {
        if (r.error) { fhProfileErr = r.error; debug.push(`finnhub.profile ✗ ${r.error}`); }
        else { fhProfile = r.data; debug.push(`finnhub.profile ✓ ${r.data?.name || '(no name)'}`); }
      }),
    );
  }
  await Promise.all(fetches);

  // ── Cache update (price 5 min, fund 12 h) ────────────────────────────────
  if (!cachedPrice && (fhQuote || yahooData)) {
    cache.set(priceCacheKey, { fhQuote, yahooData }, cache.TTL.price);
  }
  if (!cachedFund && (fhMetrics || fhProfile)) {
    cache.set(fundCacheKey, { fhMetrics, fhProfile }, cache.TTL.fund);
  }

  // ── Normalizace ─────────────────────────────────────────────────────────
  const normalized = normalize({ symbol: sym, yahooData, fhMetrics, fhProfile, fhQuote });
  debug.push(`normalize: type=${normalized.type} price=${normalized.price} epsTtm=${normalized.epsTtm} growth=${normalized.epsGrowth ?? normalized.revenueGrowth}`);

  // ── Žádná data → smysluplná chyba, ne fake hodnota ──────────────────────
  if (!normalized.price) {
    const result = {
      symbol: sym,
      type: normalized.type,
      price: null,
      fairValue: null,
      upsidePct: null,
      status: 'N/A',
      confidence: 'N/A',
      method: null,
      explanation: 'Cena nedostupná: ' + [fhQuoteErr, yahooErr].filter(Boolean).join(' | '),
      debug,
      errors: { fhQuote: fhQuoteErr, fhMetrics: fhMetricsErr, fhProfile: fhProfileErr, yahoo: yahooErr },
    };
    return result;
  }

  // ── Výpočet ─────────────────────────────────────────────────────────────
  const result = calc.valueOne(normalized);
  result.debug = (result.debug || []).concat(debug);
  result.fetchMs = Date.now() - t0;
  result.errors = {
    fhQuote: fhQuoteErr, fhMetrics: fhMetricsErr, fhProfile: fhProfileErr, yahoo: yahooErr,
  };
  // Surová normalizovaná data ať uživatel vidí čím počítáme
  result.normalized = normalized;

  cache.set(cacheKey, result, cache.TTL.fairvalue);
  return result;
}

// ── Handler ─────────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  const qs = (event && event.queryStringParameters) || {};
  const symbol = (qs.symbol || qs.ticker || '').trim();
  const skipCache = qs.refresh === '1' || qs.skipCache === '1';
  const wantHealth = qs.health === '1';

  // Zdravotní endpoint
  if (wantHealth) {
    const h = await finnhub.healthCheck();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        finnhub: h,
        cache: cache.stats(),
        envFinnhub: !!process.env.FINNHUB_API_KEY,
        time: new Date().toISOString(),
      }),
    };
  }

  if (!symbol) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Missing ?symbol=AAPL' }),
    };
  }

  try {
    const result = await calculateOne(symbol, { skipCache });
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300',  // 5 min CDN cache
      },
      body: JSON.stringify(result),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: e.message, stack: e.stack }),
    };
  }
};

// Export pro watchlist endpoint
exports.calculateOne = calculateOne;
