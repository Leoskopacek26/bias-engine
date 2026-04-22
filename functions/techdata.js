// Netlify Function: technická analýza
// Stahuje historická ECB data a POČÍTÁ indikátory na serveru
// Prohlížeč dostane jen hotové výsledky — žádné velké datové přenosy

const https = require('https');

function fetchJson(url) {
  return new Promise(resolve => {
    https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BiasEngine/2.0)' }
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

// Spočítá EMA pro pole cen
function calcEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return ema;
}

// Spočítá RSI(14)
function calcRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const rs = gains / (losses || 0.0001);
  return Math.round(100 - (100 / (1 + rs)));
}

// Sestaví cenovou řadu páru z ECB dat (USD base)
function buildSeries(rates, dates, base, quote) {
  return dates.map(d => {
    const r = rates[d];
    if (!r) return null;
    // USD/XXX přímo
    if (base === 'USD') return r[quote] || null;
    // XXX/USD inverzně
    if (quote === 'USD') return r[base] ? 1 / r[base] : null;
    // Cross páry: EUR/GBP = r.GBP / r.EUR (obě jsou XXX per 1 USD)
    if (r[base] && r[quote]) return r[quote] / r[base];
    return null;
  }).filter(p => p !== null && !isNaN(p));
}

// Spočítá technický bias z cenové řady
function calcBias(prices) {
  if (!prices || prices.length < 22) {
    return { bias: 'Neutral', rsi: 50, emaTrend: 'Nedostatek dat', momentum: '0.00%', conf: 0 };
  }
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

  const bias = score > 0.20 ? 'Bullish' : score < -0.20 ? 'Bearish' : 'Neutral';
  const conf = Math.min(5, Math.max(1, Math.round(Math.abs(score) * 6)));
  const emaTrend = ema20 && ema50
    ? (ema20 > ema50 ? 'EMA20 > EMA50 ↑' : 'EMA20 < EMA50 ↓')
    : 'Nedostatek dat';
  const sign = momentum >= 0 ? '+' : '';
  return { bias, rsi: rsi || 50, emaTrend, momentum: sign + momentum.toFixed(2) + '%', conf };
}

const PAIRS = [
  { sym:'EURUSD', base:'EUR', quote:'USD' },
  { sym:'GBPUSD', base:'GBP', quote:'USD' },
  { sym:'USDJPY', base:'USD', quote:'JPY' },
  { sym:'USDCHF', base:'USD', quote:'CHF' },
  { sym:'AUDUSD', base:'AUD', quote:'USD' },
  { sym:'USDCAD', base:'USD', quote:'CAD' },
  { sym:'NZDUSD', base:'NZD', quote:'USD' },
  { sym:'EURGBP', base:'EUR', quote:'GBP' },
  { sym:'EURJPY', base:'EUR', quote:'JPY' },
  { sym:'EURCHF', base:'EUR', quote:'CHF' },
  { sym:'EURAUD', base:'EUR', quote:'AUD' },
  { sym:'EURCAD', base:'EUR', quote:'CAD' },
  { sym:'GBPJPY', base:'GBP', quote:'JPY' },
  { sym:'GBPAUD', base:'GBP', quote:'AUD' },
  { sym:'AUDJPY', base:'AUD', quote:'JPY' },
  { sym:'CADJPY', base:'CAD', quote:'JPY' },
  { sym:'NZDJPY', base:'NZD', quote:'JPY' },
  { sym:'XAUUSD', base:'XAU', quote:'USD' }, // ECB nemá zlato — záloha
  { sym:'XAGUSD', base:'XAG', quote:'USD' }, // ECB nemá stříbro — záloha
];

exports.handler = async function() {
  // Správný výpočet datového rozsahu
  const end = new Date();
  end.setDate(end.getDate() - 1);
  while (end.getDay() === 0 || end.getDay() === 6) end.setDate(end.getDate() - 1);
  const start = new Date(end);
  start.setDate(start.getDate() - 100);

  const endStr   = end.toISOString().slice(0, 10);
  const startStr = start.toISOString().slice(0, 10);

  const url = `https://api.frankfurter.app/${startStr}..${endStr}?from=USD&to=EUR,GBP,JPY,CHF,AUD,CAD,NZD`;
  const data = await fetchJson(url);

  if (!data || !data.rates) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Nepodařilo se stáhnout historická data z ECB' }),
    };
  }

  const dates = Object.keys(data.rates).sort();
  const results = {};

  for (const pair of PAIRS) {
    if (pair.base === 'XAU' || pair.base === 'XAG') {
      // Zlato a stříbro — ECB nemá, vrátíme zálohu
      results[pair.sym] = { bias: 'Neutral', rsi: 50, emaTrend: 'Bez dat (ECB)', momentum: '0.00%', conf: 0 };
      continue;
    }
    const prices = buildSeries(data.rates, dates, pair.base, pair.quote);
    results[pair.sym] = calcBias(prices);
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    },
    body: JSON.stringify({ results, days: dates.length, start: startStr, end: endStr }),
  };
};
