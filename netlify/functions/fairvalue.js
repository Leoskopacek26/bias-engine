// ─────────────────────────────────────────────────────────────────────────────
// Fair Value endpoint — single ticker
// ─────────────────────────────────────────────────────────────────────────────
//   GET /.netlify/functions/fairvalue?symbol=AAPL
//   GET /.netlify/functions/fairvalue?symbol=AAPL&debug=1
//   GET /.netlify/functions/fairvalue?symbol=AAPL&refresh=1   (vyhodí cache)
//   GET /.netlify/functions/fairvalue?symbol=AAPL&refreshFund=1 (jen fund cache)
//   GET /.netlify/functions/fairvalue?health=1
//
// Architektura:
//   1) Cache lookup (12 h výsledek)
//   2) Price: Yahoo → Stooq fallback
//   3) Fundamentals: SEC EDGAR (Company Facts XBRL) — 7-day cache
//   4) Optional: Finnhub fallback pokud FINNHUB_API_KEY a SEC selhal
//   5) Normalize → calc.valueOne()
//
// Aplikace funguje i bez Finnhub klíče.
// ─────────────────────────────────────────────────────────────────────────────

const sec    = require('./lib/sec-edgar');
const price  = require('./lib/price');
const finnhub = require('./lib/finnhub');
const { normalize, isCryptoTicker } = require('./lib/normalize');
const calc   = require('./lib/fairvalue-calc');
const cache  = require('./lib/cache');
const { QUEUES } = require('./lib/queue');

