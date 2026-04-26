// Netlify Function: technická analýza
// Stahuje multi-timeframe data z Yahoo Finance a počítá indikátory na serveru
// Vrací bias (Bullish/Neutral/Bearish) pro 5m, 15m, 30m, 1h, 4h, 1D
// + detailní 1D analýzu (RSI, EMA trend, momentum)

const https = require('https');

function fetchJson(url) {
  return new Promise(resolve => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BiasEngine/3.0)',
        'Accept': 'application/json',
      },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJson(res.headers.location).then(resolve);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// ── Indikátory ───────────────────────────────────────────────────────────────
function calcEMA(prices, period) {
  if (!prices || prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(prices, period = 14) {
  if (!prices || prices.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const rs = gains / (losses || 0.0001);
  return Math.round(100 - (100 / (1 + rs)));
}

// Skóre bias pro libovolný timeframe (vrací číslo + meziproduktyy)
function biasScore(prices) {
  if (!prices || prices.length < 22) return null;
  const ema20 = calcEMA(prices, 20);
  const ema50 = calcEMA(prices, Math.min(50, prices.length - 2));
  const rsi   = calcRSI(prices);
  const last  = prices[prices.length - 1];
  const prev5 = prices[prices.length - 6] || prices[0];
  const momentum = ((last - prev5) / prev5) * 100;

  let score = 0;
  if (ema20 && ema50) {
    if (ema20 > ema50) score += 0.30; else score -= 0.30;
    if (last > ema20)  score += 0.20; else score -= 0.20;
  }
  if (rsi !== null) {
    if (rsi > 60)      score += 0.25;
    else if (rsi < 40) score -= 0.25;
    else               score += (rsi - 50) / 100;
  }
  if (momentum > 0.3)       score += 0.25;
  else if (momentum < -0.3) score -= 0.25;
  return { score, ema20, ema50, rsi, momentum, last };
}

function scoreToBias(score) {
  if (score === null || score === undefined) return 'Neutral';
  if (score > 0.20) return 'Bullish';
  if (score < -0.20) return 'Bearish';
  return 'Neutral';
}

// Detailní 1D analýza pro hlavní sloupce tabulky (RSI, EMA, Momentum)
function calcDetailed(prices) {
  const s = biasScore(prices);
  if (!s) return { bias: 'Neutral', rsi: 50, emaTrend: 'Nedostatek dat', momentum: '0.00%', conf: 0 };
  const bias = scoreToBias(s.score);
  const conf = Math.min(5, Math.max(1, Math.round(Math.abs(s.score) * 6)));
  const emaTrend = s.ema20 && s.ema50
    ? (s.ema20 > s.ema50 ? 'EMA20 > EMA50 ↑' : 'EMA20 < EMA50 ↓')
    : 'Nedostatek dat';
  const sign = s.momentum >= 0 ? '+' : '';
  return { bias, rsi: s.rsi || 50, emaTrend, momentum: sign + s.momentum.toFixed(2) + '%', conf };
}

// ── Yahoo Finance loader ─────────────────────────────────────────────────────
async function fetchYahoo(symbol, interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const data = await fetchJson(url);
  if (!data || !data.chart || !data.chart.result || !data.chart.result[0]) return null;
  const result = data.chart.result[0];
  const closes = result.indicators?.quote?.[0]?.close;
  if (!closes) return null;
  return closes.filter(p => p !== null && !isNaN(p));
}

// Agregace 1h dat na 4h: vezmeme close každé 4. svíčky
function aggregate(prices, factor) {
  if (!prices || !prices.length) return [];
  const out = [];
  for (let i = factor - 1; i < prices.length; i += factor) out.push(prices[i]);
  return out;
}

// ── Konfigurace timeframes ───────────────────────────────────────────────────
// Yahoo nepodporuje 4h nativně — odvodíme ho z 1h dat
const TF_CONFIG = [
  { tf: '5m',  interval: '5m',  range: '5d'  },
  { tf: '15m', interval: '15m', range: '5d'  },
  { tf: '30m', interval: '30m', range: '5d'  },
  { tf: '1h',  interval: '60m', range: '1mo' },
  { tf: '4h',  interval: '60m', range: '3mo', aggregate: 4 },
  { tf: '1D',  interval: '1d',  range: '6mo' },
];

const PAIRS = [
  // FX major
  { sym: 'EURUSD', yahoo: 'EURUSD=X' },
  { sym: 'GBPUSD', yahoo: 'GBPUSD=X' },
  { sym: 'USDJPY', yahoo: 'JPY=X'    },
  { sym: 'USDCHF', yahoo: 'CHF=X'    },
  { sym: 'AUDUSD', yahoo: 'AUDUSD=X' },
  { sym: 'USDCAD', yahoo: 'CAD=X'    },
  { sym: 'NZDUSD', yahoo: 'NZDUSD=X' },
  // FX cross
  { sym: 'EURGBP', yahoo: 'EURGBP=X' },
  { sym: 'EURJPY', yahoo: 'EURJPY=X' },
  { sym: 'EURCHF', yahoo: 'EURCHF=X' },
  { sym: 'EURAUD', yahoo: 'EURAUD=X' },
  { sym: 'EURCAD', yahoo: 'EURCAD=X' },
  { sym: 'GBPJPY', yahoo: 'GBPJPY=X' },
  { sym: 'GBPAUD', yahoo: 'GBPAUD=X' },
  { sym: 'AUDJPY', yahoo: 'AUDJPY=X' },
  { sym: 'CADJPY', yahoo: 'CADJPY=X' },
  { sym: 'NZDJPY', yahoo: 'NZDJPY=X' },
  // Commodities
  { sym: 'XAUUSD', yahoo: 'GC=F' },
  { sym: 'XAGUSD', yahoo: 'SI=F' },
  // Crypto
  { sym: 'BTCUSD', yahoo: 'BTC-USD' },
  { sym: 'ETHUSD', yahoo: 'ETH-USD' },
];

// ── Handler ──────────────────────────────────────────────────────────────────
exports.handler = async function() {
  const fetchedAt = new Date().toISOString();

  // Pro každý timeframe paralelně načti všechny páry (6 sériových rund × 21 paralelně)
  const priceCache = {};
  for (const p of PAIRS) priceCache[p.sym] = {};

  for (const cfg of TF_CONFIG) {
    const promises = PAIRS.map(async (p) => {
      try {
        let prices = await fetchYahoo(p.yahoo, cfg.interval, cfg.range);
        if (prices && cfg.aggregate) prices = aggregate(prices, cfg.aggregate);
        priceCache[p.sym][cfg.tf] = prices || [];
      } catch (e) {
        priceCache[p.sym][cfg.tf] = [];
      }
    });
    await Promise.all(promises);
  }

  // Sestav výsledky
  const results = {};
  for (const p of PAIRS) {
    const tfBias = {};
    let daily = null;
    for (const cfg of TF_CONFIG) {
      const prices = priceCache[p.sym][cfg.tf];
      const s = biasScore(prices);
      tfBias[cfg.tf] = s ? scoreToBias(s.score) : 'Neutral';
      if (cfg.tf === '1D') daily = calcDetailed(prices);
    }
    if (!daily) daily = { bias: 'Neutral', rsi: 50, emaTrend: 'Nedostatek dat', momentum: '0.00%', conf: 0 };

    // Sloučíme detailní 1D analýzu s bias semaforem pro všechny timeframes
    results[p.sym] = {
      ...daily,
      tfBias,
    };
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=300',
    },
    body: JSON.stringify({
      results,
      timeframes: TF_CONFIG.map(c => c.tf),
      source: 'Yahoo Finance',
      fetched_at: fetchedAt,
    }),
  };
};
