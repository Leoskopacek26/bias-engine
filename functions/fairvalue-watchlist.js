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
  try {
    return await handleRequest(event);
  } catch (e) {
    // Vrátíme JSON error místo Netlify 502, aby frontend viděl detail
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        error: e.message,
        stack: e.stack?.split('\n').slice(0, 6),
        time: new Date().toISOString(),
      }),
    };
  }
};

async function handleRequest(event) {
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
  // POZN: skipCache (refresh=1) NESPOUŠTÍ healthCheck znovu — healthCheck dělá
  // 2 SEC requesty + Yahoo, což při cold-startu sní 3-5 s z 10 s budgetu.
  // Health beztak hlídáme v pozadí; pokud cache prázdná, vrátíme placeholder
  // a healthCheck spustíme až po ticker zpracování (mimo critical path).
  let health = cache.get('health:bundle');
  if (!health) {
    health = { sec: { ok: null, pending: true }, price: { ok: null, pending: true }, time: new Date().toISOString() };
  }

  // ── Per-ticker zpracování (paralelně, queue řídí rate) ──────────────────
  // calculateOne sám vede SEC a price přes QUEUES, takže můžeme střelit
  // všech 77 najednou a nedostaneme 429.
  const opts = {
    skipCache: refreshPriceOnly || skipCache,
    refreshFund: refreshFund,
  };

  // Per-ticker timeout aby jeden zaseknutý ticker neshodil celou dávku
  // (Netlify má 10 s sync limit; rezerva 3 s na response serializaci + cold start
  // overhead. Při chunk size 6 a SEC concurrency 6 by všech 6 mělo běžet paralelně,
  // takže timeout = max-latency-per-ticker, ne celá fronta.)
  const TICKER_TIMEOUT_MS = 6500;
  function withTimeout(p, ms, sym) {
    return Promise.race([
      p,
      new Promise((_, rej) => setTimeout(
        () => rej(new Error(`Timeout ${ms}ms (${sym})`)), ms
      )),
    ]);
  }

  const settle = await Promise.allSettled(
    tickers.map(sym => withTimeout(calculateOne(sym, opts), TICKER_TIMEOUT_MS, sym))
  );

  // Fire-and-forget health refresh (mimo critical path)
  if (health.sec?.pending && tickers.length <= 15) {
    Promise.all([sec.healthCheck(), price.healthCheck()])
      .then(([s, p]) => cache.set('health:bundle',
        { sec: s, price: p, time: new Date().toISOString() }, cache.TTL.health))
      .catch(() => {});
  }

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