// Pro každý ticker ulož prosperity-friendly výsledek do cache
async function calculateOne(symbol, opts = {}) {
  const sym = (symbol || '').toUpperCase().trim();
  if (!sym) return { error: 'Empty symbol', status: 'N/A' };

  const cacheKey = `fv:${sym}`;
  if (!opts.skipCache && !opts.refreshFund) {
    const cached = cache.get(cacheKey);
    if (cached) return { ...cached, cached: true };
  }

  const debug = [];
  const t0 = Date.now();

  // ── Crypto: jen cena, žádné SEC volání ───────────────────────────────────
  if (isCryptoTicker(sym)) {
    const yahooSym = sym.includes('-') ? sym : sym.replace(/USDT?$/, '-USD');
    const pr = await price.fetchPrice(yahooSym, { skipCache: opts.skipCache });
    debug.push(`crypto path → price ${pr.error ? '✗ ' + pr.error : '✓ ' + pr.data.source}`);
    const normalized = normalize({
      symbol: sym,
      priceData: pr.data || null,
      secData: null,
      fhMetrics: null,
      fhProfile: null,
    });
    const result = calc.valueOne(normalized);
    result.debug = (result.debug || []).concat(debug);
    result.normalized = normalized;
    result.fetchMs = Date.now() - t0;
    result.fetchedAt = new Date().toISOString();
    result.dataSource = pr.data?.source || null;
    cache.set(cacheKey, result, cache.TTL.fairvalue);
    return result;
  }

  // ── Stock / ETF: paralelní fetch (price + SEC) ───────────────────────────
  // SEC fundamenty cachujeme zvlášť na 7 dní → refreshFund=1 vyhodí
  const fundCacheKey = `sec:fund:${sym}`;
  if (opts.refreshFund) cache.set(fundCacheKey, null, 1);

  let priceData = null, secFund = null, fhMetrics = null, fhProfile = null;
  let priceErr = null, secErr = null, fhErr = null;

  // Paralelní fetch
  const tasks = [];

  // 1) Cena (vždy fresh nebo z cache 5 min)
  tasks.push(
    price.fetchPrice(sym, { skipCache: opts.skipCache }).then(r => {
      if (r.error) { priceErr = r.error; debug.push(`price ✗ ${r.error}`); }
      else { priceData = r.data; debug.push(`price ✓ ${r.data.source} $${r.data.price}`); }
    })
  );

  // 2) SEC fundamenty (cache 7 dní)
  const cachedFund = cache.get(fundCacheKey);
  if (cachedFund && !opts.refreshFund) {
    secFund = cachedFund;
    debug.push(`sec: cache HIT (asOf=${cachedFund.asOfDate})`);
  } else {
    tasks.push(
      QUEUES.sec.run(() => sec.fetchFundamentals(sym)).then(r => {
        if (r.error) { secErr = r.error; debug.push(`sec ✗ ${r.error}`); }
        else {
          secFund = r.data;
          cache.set(fundCacheKey, secFund, cache.TTL.fund);
          debug.push(`sec ✓ EPS=${secFund.epsTtm} rev=${secFund.revenue} asOf=${secFund.asOfDate}`);
        }
      })
    );
  }

  await Promise.all(tasks);

  // ── Optional Finnhub fallback (jen pokud SEC selhal A klíč existuje) ────
  if (!secFund && process.env.FINNHUB_API_KEY) {
    debug.push('finnhub fallback → triggered');
    try {
      const [mr, pr] = await Promise.all([
        QUEUES.finnhub.run(() => finnhub.fetchMetrics(sym)),
        QUEUES.finnhub.run(() => finnhub.fetchProfile(sym)),
      ]);
      if (mr.error) { fhErr = mr.error; debug.push(`finnhub.metrics ✗ ${mr.error}`); }
      else { fhMetrics = mr.data?.metric || null; debug.push(`finnhub.metrics ✓`); }
      if (pr.error) debug.push(`finnhub.profile ✗ ${pr.error}`);
      else { fhProfile = pr.data; debug.push(`finnhub.profile ✓`); }
    } catch (e) {
      fhErr = e.message;
      debug.push(`finnhub fallback throw: ${e.message}`);
    }
  }

  // ── Validace: bez ceny nemá smysl počítat ────────────────────────────────
  if (!priceData?.price) {
    const result = {
      symbol: sym,
      type: 'unknown',
      price: null,
      fairValue: null,
      upsidePct: null,
      status: 'N/A',
      confidence: 'N/A',
      method: null,
      explanation: 'Cena nedostupná: ' + [priceErr].filter(Boolean).join(' | '),
      dataSource: null,
      fetchedAt: new Date().toISOString(),
      debug,
      errors: { price: priceErr, sec: secErr, finnhub: fhErr },
    };
    return result;
  }

  // ── Normalizace ─────────────────────────────────────────────────────────
  const normalized = normalize({
    symbol: sym,
    priceData,
    secData: secFund,
    fhMetrics,
    fhProfile,
  });
  debug.push(`normalize: type=${normalized.type} price=${normalized.price} EPS=${normalized.epsTtm} g=${normalized.epsGrowth ?? normalized.revenueGrowth} src=${normalized.sources.fundamentals || 'none'}`);

  // ── Výpočet ─────────────────────────────────────────────────────────────
  const result = calc.valueOne(normalized);
  result.debug = (result.debug || []).concat(debug);
  result.normalized = normalized;
  result.fetchMs = Date.now() - t0;
  result.fetchedAt = new Date().toISOString();
  result.dataSource = normalized.sources.fundamentals || normalized.sources.price;
  result.errors = { price: priceErr, sec: secErr, finnhub: fhErr };

  cache.set(cacheKey, result, cache.TTL.fairvalue);
  return result;
}

// ── Handler ─────────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  const qs = (event && event.queryStringParameters) || {};
  const symbol = (qs.symbol || qs.ticker || '').trim();
  const skipCache = qs.refresh === '1' || qs.skipCache === '1';
  const refreshFund = qs.refreshFund === '1';
  const wantHealth = qs.health === '1';

  // Health endpoint
  if (wantHealth) {
    const [secH, priceH] = await Promise.all([
      sec.healthCheck(),
      price.healthCheck(),
    ]);
    let finnhubH = { ok: false, reason: 'no API key' };
    if (process.env.FINNHUB_API_KEY) {
      finnhubH = await finnhub.healthCheck();
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        sec: secH,
        price: priceH,
        finnhub: finnhubH,
        cache: cache.stats(),
        queues: {
          sec: QUEUES.sec.stats(),
          price: QUEUES.price.stats(),
          finnhub: QUEUES.finnhub.stats(),
        },
        envFinnhub: !!process.env.FINNHUB_API_KEY,
        envSecUserAgent: !!process.env.SEC_USER_AGENT,
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
    const result = await calculateOne(symbol, { skipCache, refreshFund });
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300',
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

exports.calculateOne = calculateOne;
