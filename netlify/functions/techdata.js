// Netlify Function: technická analýza v4 — multi-source intraday
// ─────────────────────────────────────────────────────────────────────────────
// ZDROJE DAT:
//   • Binance public API     → BTCUSD, ETHUSD (všechny TF, bez klíče, neomezené)
//   • TwelveData             → FX páry, XAU/USD, XAG/USD (s API klíčem, free tier)
//   • Frankfurter ECB        → fallback pro FX/metals když TwelveData klíč chybí
//                              (synthetic intraday: stejná denní data, různá EMA okna)
//
// INDIKÁTORY:
//   • EMA20, EMA50           → trend a stack alignment
//   • RSI14                  → momentum + overbought/oversold filtr
//   • MACD(12,26,9)          → cross signály a histogram
//   • Trend posledních 5     → krátkodobé momentum
//
// VYHODNOCENÍ:
//   Confluence-based scoring v rozsahu cca [-1.0, +1.0], threshold ±0.25.
//   BULLISH = score ≥ +0.25, BEARISH = score ≤ -0.25, jinak NEUTRAL.
//
// DEBUG: kompletní log každého instrument×TF jde do Netlify function logs.
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');

// ── HTTP helpers ─────────────────────────────────────────────────────────────
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BiasEngine/4.0)',
        'Accept': 'application/json,text/plain,*/*',
        ...headers,
      },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location, headers).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(new Error('timeout')); });
  });
}

async function fetchJson(url, headers) {
  try {
    const r = await httpsGet(url, headers);
    if (r.statusCode >= 200 && r.statusCode < 300) {
      try { return JSON.parse(r.body); } catch (e) { return null; }
    }
    return null;
  } catch (e) { return null; }
}

