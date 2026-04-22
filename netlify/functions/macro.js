// Netlify Function: /netlify/functions/macro
// Stahuje makro data - optimalizováno pro rychlost (< 8s)
// Cache: 30 minut

const https = require('https');

function fetchJson(url) {
  return new Promise(resolve => {
    https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BiasEngine/2.0)', 'Accept': 'application/json' }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchJson(res.headers.location).then(resolve);
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

function fetchText(url) {
  return new Promise(resolve => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BiasEngine/2.0)' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchText(res.headers.location).then(resolve);
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', () => resolve(''));
  });
}

function parseFredCsv(csv, limit) {
  if (!csv || !csv.includes(',')) return [];
  return csv.trim().split('\n').slice(1)
    .map(l => { const [date, val] = l.trim().split(','); return { date, value: parseFloat(val) }; })
    .filter(r => r.date && !isNaN(r.value))
    .slice(-limit);
}

async function fetchFred(id, limit) {
  const end = new Date().toISOString().slice(0,10);
  const s = new Date(); s.setFullYear(s.getFullYear() - 2);
  const csv = await fetchText(
    `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${s.toISOString().slice(0,10)}&coed=${end}`
  );
  return parseFredCsv(csv, limit);
}

// Měnová skóre - pouze z aktuálních vs včerejších FX dat (bez history fetch)
function calcCurrencyScores(fxToday, fxYest, yields10y) {
  const ccys = ['EUR','GBP','JPY','CHF','AUD','CAD','NZD'];
  const changes = {};

  for (const ccy of ccys) {
    if (fxToday[ccy] && fxYest[ccy]) {
      // ECB: rate = units per 1 USD
      // Pokles rate = měna posílila (méně jednotek za 1 USD)
      const chg = (fxYest[ccy] - fxToday[ccy]) / fxYest[ccy] * 100;
      changes[ccy] = chg; // kladné = měna posílila
    } else { changes[ccy] = 0; }
  }

  // USD change = inverzní průměr ostatních
  const avgChange = Object.values(changes).reduce((a,b)=>a+b,0) / ccys.length;
  changes['USD'] = -avgChange;

  // Přidej yield diferenciál (přibližný)
  // Vyšší US výnosy = USD silnější vs nízkovýnosové měny
  const yieldBias = (yields10y - 4.0) * 10; // +/- 10 bodů na 1% výnosu
  const yieldEffect = { USD: yieldBias, JPY: -yieldBias*1.5, CHF: -yieldBias*0.5,
    EUR: -yieldBias*0.3, GBP: -yieldBias*0.2, AUD: -yieldBias*0.1,
    CAD: -yieldBias*0.1, NZD: -yieldBias*0.1 };

  const scores = {};
  for (const ccy of [...ccys, 'USD']) {
    const fxScore    = (changes[ccy] || 0) * 15;
    const yldScore   = yieldEffect[ccy] || 0;
    scores[ccy] = Math.max(-100, Math.min(100, Math.round(fxScore + yldScore)));
  }

  return scores;
}

