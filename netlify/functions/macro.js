// Netlify Function: /netlify/functions/macro
// Běží na Netlify serveru — žádné CORS omezení
// Stahuje: FX kurzy (Frankfurter/ECB), US 10Y výnosy (FRED), VIX proxy
// Volá se z prohlížeče jako: fetch('/.netlify/functions/macro')

const https = require('https');

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'BiasEngine/1.0', 'Accept': 'application/json' }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

function fetchCsv(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'BiasEngine/1.0' }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', () => resolve(''));
  });
}

exports.handler = async function(event, context) {
  const result = {
    yields10y:    4.34,
    yields10y_prev: 4.32,
    dxy_change:   0,
    cpi_surprise: -0.2,
    nfp_surprise: 87,
    vix:          18.2,
    geo_risk:     0.35,
    rates:        {},
    sources:      {},
    fetched_at:   new Date().toISOString(),
  };

  // ── 1. FX kurzy z Frankfurter (ECB) ──────────────────────────────────────────
  try {
    const fx = await fetchUrl(
      'https://api.frankfurter.app/latest?from=USD&to=EUR,GBP,JPY,CHF,AUD,CAD,NZD'
    );
    if (fx && fx.rates) {
      result.rates   = fx.rates;
      result.sources.fx = 'Frankfurter (ECB)';
      // DXY proxy z EUR/USD — EUR tvoří 57% DXY, silná inverzní korelace
      // Porovnáme s předchozím dnem pro změnu
    }
  } catch(e) {
    result.sources.fx = 'error';
  }

  // ── 2. Předchozí den FX pro výpočet DXY změny ────────────────────────────────
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    // Přeskočit víkendy
    while (yesterday.getDay() === 0 || yesterday.getDay() === 6) {
      yesterday.setDate(yesterday.getDate() - 1);
    }
    const yStr = yesterday.toISOString().slice(0, 10);
    const fxPrev = await fetchUrl(
      `https://api.frankfurter.app/${yStr}?from=USD&to=EUR`
    );
    if (fxPrev && fxPrev.rates && fxPrev.rates.EUR && result.rates.EUR) {
      const eurToday = 1 / result.rates.EUR;
      const eurYest  = 1 / fxPrev.rates.EUR;
      const eurChg   = (eurToday - eurYest) / eurYest;
      result.dxy_change = parseFloat((-eurChg * 100).toFixed(3));
      result.sources.dxy = 'Odvozeno z EUR/USD (ECB)';
    }
  } catch(e) {
    result.sources.dxy = 'error';
  }

  // ── 3. US 10Y výnosy z FRED (CSV endpoint) ───────────────────────────────────
  try {
    const today = new Date().toISOString().slice(0, 10);
    const start = new Date();
    start.setDate(start.getDate() - 5);
    const startStr = start.toISOString().slice(0, 10);
    const csv = await fetchCsv(
      `https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10&cosd=${startStr}&coed=${today}`
    );
    if (csv && csv.includes(',')) {
      const lines = csv.trim().split('\n').slice(1).filter(l => l && !l.includes('.'));
      if (lines.length >= 1) {
        const vals = lines.map(l => parseFloat(l.split(',')[1])).filter(v => !isNaN(v));
        if (vals.length >= 1) {
          result.yields10y      = vals[vals.length - 1];
          result.yields10y_prev = vals.length >= 2 ? vals[vals.length - 2] : vals[0];
          result.sources.yields = 'FRED DGS10';
        }
      }
    }
  } catch(e) {
    result.sources.yields = 'error — použity záložní hodnoty';
  }

  // ── 4. VIX z Yahoo Finance (JSON endpoint) ────────────────────────────────────
  try {
    const vixData = await fetchUrl(
      'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=2d'
    );
    if (vixData && vixData.chart && vixData.chart.result) {
      const r = vixData.chart.result[0];
      const closes = r.indicators.quote[0].close.filter(v => v != null);
      if (closes.length >= 1) {
        result.vix = parseFloat(closes[closes.length - 1].toFixed(2));
        result.sources.vix = 'Yahoo Finance ^VIX';
      }
    }
  } catch(e) {
    result.sources.vix = 'error — použita záložní hodnota';
  }

  // ── 5. Geo riziko — odvozeno z VIX (jednoduché) ──────────────────────────────
  // VIX < 15 = klidné (0.1), VIX 15-25 = mírné (0.3), VIX > 25 = zvýšené (0.6+)
  result.geo_risk = result.vix < 15 ? 0.15
    : result.vix < 20 ? 0.30
    : result.vix < 25 ? 0.50
    : result.vix < 35 ? 0.70
    : 0.90;
  if (!result.sources.geo_risk) result.sources.geo_risk = 'Odvozeno z VIX';

  // CPI a NFP surprise — tyto se mění jen měsíčně, jsou napevno s datem poslední publikace
  // V produkci: napojit na FRED nebo Forex Factory calendar API
  result.sources.cpi = 'FRED — poslední zveřejnění (manuálně aktualizovat měsíčně)';
  result.sources.nfp = 'BLS — poslední zveřejnění (manuálně aktualizovat měsíčně)';

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=1800', // cache 30 minut
    },
    body: JSON.stringify(result),
  };
};
