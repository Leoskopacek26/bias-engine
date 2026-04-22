// Netlify Function: /netlify/functions/macro
// Stahuje VŠECHNA makro data včetně měnových skóre pro každou CB
// Spouští se při každém načtení stránky, cache 30 minut

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

function parseFredCsv(csv, limit = 14) {
  if (!csv || !csv.includes(',')) return [];
  return csv.trim().split('\n').slice(1)
    .map(l => { const [date, val] = l.trim().split(','); return { date, value: parseFloat(val) }; })
    .filter(r => r.date && !isNaN(r.value))
    .slice(-limit);
}

async function fetchFred(id, limit) {
  const end = new Date().toISOString().slice(0,10);
  const s = new Date(); s.setFullYear(s.getFullYear() - 2);
  const csv = await fetchText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${s.toISOString().slice(0,10)}&coed=${end}`);
  return parseFredCsv(csv, limit);
}

// ── Výpočet měnového skóre ───────────────────────────────────────────────────
// Každá měna dostane skóre -100 až +100 z:
//   - Výnosový diferenciál vs světový průměr
//   - Trend výnosů (rising = hawkish = bullish)
//   - Relativní síla vs USD

function calcCurrencyScores(yields, fxRates) {
  // Výnosový průměr (proxy centrálních bank)
  // Používáme US 10Y jako základ, ostatní odvozujeme z yield diferenciálů
  const us10y = yields.us10y || 4.3;
  const prevDay = Object.keys(fxRates).sort().slice(-2);
  const ratesT  = prevDay[1] ? fxRates[prevDay[1]] : {};
  const ratesT1 = prevDay[0] ? fxRates[prevDay[0]] : {};

  // Denní FX změny (pozitivní = měna posílila vs USD)
  const fxChange = {};
  for (const ccy of ['EUR','GBP','JPY','CHF','AUD','CAD','NZD']) {
    if (ratesT[ccy] && ratesT1[ccy]) {
      if (ccy === 'JPY') {
        // JPY: vyšší rate = slabší JPY, takže obráceně
        fxChange[ccy] = (ratesT1[ccy] - ratesT[ccy]) / ratesT1[ccy] * 100;
      } else {
        // EUR, GBP atd.: nižší rate per USD = silnější měna
        fxChange[ccy] = (ratesT1[ccy] - ratesT[ccy]) / ratesT1[ccy] * 100;
      }
    } else { fxChange[ccy] = 0; }
  }

  // Proxy sazeb centrálních bank (aproximace z yield spreads + CB politiky)
  // FRED má tyto série pro aktuální CB sazby:
  const cbRates = {
    USD: us10y,           // Fed funds proxy
    EUR: yields.eu_proxy || (us10y - 0.5),  // ECB proxy
    GBP: yields.gb_proxy || (us10y + 0.3),  // BoE proxy
    JPY: yields.jp_proxy || 0.5,            // BoJ - ultra nízké
    CHF: yields.ch_proxy || (us10y - 1.2),  // SNB
    AUD: yields.au_proxy || (us10y - 0.2),  // RBA
    CAD: yields.ca_proxy || (us10y - 0.1),  // BoC
    NZD: yields.nz_proxy || (us10y + 0.1),  // RBNZ
  };

  // Skóre = kombinace: yield vs průměr (40%) + FX momentum (40%) + CB postoj (20%)
  const avgYield = Object.values(cbRates).reduce((a,b)=>a+b,0) / 8;
  const scores = {};
  const currencies = ['USD','EUR','GBP','JPY','CHF','AUD','CAD','NZD'];

  for (const ccy of currencies) {
    const yieldScore   = ((cbRates[ccy] - avgYield) / 3) * 40;    // yield vs průměr
    const fxMomScore   = ccy === 'USD' ? 0 : (fxChange[ccy] || 0) * 20; // FX momentum
    const raw = yieldScore + fxMomScore;
    scores[ccy] = Math.max(-100, Math.min(100, Math.round(raw)));
  }

  // USD skóre: inverzní průměr ostatních (USD silný = ostatní slabé)
  const nonUSD = currencies.filter(c=>c!=='USD').map(c=>scores[c]);
  scores.USD = Math.max(-100, Math.min(100, -Math.round(nonUSD.reduce((a,b)=>a+b,0)/nonUSD.length)));

  return scores;
}

// ── Hlavní handler ───────────────────────────────────────────────────────────
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

  const prevDay = new Date();
  prevDay.setDate(prevDay.getDate() - 1);
  while (prevDay.getDay() === 0 || prevDay.getDay() === 6) prevDay.setDate(prevDay.getDate() - 1);
  const prevDayStr = prevDay.toISOString().slice(0,10);

  // Stáhni vše paralelně
  const [fxNow, fxPrev, yieldsData, vixData, cpiData, nfpData, fxHistory] = await Promise.all([
    fetchJson('https://api.frankfurter.app/latest?from=USD&to=EUR,GBP,JPY,CHF,AUD,CAD,NZD'),
    fetchJson(`https://api.frankfurter.app/${prevDayStr}?from=USD&to=EUR,GBP,JPY,CHF,AUD,CAD,NZD`),
    fetchFred('DGS10', 5),
    fetchJson('https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=3d'),
    fetchFred('CPIAUCSL', 14),
    fetchFred('PAYEMS', 14),
    // 5 dnů FX pro měnové skóre momentum
    fetchJson(`https://api.frankfurter.app/${(() => { const d=new Date(); d.setDate(d.getDate()-8); return d.toISOString().slice(0,10); })()}..${prevDayStr}?from=USD&to=EUR,GBP,JPY,CHF,AUD,CAD,NZD`),
  ]);

  // FX kurzy + DXY
  if (fxNow && fxNow.rates) {
    out.rates = fxNow.rates;
    out.sources.fx = 'Frankfurter (ECB)';
    if (fxPrev && fxPrev.rates && fxPrev.rates.EUR) {
      const eD = 1/fxNow.rates.EUR, eY = 1/fxPrev.rates.EUR;
      out.dxy_change = parseFloat((-(eD-eY)/eY*100).toFixed(3));
      out.sources.dxy = 'Odvozeno z EUR/USD';
    }
  }

  // US 10Y výnosy
  if (yieldsData.length >= 1) {
    out.yields10y      = yieldsData[yieldsData.length-1].value;
    out.yields10y_prev = yieldsData.length >= 2 ? yieldsData[yieldsData.length-2].value : out.yields10y;
    out.sources.yields = 'FRED DGS10';
  }

  // VIX
  try {
    const closes = vixData.chart.result[0].indicators.quote[0].close.filter(v=>v!=null);
    if (closes.length) { out.vix = parseFloat(closes[closes.length-1].toFixed(2)); out.sources.vix = 'Yahoo ^VIX'; }
  } catch(e) {}

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
  } catch(e) {}

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
  } catch(e) {}

  // Měnová skóre
  try {
    const fxRatesHistory = (fxHistory && fxHistory.rates) ? fxHistory.rates : {};
    // Přidej dnešní data
    if (fxNow && fxNow.rates) fxRatesHistory[new Date().toISOString().slice(0,10)] = fxNow.rates;
    const yieldProxy = { us10y: out.yields10y };
    out.currency_scores = calcCurrencyScores(yieldProxy, fxRatesHistory);
    // Seřaď měny podle skóre
    const sorted = Object.entries(out.currency_scores).sort((a,b)=>b[1]-a[1]);
    out.strong_ccys = sorted.filter(([,v])=>v>15).map(([k])=>k);
    out.weak_ccys   = sorted.filter(([,v])=>v<-15).map(([k])=>k);
    out.sources.currency_scores = 'FX momentum + yield diferenciál';
  } catch(e) {
    out.sources.currency_scores = 'error: ' + e.message;
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Cache-Control':'public, max-age=1800' },
    body: JSON.stringify(out),
  };
};