exports.handler = async function() {
  const out = {
    yields10y: 4.28, yields10y_prev: 4.30,
    dxy_change: 0,
    cpi_actual: 2.4, cpi_prev: 2.8, cpi_consensus: 2.6, cpi_surprise: -0.2,
    nfp_actual: 228, nfp_prev: 151, nfp_consensus: 140, nfp_surprise: 88,
    vix: 18.2, geo_risk: 0.35, rates: {},
    currency_scores: { USD:0, EUR:0, GBP:0, JPY:0, CHF:0, AUD:0, CAD:0, NZD:0 },
    strong_ccys: [], weak_ccys: [],
    sources: {}, fetched_at: new Date().toISOString(),
  };

  // Předchozí obchodní den
  const prevDay = new Date();
  prevDay.setDate(prevDay.getDate() - 1);
  while (prevDay.getDay() === 0 || prevDay.getDay() === 6) prevDay.setDate(prevDay.getDate() - 1);
  const prevDayStr = prevDay.toISOString().slice(0,10);

  // Paralelní fetch — všechno najednou pro rychlost
  const [fxNow, fxPrev, yieldsData, vixData, cpiData, nfpData] = await Promise.all([
    fetchJson('https://api.frankfurter.app/latest?from=USD&to=EUR,GBP,JPY,CHF,AUD,CAD,NZD'),
    fetchJson(`https://api.frankfurter.app/${prevDayStr}?from=USD&to=EUR,GBP,JPY,CHF,AUD,CAD,NZD`),
    fetchFred('DGS10', 5),
    fetchJson('https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=3d'),
    fetchFred('CPIAUCSL', 14),
    fetchFred('PAYEMS', 14),
  ]);

  // FX + DXY
  if (fxNow && fxNow.rates) {
    out.rates = fxNow.rates;
    out.sources.fx = 'Frankfurter (ECB)';
    if (fxPrev && fxPrev.rates && fxPrev.rates.EUR) {
      const eD = 1/fxNow.rates.EUR, eY = 1/fxPrev.rates.EUR;
      out.dxy_change = parseFloat((-(eD-eY)/eY*100).toFixed(3));
      out.sources.dxy = 'Odvozeno z EUR/USD';
    }
  }

  // 10Y výnosy
  if (yieldsData.length >= 1) {
    out.yields10y      = yieldsData[yieldsData.length-1].value;
    out.yields10y_prev = yieldsData.length >= 2 ? yieldsData[yieldsData.length-2].value : out.yields10y;
    out.sources.yields = 'FRED DGS10';
  }

  // VIX
  try {
    const closes = vixData.chart.result[0].indicators.quote[0].close.filter(v=>v!=null);
    if (closes.length) { out.vix = parseFloat(closes[closes.length-1].toFixed(2)); out.sources.vix = 'Yahoo ^VIX'; }
  } catch(e) { out.sources.vix = 'error'; }

  // Geo riziko z VIX
  out.geo_risk = out.vix < 15 ? 0.15 : out.vix < 20 ? 0.30 : out.vix < 25 ? 0.50 : out.vix < 35 ? 0.70 : 0.90;

  // CPI
  try {
    if (cpiData.length >= 13) {
      const yoy = i => (cpiData[i].value/cpiData[i-12].value-1)*100;
      const latest = parseFloat(yoy(cpiData.length-1).toFixed(2));
      const prev   = parseFloat(yoy(cpiData.length-2).toFixed(2));
      const trend  = [yoy(cpiData.length-4),yoy(cpiData.length-3),yoy(cpiData.length-2)];
      const consensus = parseFloat((trend.reduce((a,b)=>a+b,0)/3).toFixed(2));
      out.cpi_actual = latest; out.cpi_prev = prev;
      out.cpi_consensus = consensus; out.cpi_surprise = parseFloat((latest-consensus).toFixed(2));
      out.sources.cpi = 'FRED CPIAUCSL';
    }
  } catch(e) { out.sources.cpi = 'error'; }

  // NFP
  try {
    if (nfpData.length >= 2) {
      const deltas = nfpData.slice(1).map((r,i)=>Math.round(r.value-nfpData[i].value));
      const latest = deltas[deltas.length-1];
      const prev6  = deltas.slice(-7,-1);
      const consensus = Math.round(prev6.reduce((a,b)=>a+b,0)/prev6.length);
      out.nfp_actual = latest; out.nfp_prev = deltas.length>=2?deltas[deltas.length-2]:latest;
      out.nfp_consensus = consensus; out.nfp_surprise = latest-consensus;
      out.sources.nfp = 'FRED PAYEMS';
    }
  } catch(e) { out.sources.nfp = 'error'; }

  // Měnová skóre (z dnešních + včerejších FX dat)
  if (fxNow && fxNow.rates && fxPrev && fxPrev.rates) {
    const scores = calcCurrencyScores(fxNow.rates, fxPrev.rates, out.yields10y);
    out.currency_scores = scores;
    const sorted = Object.entries(scores).sort((a,b)=>b[1]-a[1]);
    out.strong_ccys = sorted.filter(([,v])=>v>10).map(([k])=>k);
    out.weak_ccys   = sorted.filter(([,v])=>v<-10).map(([k])=>k);
    out.sources.currency_scores = 'FX denní momentum + yield diferenciál';
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=1800',
    },
    body: JSON.stringify(out),
  };
};
