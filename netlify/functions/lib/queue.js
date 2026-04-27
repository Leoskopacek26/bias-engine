// ─────────────────────────────────────────────────────────────────────────────
// Request queue — limit concurrency + exponential backoff on 429/503
// ─────────────────────────────────────────────────────────────────────────────
// Použití:
//   const q = createQueue({ concurrency: 2, retries: 3 });
//   const result = await q.run(() => httpsGet(url));
//
// Důvod existence:
//   - SEC EDGAR má 10 req/sec limit
//   - Yahoo Finance bývá rate-limited při burst > 10 req/sec
//   - Finnhub free 60/min
//   - Když paralelně střelíme 77 tickerů × 2 zdroje, dostaneme 429
//
// Retry strategie:
//   - Status 429 nebo 503 nebo network error → wait + retry
//   - Backoff: 500 ms, 1500 ms, 3500 ms (~ 2^n × 500 ms + jitter)
//   - Max retries default 3
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Detekce, zda volat retry
function isRetriable(result, err) {
  if (err) {
    const m = String(err.message || err).toLowerCase();
    if (m.includes('timeout') || m.includes('etimedout')
        || m.includes('econnreset') || m.includes('enotfound')
        || m.includes('socket hang up')) return true;
    return false;
  }
  if (result && (result.status === 429 || result.status === 503)) return true;
  if (result && result.statusCode && (result.statusCode === 429 || result.statusCode === 503)) return true;
  return false;
}

function backoffMs(attempt) {
  // 0 → 500, 1 → 1500, 2 → 3500, 3 → 7500
  const base = Math.pow(2, attempt) * 500;
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
}

function createQueue({ concurrency = 2, retries = 3 } = {}) {
  let active = 0;
  const waiters = [];

  async function acquire() {
    if (active < concurrency) {
      active++;
      return;
    }
    await new Promise(resolve => waiters.push(resolve));
    active++;
  }

  function release() {
    active--;
    const next = waiters.shift();
    if (next) next();
  }

  async function run(fn) {
    await acquire();
    try {
      let lastResult = null;
      let lastErr = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const r = await fn();
          if (!isRetriable(r, null)) return r;
          lastResult = r;
        } catch (e) {
          lastErr = e;
          if (!isRetriable(null, e)) throw e;
        }
        if (attempt < retries) await sleep(backoffMs(attempt));
      }
      // Po vyčerpání retries vrátíme poslední výsledek nebo throw
      if (lastErr) throw lastErr;
      return lastResult;
    } finally {
      release();
    }
  }

  function stats() {
    return { active, queued: waiters.length, concurrency, retries };
  }

  return { run, stats };
}

// Globální sdílené fronty pro různé zdroje (sdílí se napříč voláními
// dokud je Lambda warm)
const QUEUES = {
  sec:     createQueue({ concurrency: 3, retries: 3 }),
  price:   createQueue({ concurrency: 5, retries: 2 }),
  finnhub: createQueue({ concurrency: 2, retries: 2 }),
};

module.exports = {
  createQueue,
  QUEUES,
  sleep,
  isRetriable,
  backoffMs,
};
