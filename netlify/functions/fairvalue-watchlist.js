// ─────────────────────────────────────────────────────────────────────────────
// Watchlist endpoint — 77 tickerů, dávkové zpracování přes SEC + price
// ─────────────────────────────────────────────────────────────────────────────
//   GET /.netlify/functions/fairvalue-watchlist
//   GET /.netlify/functions/fairvalue-watchlist?refresh=1            (vše vyhodit)
//   GET /.netlify/functions/fairvalue-watchlist?refreshPrice=1       (jen ceny)
//   GET /.netlify/functions/fairvalue-watchlist?tickers=AAPL,MSFT
//
// Strategie:
//   - Per-ticker error isolation
//   - Concurrency: SEC max 3 paralelně, ceny max 5 paralelně (queue.js)
//   - Žádné dávky CHUNK_DELAY — fronty řídí rate-limiting samy
//   - SEC fund cache 7 dní → druhý refresh během dne nedělá další SEC volání
//   - Krypto/non-US: SEC vrátí "not in EDGAR" a my použijeme jen price
// ─────────────────────────────────────────────────────────────────────────────

const { calculateOne } = require('./fairvalue');
const sec   = require('./lib/sec-edgar');
const price = require('./lib/price');
const cache = require('./lib/cache');
const { QUEUES } = require('./lib/queue');

const WATCHLIST = [
  'CNSW','CNC','ADSK','BX','S','MU','VRSN','ASML','SMCI','HIMS',
  'PYPL','INTC','PLTR','MSFT','JD','ADBE','UBER','ZM','MELI','CRM',
  'GOOG','TME','NFLX','V','NVDA','PDD','AAPL','OXY','NXT','AMZN',
  'TSLA','TAN','META','BAC','BIDU','TTD','PGEN','TLN','FICO','LULU',
  'WIX','HTHT','ANF','PEP','SHW','RACE','SBUX','ABNB','PHM','IPCO',
  'PINS','ALGN','TOL','TSSI','AMR','CSU','BKNG','BA','DELL','BRK.B',
  'DUOL','NOW','GME','BABA','IBKR','AMD','DIS','NKE','ON','ROKU',
  'SIRI','TDOC','UAA','BYDDY','DSY','BTCUSD','ETHUSD',
];

exports.handler = async function(event) {
  const qs = (event && event.queryStringParameters) || {};
  const skipCache = qs.refresh === '1' || qs.skipCache === '1';
  const refreshFund = qs.refresh === '1' || qs.refreshFund === '1';
  // refreshPrice (--prices only): vyhodíme jen price cache, fund cache zůstane
  const refreshPriceOnly = qs.refreshPrice === '1';

  const tickers = qs.tickers
    ? qs.tickers.split(',').map(t => t.trim().toUpperCase()).filter(Boolean)
    : WATCHLIST;

  const t0 = Date.now();

  // ── Refresh-only-price: vyhodit price cache, ne fund ────────────────────
  if (refreshPriceOnly) {
    for (const t of tickers) cache.set(`price:${t}`, null, 1);
  }
  if (refreshFund) {
    for (const t of tickers) {
      cache.set(`sec:fund:${t}`, null, 1);
      cache.set(`fv:${t}`, null, 1);
    }
  }
  if (skipCache) {
    for (const t of tickers) {
      cache.set(`price:${t}`, null, 1);
      cache.set(`fv:${t}`, null, 1);
    }
  }

  // ── Health snapshot (cached 10 min) ─────────────────────────────────────
  let health = cache.get('health:bundle');
  if (!health || skipCache) {
    const [s, p] = await Promise.all([sec.healthCheck(), price.healthCheck()]);
    health = { sec: s, price: p, time: new Date().toISOString() };
    cache.set('health:bundle', health, cache.TTL.health);
  }

  // ── Per-ticker zpracování (paralelně, queue řídí rate) ──────────────────
  // calculateOne sám vede SEC a price přes QUEUES, takže můžeme střelit
  // všech 77 najednou a nedostaneme 429.
  const opts = {
    skipCache: refreshPriceOnly || skipCache,
    refreshFund: refreshFund,
  };

  const settle = await Promise.allSettled(
    tickers.map(sym => calculateOne(sym, opts))
  );

  const results = {};
  const order = [];
  for (let i = 0; i < tickers.length; i++) {
    const sym = tickers[i];
    const s = settle[i];
    if (s.status === 'fulfilled') {
      results[sym] = s.value;
    } else {
      results[sym] = {
        symbol: sym,
        type: 'error',
        price: null,
        fairValue: null,
        upsidePct: null,
        status: 'N/A',
        confidence: 'N/A',
        method: null,
        explanation: `Chyba: ${s.reason?.message || s.reason}`,
        dataSource: null,
        fetchedAt: new Date().toISOString(),
        debug: [],
      };
    }
    order.push(sym);
  }

  // ── Statistika ──────────────────────────────────────────────────────────
  const stats = { undervalued: 0, fair: 0, overvalued: 0, na: 0, total: tickers.length };
  const sourceCounts = { sec: 0, finnhub: 0, none: 0 };
  for (const r of Object.values(results)) {
    if (r.status === 'UNDERVALUED')      stats.undervalued++;
    else if (r.status === 'OVERVALUED')  stats.overvalued++;
    else if (r.status === 'FAIR')        stats.fair++;
    else                                  stats.na++;
    const src = r.normalized?.sources?.fundamentals || 'none';
    sourceCounts[src] = (sourceCounts[src] || 0) + 1;
  }

  const ms = Date.now() - t0;

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=600',  // 10 min CDN cache
    },
    body: JSON.stringify({
      results,
      order,
      stats,
      sourceCounts,
      health,
      tickers,
      cache: cache.stats(),
      queues: {
        sec: QUEUES.sec.stats(),
        price: QUEUES.price.stats(),
      },
      ms,
      fetched_at: new Date().toISOString(),
    }),
  };
};

exports.WATCHLIST = WATCHLIST;