// ── Indikátory ───────────────────────────────────────────────────────────────
function emaSeries(prices, period) {
  if (!prices || prices.length < period) return null;
  const k = 2 / (period + 1);
  const out = new Array(prices.length).fill(null);
  let e = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = e;
  for (let i = period; i < prices.length; i++) {
    e = prices[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

function calcEMA(prices, period) {
  const s = emaSeries(prices, period);
  return s ? s[s.length - 1] : null;
}

function calcRSI(prices, period = 14) {
  if (!prices || prices.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const rs = gains / (losses || 1e-10);
  return Math.round(100 - 100 / (1 + rs));
}

function calcMACD(prices, fast = 12, slow = 26, signalP = 9) {
  if (!prices || prices.length < slow + signalP) return null;
  const fastSeries = emaSeries(prices, fast);
  const slowSeries = emaSeries(prices, slow);
  if (!fastSeries || !slowSeries) return null;
  // MACD line = fast EMA - slow EMA, jen kde existuje slow
  const macdLine = [];
  for (let i = slow - 1; i < prices.length; i++) {
    macdLine.push(fastSeries[i] - slowSeries[i]);
  }
  if (macdLine.length < signalP + 1) return null;
  const signalSeries = emaSeries(macdLine, signalP);
  if (!signalSeries) return null;
  const lastMacd   = macdLine[macdLine.length - 1];
  const lastSignal = signalSeries[signalSeries.length - 1];
  const prevMacd   = macdLine[macdLine.length - 2];
  const prevSignal = signalSeries[signalSeries.length - 2];
  const histogram  = lastMacd - lastSignal;
  return {
    macd: lastMacd,
    signal: lastSignal,
    histogram,
    crossUp:   prevMacd <= prevSignal && lastMacd > lastSignal,
    crossDown: prevMacd >= prevSignal && lastMacd < lastSignal,
    bullish:   lastMacd > lastSignal && histogram > 0,
    bearish:   lastMacd < lastSignal && histogram < 0,
  };
}

// ── Bias evaluator s confluence skóre ────────────────────────────────────────
// Vrací {bias, score, reason, indikátory}. Loguje do `debug` pole.
function evaluateBias(closes, sym, tf, debug) {
  const n = closes ? closes.length : 0;
  if (!closes || n < 28) {
    debug.push(`[${sym} ${tf}] candles=${n} → NEUTRAL (nedostatek dat — minimum 28 svíček)`);
    return { bias: 'Neutral', reason: `nedostatek dat (${n} svíček)`, score: 0,
             ema20: null, ema50: null, rsi: null, macd: null, trend: 0, candles: n };
  }
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, Math.min(50, n - 1));
  const rsi   = calcRSI(closes, 14);
  const macd  = calcMACD(closes);
  const last  = closes[n - 1];
  const prev5 = closes[n - 6] || closes[Math.max(0, n - 6)];
  const trend = ((last - prev5) / prev5) * 100;

  let score = 0;
  const reasons = [];

  // ── 1. EMA stack (max ±0.40) ──────────────────────────────────────────────
  if (ema20 != null && ema50 != null) {
    if (last > ema20 && last > ema50 && ema20 > ema50) {
      score += 0.40; reasons.push('cena>EMA20>EMA50 (full bull stack)');
    } else if (last < ema20 && last < ema50 && ema20 < ema50) {
      score -= 0.40; reasons.push('cena<EMA20<EMA50 (full bear stack)');
    } else if (ema20 > ema50) {
      score += 0.15; reasons.push('EMA20>EMA50 (částečný bull)');
    } else {
      score -= 0.15; reasons.push('EMA20<EMA50 (částečný bear)');
    }
  }

  // ── 2. RSI (max ±0.20, OB/OS slabý kontra-signál) ─────────────────────────
  if (rsi != null) {
    if      (rsi >= 75) { score -= 0.05; reasons.push(`RSI ${rsi} (OB → riziko korekce)`); }
    else if (rsi >= 60) { score += 0.20; reasons.push(`RSI ${rsi} (silně bull)`); }
    else if (rsi >  50) { score += 0.10; reasons.push(`RSI ${rsi} (bull)`); }
    else if (rsi == 50) { /* neutrální */ reasons.push(`RSI 50 (neutrální)`); }
    else if (rsi >  40) { score -= 0.10; reasons.push(`RSI ${rsi} (bear)`); }
    else if (rsi >  25) { score -= 0.20; reasons.push(`RSI ${rsi} (silně bear)`); }
    else                { score += 0.05; reasons.push(`RSI ${rsi} (OS → potenciál odrazu)`); }
  }

  // ── 3. MACD (max ±0.30) ───────────────────────────────────────────────────
  if (macd) {
    if      (macd.crossUp)   { score += 0.30; reasons.push('MACD cross↑ (bullish kříž)'); }
    else if (macd.crossDown) { score -= 0.30; reasons.push('MACD cross↓ (bearish kříž)'); }
    else if (macd.bullish)   { score += 0.15; reasons.push(`MACD bull (hist ${macd.histogram.toExponential(2)})`); }
    else if (macd.bearish)   { score -= 0.15; reasons.push(`MACD bear (hist ${macd.histogram.toExponential(2)})`); }
    else                     { reasons.push(`MACD plochý (hist ${macd.histogram.toExponential(2)})`); }
  }

  // ── 4. Recent trend (max ±0.20) ───────────────────────────────────────────
  if      (trend >  0.5) { score += 0.20; reasons.push(`trend +${trend.toFixed(2)}% (silný up)`); }
  else if (trend >  0.1) { score += 0.10; reasons.push(`trend +${trend.toFixed(2)}% (mírný up)`); }
  else if (trend < -0.5) { score -= 0.20; reasons.push(`trend ${trend.toFixed(2)}% (silný down)`); }
  else if (trend < -0.1) { score -= 0.10; reasons.push(`trend ${trend.toFixed(2)}% (mírný down)`); }
  else                   { reasons.push(`trend ${trend.toFixed(2)}% (flat)`); }

  // ── Verdict ───────────────────────────────────────────────────────────────
  let bias;
  if      (score >=  0.25) bias = 'Bullish';
  else if (score <= -0.25) bias = 'Bearish';
  else                     bias = 'Neutral';

  debug.push(
    `[${sym} ${tf}] candles=${n} EMA20=${ema20?.toFixed(5)} EMA50=${ema50?.toFixed(5)} ` +
    `RSI=${rsi} MACD_h=${macd ? macd.histogram.toExponential(2) : 'n/a'} ` +
    `trend=${trend.toFixed(2)}% score=${score.toFixed(2)} → ${bias.toUpperCase()} ` +
    `[${reasons.join('; ')}]`
  );

  return { bias, reason: reasons.join('; '), score, ema20, ema50, rsi, macd, trend, candles: n };
}

// ── BINANCE (krypto) ─────────────────────────────────────────────────────────
const BINANCE_INTERVALS = { '5m':'5m', '15m':'15m', '30m':'30m', '1h':'1h', '4h':'4h', '1D':'1d' };

async function fetchBinance(symbol, tf) {
  const interval = BINANCE_INTERVALS[tf];
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=200`;
  const data = await fetchJson(url);
  if (!Array.isArray(data)) return [];
  // [openTime, open, high, low, close, volume, ...]
  return data.map(k => parseFloat(k[4])).filter(v => !isNaN(v) && v > 0);
}

// ── TWELVEDATA (FX + metals) ─────────────────────────────────────────────────
const TWELVE_INTERVALS = { '5m':'5min', '15m':'15min', '30m':'30min', '1h':'1h', '4h':'4h', '1D':'1day' };

async function fetchTwelve(symbol, tf, apiKey) {
  if (!apiKey) return [];
  const interval = TWELVE_INTERVALS[tf];
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=200&apikey=${encodeURIComponent(apiKey)}&order=ASC`;
  const data = await fetchJson(url);
  if (!data || !data.values || !Array.isArray(data.values)) return [];
  return data.values.map(v => parseFloat(v.close)).filter(v => !isNaN(v) && v > 0);
}

// ── FRANKFURTER (ECB daily fallback) ─────────────────────────────────────────
let frankCache = null;
async function loadFrankfurter() {
  if (frankCache) return frankCache;
  const end = new Date(); end.setDate(end.getDate() - 1);
  while (end.getDay() === 0 || end.getDay() === 6) end.setDate(end.getDate() - 1);
  const start = new Date(end); start.setDate(start.getDate() - 100);
  const url = `https://api.frankfurter.app/${start.toISOString().slice(0,10)}..${end.toISOString().slice(0,10)}?from=USD&to=EUR,GBP,JPY,CHF,AUD,CAD,NZD`;
  const data = await fetchJson(url);
  if (!data || !data.rates) return null;
  frankCache = data;
  return data;
}

function buildFrankSeries(rates, dates, base, quote) {
  return dates.map(d => {
    const r = rates[d]; if (!r) return null;
    if (base === 'USD')  return r[quote] || null;
    if (quote === 'USD') return r[base]  ? 1 / r[base] : null;
    if (r[base] && r[quote]) return r[quote] / r[base];
    return null;
  }).filter(p => p && !isNaN(p));
}

// Synthetic per-TF: vyber jiné EMA periody, ne jiné okno
// Uložíme to v evaluateBias přes parametr nebo přepočítáme s adaptovanými svíčkami
const SYNTH_WINDOWS = { '5m': 28, '15m': 35, '30m': 45, '1h': 60, '4h': 75, '1D': 95 };

async function fetchFrankSynth(inst, tf) {
  if (!inst.frank) return [];
  const f = await loadFrankfurter();
  if (!f) return [];
  const dates = Object.keys(f.rates).sort();
  const series = buildFrankSeries(f.rates, dates, inst.frank.base, inst.frank.quote);
  const w = SYNTH_WINDOWS[tf] || series.length;
  return series.slice(-Math.min(w, series.length));
}

// ── Inventory ────────────────────────────────────────────────────────────────
const INSTRUMENTS = [
  // FX major
  { sym:'EURUSD', source:'twelve', td:'EUR/USD', frank:{base:'EUR', quote:'USD'} },
  { sym:'GBPUSD', source:'twelve', td:'GBP/USD', frank:{base:'GBP', quote:'USD'} },
  { sym:'USDJPY', source:'twelve', td:'USD/JPY', frank:{base:'USD', quote:'JPY'} },
  { sym:'USDCHF', source:'twelve', td:'USD/CHF', frank:{base:'USD', quote:'CHF'} },
  { sym:'AUDUSD', source:'twelve', td:'AUD/USD', frank:{base:'AUD', quote:'USD'} },
  { sym:'USDCAD', source:'twelve', td:'USD/CAD', frank:{base:'USD', quote:'CAD'} },
  { sym:'NZDUSD', source:'twelve', td:'NZD/USD', frank:{base:'NZD', quote:'USD'} },
  // FX cross
  { sym:'EURGBP', source:'twelve', td:'EUR/GBP', frank:{base:'EUR', quote:'GBP'} },
  { sym:'EURJPY', source:'twelve', td:'EUR/JPY', frank:{base:'EUR', quote:'JPY'} },
  { sym:'EURCHF', source:'twelve', td:'EUR/CHF', frank:{base:'EUR', quote:'CHF'} },
  { sym:'EURAUD', source:'twelve', td:'EUR/AUD', frank:{base:'EUR', quote:'AUD'} },
  { sym:'EURCAD', source:'twelve', td:'EUR/CAD', frank:{base:'EUR', quote:'CAD'} },
  { sym:'GBPJPY', source:'twelve', td:'GBP/JPY', frank:{base:'GBP', quote:'JPY'} },
  { sym:'GBPAUD', source:'twelve', td:'GBP/AUD', frank:{base:'GBP', quote:'AUD'} },
  { sym:'AUDJPY', source:'twelve', td:'AUD/JPY', frank:{base:'AUD', quote:'JPY'} },
  { sym:'CADJPY', source:'twelve', td:'CAD/JPY', frank:{base:'CAD', quote:'JPY'} },
  { sym:'NZDJPY', source:'twelve', td:'NZD/JPY', frank:{base:'NZD', quote:'JPY'} },
  // Commodities (TwelveData je má jako forex symboly)
  { sym:'XAUUSD', source:'twelve', td:'XAU/USD' },
  { sym:'XAGUSD', source:'twelve', td:'XAG/USD' },
  // Crypto
  { sym:'BTCUSD', source:'binance', binance:'BTCUSDT' },
  { sym:'ETHUSD', source:'binance', binance:'ETHUSDT' },
];

// ── Routing per instrument ───────────────────────────────────────────────────
async function fetchCandles(inst, tf, twelveKey, debug) {
  if (inst.source === 'binance') {
    const c = await fetchBinance(inst.binance, tf);
    debug.push(`  → ${inst.sym} ${tf}: Binance ${inst.binance} → ${c.length} svíček`);
    return { closes: c, source: 'Binance' };
  }
  if (twelveKey && inst.td) {
    const c = await fetchTwelve(inst.td, tf, twelveKey);
    if (c && c.length >= 28) {
      debug.push(`  → ${inst.sym} ${tf}: TwelveData ${inst.td} → ${c.length} svíček`);
      return { closes: c, source: 'TwelveData' };
    }
    debug.push(`  → ${inst.sym} ${tf}: TwelveData vrátilo ${c?.length || 0} svíček, fallback na Frankfurter`);
  }
  if (inst.frank) {
    const c = await fetchFrankSynth(inst, tf);
    debug.push(`  → ${inst.sym} ${tf}: Frankfurter ECB synthetic (window ${SYNTH_WINDOWS[tf]}) → ${c.length} svíček`);
    return { closes: c, source: 'Frankfurter (synthetic)' };
  }
  debug.push(`  → ${inst.sym} ${tf}: žádný zdroj nedostupný`);
  return { closes: [], source: 'none' };
}

// ── Handler ──────────────────────────────────────────────────────────────────
const TF_LIST = ['5m', '15m', '30m', '1h', '4h', '1D'];

exports.handler = async function(event) {
  const twelveKey = (event && event.queryStringParameters && event.queryStringParameters.twelveKey)
                 || process.env.TWELVE_KEY || '';
  const debug = [];
  const fetchedAt = new Date().toISOString();

  console.log('\n=== TECHNICAL ANALYSIS RUN ===');
  console.log('Source map: Binance (crypto) +', twelveKey ? 'TwelveData (FX/metals)' : 'Frankfurter ECB synthetic (FX/metals)');

  const results = {};
  const sourceUsed = {};

  // Sériově po timeframes (rate-limit safety pro TwelveData, free 8 req/min)
  for (const tf of TF_LIST) {
    debug.push(`\n── Timeframe ${tf} ──`);
    // Paralelně pro všechny instrumenty v tomto TF
    const promises = INSTRUMENTS.map(async (inst) => {
      try {
        const { closes, source } = await fetchCandles(inst, tf, twelveKey, debug);
        if (!sourceUsed[inst.sym]) sourceUsed[inst.sym] = source;
        const evald = evaluateBias(closes, inst.sym, tf, debug);
        if (!results[inst.sym]) results[inst.sym] = { tfBias: {}, indicators: {} };
        results[inst.sym].tfBias[tf] = evald.bias;
        results[inst.sym].indicators[tf] = {
          rsi: evald.rsi,
          ema20: evald.ema20 != null ? +evald.ema20.toFixed(5) : null,
          ema50: evald.ema50 != null ? +evald.ema50.toFixed(5) : null,
          macdHist: evald.macd ? +evald.macd.histogram.toFixed(6) : null,
          trend: +evald.trend.toFixed(2),
          score: +evald.score.toFixed(2),
          reason: evald.reason,
          candles: evald.candles,
          source,
        };
        // Pro 1D vyplníme i klasické vrchní pole (zpětná kompatibilita s frontendem)
        if (tf === '1D') {
          const conf = Math.min(5, Math.max(1, Math.round(Math.abs(evald.score) * 4)));
          const emaTrend = (evald.ema20 != null && evald.ema50 != null)
            ? (evald.ema20 > evald.ema50 ? 'EMA20 > EMA50 ↑' : 'EMA20 < EMA50 ↓')
            : 'Nedostatek dat';
          const sign = evald.trend >= 0 ? '+' : '';
          results[inst.sym].bias     = evald.bias;
          results[inst.sym].rsi      = evald.rsi != null ? evald.rsi : 50;
          results[inst.sym].emaTrend = emaTrend;
          results[inst.sym].momentum = sign + evald.trend.toFixed(2) + '%';
          results[inst.sym].conf     = evald.bias === 'Neutral' ? 0 : conf;
        }
      } catch (e) {
        debug.push(`  → ${inst.sym} ${tf}: ERR ${e.message}`);
      }
    });
    await Promise.all(promises);
  }

  // Bezpečnostní fallback — zaplň cokoli chybějícího
  for (const inst of INSTRUMENTS) {
    if (!results[inst.sym]) {
      results[inst.sym] = {
        tfBias: {}, indicators: {},
        bias: 'Neutral', rsi: 50, emaTrend: 'Nedostatek dat', momentum: '0.00%', conf: 0,
      };
    }
    for (const tf of TF_LIST) {
      if (!results[inst.sym].tfBias[tf]) results[inst.sym].tfBias[tf] = 'Neutral';
    }
  }

  // Pošli debug log do Netlify Function logs (viditelné v Netlify dashboard)
  for (const line of debug) console.log(line);

  // Statistika výstupu
  const stats = { Bullish: 0, Bearish: 0, Neutral: 0 };
  for (const sym of Object.keys(results)) {
    for (const tf of TF_LIST) {
      const b = results[sym].tfBias[tf];
      if (stats[b] !== undefined) stats[b]++;
    }
  }
  console.log(`\n=== STATS ===\nTotal cells: ${Object.keys(results).length * TF_LIST.length} | Bullish: ${stats.Bullish} | Bearish: ${stats.Bearish} | Neutral: ${stats.Neutral}\n`);

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=180',
    },
    body: JSON.stringify({
      results,
      timeframes: TF_LIST,
      sources: {
        crypto: 'Binance public API',
        fx_metals: twelveKey ? 'TwelveData (real intraday)' : 'Frankfurter ECB (synthetic intraday)',
      },
      sourceUsed,
      twelveKeyUsed: !!twelveKey,
      stats,
      debug: debug.slice(-200),  // posledních 200 řádků (max payload)
      fetched_at: fetchedAt,
    }),
  };
};
