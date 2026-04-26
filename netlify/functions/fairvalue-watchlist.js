// ─────────────────────────────────────────────────────────────────────────────
// Watchlist endpoint — 77 tickerů, dávkové zpracování
// ─────────────────────────────────────────────────────────────────────────────
//   GET /.netlify/functions/fairvalue-watchlist
//   GET /.netlify/functions/fairvalue-watchlist?refresh=1
//
// Per-ticker error isolation: jeden krach neshazuje celou tabulku.
// Chunk po 5 paralelně (Finnhub free tier 60/min, watchlist potřebuje cca
// 4 calls/ticker × 77 = 308 calls — překročilo by minutový limit, proto
// využíváme cache fundamentů na 12 h).
// ─────────────────────────────────────────────────────────────────────────────

const { calculateOne } = require('./fairvalue');
const finnhub = require('./lib/finnhub');
const cache = require('./lib/cache');

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

const CHUNK_SIZE = 5;
const CHUNK_DELAY_MS = 1100;  // pauza mezi dávkami → respekt Finnhub 60/min

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function processChunk(symbols, opts) {
  return Promise.all(symbols.map(async sym => {
    try {
      const r = await calculateOne(sym, opts);
      return [sym, r];
    } catch (e) {
      return [sym, {
        symbol: sym,
        type: 'error',
        price: null,
        fairValue: null,
        upsidePct: null,
        status: 'N/A',
        confidence: 'N/A',
        method: null,
        explanation: `Chyba: ${e.message}`,
        debug: [],
      }];
    }
  }));
}

exports.handler = async function(event) {
  const qs = (event && event.queryStringParameters) || {};
  const skipCache = qs.refresh === '1' || qs.skipCache === '1';
  const tickers = qs.tickers
    ? qs.tickers.split(',').map(t => t.trim().toUpperCase()).filter(Boolean)
    : WATCHLIST;

  const t0 = Date.now();

  // ── Health-check FMP/Finnhub na začátku ──────────────────────────────────
  let healthCached = cache.get('health:finnhub');
  if (!healthCached || skipCache) {
    healthCached = await finnhub.healthCheck();
    cache.set('health:finnhub', healthCached, cache.TTL.health);
  }

  // ── Per-chunk processing ─────────────────────────────────────────────────
  const results = {};
  const order = [];
  const opts = { skipCache };

  for (let i = 0; i < tickers.length; i += CHUNK_SIZE) {
    const chunk = tickers.slice(i, i + CHUNK_SIZE);
    const out = await processChunk(chunk, opts);
    for (const [sym, r] of out) {
      results[sym] = r;
      order.push(sym);
    }
    // Pauza mezi dávkami pokud nás čeká další
    if (i + CHUNK_SIZE < tickers.length) await sleep(CHUNK_DELAY_MS);
  }

  // ── Statistika ──────────────────────────────────────────────────────────
  const stats = { undervalued: 0, fair: 0, overvalued: 0, na: 0, total: tickers.length };
  for (const r of Object.values(results)) {
    if (r.status === 'UNDERVALUED')      stats.undervalued++;
    else if (r.status === 'OVERVALUED')  stats.overvalued++;
    else if (r.status === 'FAIR')        stats.fair++;
    else                                  stats.na++;
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
      health: healthCached,
      tickers,
      cache: cache.stats(),
      ms,
      fetched_at: new Date().toISOString(),
    }),
  };
};

exports.WATCHLIST = WATCHLIST;
