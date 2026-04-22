// Netlify Function: /netlify/functions/macro
// FX Fundamental Bias Engine v4 — Poor Man's OIS Architecture
// Dle doporučení GPT-4: rate expectations repricing, surprises, regime, confidence
// Zdroje: FRED (CB sazby, 2Y/10Y výnosy, CPI, NFP), ECB (FX), Yahoo (VIX)

const https = require('https');

// ── HTTP helpers ─────────────────────────────────────────────────────────────
function fetchJson(url) {
  return new Promise(resolve => {
    https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BiasEngine/4.0)', 'Accept': 'application/json' }
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
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BiasEngine/4.0)' } }, res => {
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
    .filter(r => r.date && !isNaN(r.value)).slice(-limit);
}

async function fetchFred(id, limit) {
  const end = new Date().toISOString().slice(0, 10);
  const s = new Date(); s.setFullYear(s.getFullYear() - 2);
  const csv = await fetchText(
    `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${s.toISOString().slice(0,10)}&coed=${end}`
  );
  return parseFredCsv(csv, limit);
}

const last = arr => arr && arr.length ? arr[arr.length-1].value : null;
const prev = arr => arr && arr.length >= 2 ? arr[arr.length-2].value : null;

// ── NORMALIZACE: z-score cappovaný na [-2, +2] ────────────────────────────────
function zscore(val, arr) {
  if (!arr || arr.length < 2) return 0;
  const mean = arr.reduce((a,b)=>a+b,0)/arr.length;
  const std  = Math.sqrt(arr.reduce((a,b)=>a+(b-mean)**2,0)/arr.length) || 1;
  return Math.max(-2.0, Math.min(2.0, (val-mean)/std));
}

// ── KONFIGURACE VEŠKERÝCH VAH (snadno měnitelné) ──────────────────────────────
const CFG = {
  // Structural layer
  real_rate: 0.50, policy_rate: 0.25, infl_gap: 0.25,
  // Cyclical layer
  w_expect: 0.55, w_cpi: 0.45,
  // Expectations score (Poor Man's OIS)
  ois_gap: 0.50, ois_rep3d: 0.30, ois_rep5d: 0.20,
  // CPI surprise
  cpi_trend: 0.50, cpi_accel: 0.30, cpi_gap: 0.20,
  // Confirmation filter penalties
  fx_conflict_mult: 0.72, y10_conflict_mult: 0.88,
  // Market layer (per-regime): [y10_delta, fx_momentum, safe_haven]
  mkt_panic:   [0.28, 0.20, 0.52],
  mkt_riskoff: [0.35, 0.28, 0.37],
  mkt_neutral: [0.42, 0.35, 0.23],
  mkt_carry:   [0.50, 0.38, 0.12],
  // Regime layer weights: [structural, cyclical, market]
  reg_panic:   [0.22, 0.22, 0.56],
  reg_riskoff: [0.28, 0.27, 0.45],
  reg_neutral: [0.35, 0.32, 0.33],
  reg_carry:   [0.42, 0.30, 0.28],
  // Pair overlay
  overlay_spread: 0.55, overlay_change: 0.45,
  overlay_jpy_mult: 1.6,   // yield spread stronger for JPY/CHF pairs
  overlay_scale: 28,        // pts per z-unit
  // Sigmoid sensitivity
  sigmoid_k: 0.052,
  // Confidence thresholds
  conf_strong: 0.65, conf_moderate: 0.42,
};

// ── CCYS ──────────────────────────────────────────────────────────────────────
const CCYS = ['USD','EUR','GBP','JPY','CHF','AUD','CAD','NZD'];

// ── LAYER 1: STRUCTURAL ───────────────────────────────────────────────────────
function calcStructural(ccy, D) {
  const cb  = D.cb[ccy] || 0;
  const cpi = D.cpi[ccy] || 2.0;
  const tgt = D.tgt[ccy] || 2.0;
  const all_real = CCYS.map(c => (D.cb[c]||0) - (D.cpi[c]||2));
  const all_cb   = CCYS.map(c => D.cb[c]||0);
  const all_gap  = CCYS.map(c => (D.cpi[c]||2) - (D.tgt[c]||2));
  return CFG.real_rate   * zscore(cb-cpi, all_real)
       + CFG.policy_rate * zscore(cb,     all_cb)
       + CFG.infl_gap    * zscore(cpi-tgt,all_gap);
}

// ── LAYER 2A: POOR MAN'S OIS (rate expectations) ─────────────────────────────
function calcExpectations(ccy, D) {
  const cb    = D.cb[ccy]    || 0;
  const y2    = D.y2[ccy]    || 0;
  const y2_3d = D.y2_3d[ccy] || y2;
  const y2_5d = D.y2_5d[ccy] || y2;
  const y10   = D.y10[ccy]   || 0;
  const y10_3d= D.y10_3d[ccy]|| y10;
  const fx3   = D.fx3[ccy]   || 0;

  const gap   = y2 - cb;                   // Rate gap: trh čeká +/- od CB
  const rep3d = y2 - y2_3d;               // Repricing 3D momentum (KRITICKÝ)
  const rep5d = y2 - y2_5d;               // Repricing 5D momentum

  const z_gap  = zscore(gap,   CCYS.map(c=>(D.y2[c]||0)-(D.cb[c]||0)));
  const z_r3d  = zscore(rep3d, CCYS.map(c=>(D.y2[c]||0)-(D.y2_3d[c]||D.y2[c]||0)));
  const z_r5d  = zscore(rep5d, CCYS.map(c=>(D.y2[c]||0)-(D.y2_5d[c]||D.y2[c]||0)));

  const raw = CFG.ois_gap*z_gap + CFG.ois_rep3d*z_r3d + CFG.ois_rep5d*z_r5d;

  // Confirmation filter: FX a 10Y musí potvrzovat repricing
  const fx_sign  = fx3 > 0.05 ? 1 : fx3 < -0.05 ? -1 : 0;
  const rep_sign = rep3d > 0.003 ? 1 : rep3d < -0.003 ? -1 : 0;
  const d10      = y10 - y10_3d;

  let mult = 1.0;
  if (rep_sign !== 0 && fx_sign !== 0 && fx_sign !== rep_sign) mult *= CFG.fx_conflict_mult;
  if (rep_sign !== 0 && Math.abs(rep3d) > 0.003) {
    const y10_confirm = (d10 > 0) === (rep3d > 0);
    if (!y10_confirm) mult *= CFG.y10_conflict_mult;
  }
  return raw * mult;
}

// ── LAYER 2B: CPI SURPRISE (direction + acceleration) ────────────────────────
function calcCpiScore(ccy, D) {
  const cpi  = D.cpi[ccy]    || 2.0;
  const c3m  = D.cpi3m[ccy]  || cpi;
  const c6m  = D.cpi6m[ccy]  || c3m;
  const tgt  = D.tgt[ccy]    || 2.0;

  const trend = cpi - c3m;                            // směr trendu
  const accel = (cpi - c3m) - (c3m - c6m);           // akcelerace
  const gap   = cpi - tgt;

  const z_trend = zscore(trend, CCYS.map(c=>(D.cpi[c]||2)-(D.cpi3m[c]||D.cpi[c]||2)));
  const z_accel = zscore(accel, CCYS.map(c=>((D.cpi[c]||2)-(D.cpi3m[c]||D.cpi[c]||2))-((D.cpi3m[c]||D.cpi[c]||2)-(D.cpi6m[c]||D.cpi3m[c]||2))));
  const z_gap   = zscore(gap,   CCYS.map(c=>(D.cpi[c]||2)-(D.tgt[c]||2)));

  return CFG.cpi_trend*z_trend + CFG.cpi_accel*z_accel + CFG.cpi_gap*z_gap;
}

// ── LAYER 3: MARKET ────────────────────────────────────────────────────────────
function calcMarket(ccy, D, mktW) {
  const d10  = (D.y10[ccy]||0) - (D.y10_3d[ccy]||D.y10[ccy]||0);
  const fx3  = D.fx3[ccy] || 0;
  const fx5  = D.fx5[ccy] || 0;
  const vix  = D.vix      || 18;
  const vix5 = D.vix5d    || vix;
  const eq5  = D.eq5d     || 0;

  const z_d10 = zscore(d10, CCYS.map(c=>(D.y10[c]||0)-(D.y10_3d[c]||D.y10[c]||0)));
  const z_fx  = 0.60*zscore(fx3, CCYS.map(c=>D.fx3[c]||0))
              + 0.40*zscore(fx5, CCYS.map(c=>D.fx5[c]||0));

  // Safe haven: POUZE při rostoucím VIX (ne jen vysokém)
  let sh = 0;
  const vix_rising = vix > vix5 * 1.05;
  if (vix_rising) {
    const vi = Math.min(2.0, (vix-vix5)/vix5*5) * (eq5 < -2 ? 1.25 : 1.0);
    if      (ccy === 'JPY')              sh = +vi;
    else if (ccy === 'CHF')              sh = +vi * 0.75;
    else if (ccy === 'AUD' || ccy === 'NZD') sh = -vi * 1.10;
  }

  return mktW[0]*z_d10 + mktW[1]*z_fx + mktW[2]*sh;
}

// ── REGIME CLASSIFIER ────────────────────────────────────────────────────────
function classifyRegime(vix, vix5d, eq5d, y2vals) {
  const vix_rising = vix > vix5d * 1.05;
  const yield_disp = Math.max(...y2vals) - Math.min(...y2vals);
  if (vix > 28 || (vix > 22 && eq5d < -3)) return 'panic';
  if (vix > 20 || (vix > 18 && vix_rising)) return 'riskoff';
  if (vix < 15 && yield_disp > 2.5) return 'carry';
  return 'neutral';
}

// ── PAIR BIAS: currency_A - currency_B + yield spread overlay ─────────────────
function calcPairBias(symA, symB, scores, D) {
  const diff = scores[symA] - scores[symB];

  const spread    = (D.y10[symA]||0)    - (D.y10[symB]||0);
  const spread_3d = (D.y10_3d[symA]||0) - (D.y10_3d[symB]||0);
  const d_spread  = spread - spread_3d;

  const z_spr = Math.max(-2, Math.min(2, spread  / 2.5));
  const z_dsp = Math.max(-2, Math.min(2, d_spread / 0.25));

  // Yield spread je silnější pro JPY a CHF páry (carry trade logika)
  const yldMult = (symB==='JPY'||symB==='CHF') ? CFG.overlay_jpy_mult : 1.0;
  const overlay = Math.round((CFG.overlay_spread*z_spr + CFG.overlay_change*z_dsp) * CFG.overlay_scale * yldMult);

  const total = diff + overlay;
  const bull  = 1 / (1 + Math.exp(-total * CFG.sigmoid_k));
  const bear  = 1 - bull;

  const conf_raw = Math.min(1.0, Math.abs(total) / 50.0);
  const conf_txt = conf_raw >= CFG.conf_strong ? 'Strong' : conf_raw >= CFG.conf_moderate ? 'Moderate' : 'Weak';
  const conf_num = conf_raw >= CFG.conf_strong ? 5 : conf_raw >= CFG.conf_moderate ? 3 : 1;

  return {
    bias: bull > 0.60 ? 'Bullish' : bear > 0.60 ? 'Bearish' : 'Neutral',
    bull: Math.round(bull*100), bear: Math.round(bear*100),
    conf: conf_num, conf_txt,
    score_diff: total, yield_spread: Math.round(spread*100)/100,
    drivers: [
      symA + (scores[symA]>=0?'+':'') + scores[symA],
      symB + (scores[symB]>=0?'+':'') + scores[symB],
      'Spread ' + (total>=0?'+':'') + total,
    ],
  };
}

// ── FALLBACK DATA ─────────────────────────────────────────────────────────────
const FB = {
  cb:   {USD:4.33,EUR:2.50,GBP:4.50,JPY:0.50,CHF:0.25,AUD:4.10,CAD:2.75,NZD:3.50},
  y10:  {USD:4.28,EUR:2.55,GBP:4.52,JPY:1.52,CHF:0.65,AUD:4.35,CAD:3.15,NZD:4.55},
  y2:   {USD:3.82,EUR:1.98,GBP:4.10,JPY:0.62,CHF:0.20,AUD:3.85,CAD:2.85,NZD:3.90},
  cpi:  {USD:2.4, EUR:2.2, GBP:2.6, JPY:2.9, CHF:0.3, AUD:2.4, CAD:2.3, NZD:2.5},
  tgt:  {USD:2.0, EUR:2.0, GBP:2.0, JPY:2.0, CHF:2.0, AUD:2.5, CAD:2.0, NZD:2.0},
};

// ── HLAVNÍ HANDLER ────────────────────────────────────────────────────────────
exports.handler = async function() {
  // Předchozí obchodní den
  const prevDay = new Date();
  prevDay.setDate(prevDay.getDate()-1);
  while (prevDay.getDay()===0||prevDay.getDay()===6) prevDay.setDate(prevDay.getDate()-1);
  const pd = prevDay.toISOString().slice(0,10);

  // 5D a 3D ago
  const d3 = new Date(prevDay); d3.setDate(d3.getDate()-4);
  const d5 = new Date(prevDay); d5.setDate(d5.getDate()-7);
  const d3s = d3.toISOString().slice(0,10);
  const d5s = d5.toISOString().slice(0,10);

  // Paralelní fetch
  const [
    fxNow, fxPrev, fx3d, fx5d,
    usRate, eurRate, gbpRate, jpyRate, chfRate, audRate, cadRate, nzdRate,
    us10y, de10y, gb10y, jp10y,
    us2y, de2y, gb2y,
    usCpi, eurCpiR, gbpCpiR, jpyCpiR,
    usNfp, vixData,
    us10y_hist, de10y_hist, us2y_hist, de2y_hist,
  ] = await Promise.all([
    fetchJson('https://api.frankfurter.app/latest?from=USD&to=EUR,GBP,JPY,CHF,AUD,CAD,NZD'),
    fetchJson(`https://api.frankfurter.app/${pd}?from=USD&to=EUR,GBP,JPY,CHF,AUD,CAD,NZD`),
    fetchJson(`https://api.frankfurter.app/${d3s}?from=USD&to=EUR,GBP,JPY,CHF,AUD,CAD,NZD`),
    fetchJson(`https://api.frankfurter.app/${d5s}?from=USD&to=EUR,GBP,JPY,CHF,AUD,CAD,NZD`),
    fetchFred('FEDFUNDS',3), fetchFred('ECBDFR',3), fetchFred('BOERUKQ',3),
    fetchFred('IRSTCI01JPM156N',3), fetchFred('IRSTCI01CHM156N',3),
    fetchFred('IRSTCI01AUM156N',3), fetchFred('IRSTCI01CAM156N',3), fetchFred('IRSTCI01NZM156N',3),
    fetchFred('DGS10',8), fetchFred('IRLTLT01DEM156N',5), fetchFred('IRLTLT01GBM156N',5), fetchFred('IRLTLT01JPM156N',5),
    fetchFred('DGS2',8), fetchFred('IRLTLT02DEM156N',5), fetchFred('IRLTLT02GBM156N',5),
    fetchFred('CPIAUCSL',14), fetchFred('CP0000EZ19M086NEST',5),
    fetchFred('GBRCPIALLMINMEI',5), fetchFred('JPNCPIALLMINMEI',5),
    fetchFred('PAYEMS',14),
    fetchJson('https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=10d'),
    fetchFred('DGS10',8), fetchFred('IRLTLT01DEM156N',8),
    fetchFred('DGS2',8), fetchFred('IRLTLT02DEM156N',8),
  ]);

  // CB sazby
  const cb = {
    USD: last(usRate)||FB.cb.USD, EUR: last(eurRate)||FB.cb.EUR,
    GBP: last(gbpRate)||FB.cb.GBP, JPY: last(jpyRate)||FB.cb.JPY,
    CHF: last(chfRate)||FB.cb.CHF, AUD: last(audRate)||FB.cb.AUD,
    CAD: last(cadRate)||FB.cb.CAD, NZD: last(nzdRate)||FB.cb.NZD,
  };

  // 10Y výnosy (aktuální + 3D ago)
  const y10 = {
    USD: last(us10y)||FB.y10.USD, EUR: last(de10y)||FB.y10.EUR,
    GBP: last(gb10y)||FB.y10.GBP, JPY: last(jp10y)||FB.y10.JPY,
    CHF:FB.y10.CHF, AUD:FB.y10.AUD, CAD:FB.y10.CAD, NZD:FB.y10.NZD,
  };
  const y10_3d = {
    USD: (us10y&&us10y.length>=4 ? us10y[us10y.length-4].value : null)||y10.USD,
    EUR: (de10y&&de10y.length>=4 ? de10y[de10y.length-4].value : null)||y10.EUR,
    GBP: (gb10y&&gb10y.length>=4 ? gb10y[gb10y.length-4].value : null)||y10.GBP,
    JPY: (jp10y&&jp10y.length>=4 ? jp10y[jp10y.length-4].value : null)||y10.JPY,
    CHF:y10.CHF, AUD:y10.AUD, CAD:y10.CAD, NZD:y10.NZD,
  };

  // 2Y výnosy + 3D/5D ago z FRED
  const y2 = {
    USD: last(us2y)||FB.y2.USD, EUR: last(de2y)||FB.y2.EUR,
    GBP: last(gb2y)||FB.y2.GBP, JPY:FB.y2.JPY,
    CHF:FB.y2.CHF, AUD:FB.y2.AUD, CAD:FB.y2.CAD, NZD:FB.y2.NZD,
  };
  const y2_3d = {
    USD: (us2y&&us2y.length>=4 ? us2y[us2y.length-4].value : null)||y2.USD,
    EUR: (de2y&&de2y.length>=4 ? de2y[de2y.length-4].value : null)||y2.EUR,
    GBP: (gb2y&&gb2y.length>=4 ? gb2y[gb2y.length-4].value : null)||y2.GBP,
    JPY:y2.JPY, CHF:y2.CHF, AUD:y2.AUD, CAD:y2.CAD, NZD:y2.NZD,
  };
  const y2_5d = {
    USD: (us2y&&us2y.length>=6 ? us2y[us2y.length-6].value : null)||y2.USD,
    EUR: (de2y&&de2y.length>=6 ? de2y[de2y.length-6].value : null)||y2.EUR,
    GBP: (gb2y&&gb2y.length>=6 ? gb2y[gb2y.length-6].value : null)||y2.GBP,
    JPY:y2.JPY, CHF:y2.CHF, AUD:y2.AUD, CAD:y2.CAD, NZD:y2.NZD,
  };

  // FX změny (vs basket)
  const fx3 = {USD:0,EUR:0,GBP:0,JPY:0,CHF:0,AUD:0,CAD:0,NZD:0};
  const fx5 = {USD:0,EUR:0,GBP:0,JPY:0,CHF:0,AUD:0,CAD:0,NZD:0};
  function calcFxChanges(fxRef, fxNow, out) {
    let sum=0,n=0;
    for (const c of ['EUR','GBP','JPY','CHF','AUD','CAD','NZD']) {
      if (fxNow&&fxNow.rates&&fxNow.rates[c]&&fxRef&&fxRef.rates&&fxRef.rates[c]) {
        const chg=(fxRef.rates[c]-fxNow.rates[c])/fxRef.rates[c]*100;
        out[c]=parseFloat(chg.toFixed(3));
        sum+=chg; n++;
      }
    }
    out.USD = n>0 ? parseFloat((-sum/n).toFixed(3)) : 0;
  }
  calcFxChanges(fxPrev, fxNow, fx3);
  calcFxChanges(fx3d, fxNow, fx5);

  // CPI
  function cpiYoy(data, fb) {
    if (data&&data.length>=13) return parseFloat(((data[data.length-1].value/data[data.length-13].value-1)*100).toFixed(2));
    return fb;
  }
  function cpiSample(data, offset, fb) {
    if (data&&data.length>=offset+13) return parseFloat(((data[data.length-1-offset].value/data[data.length-13-offset].value-1)*100).toFixed(2));
    return fb;
  }
  const cpi  = {USD:cpiYoy(usCpi,2.4),EUR:last(eurCpiR)||2.2,GBP:last(gbpCpiR)||2.6,JPY:last(jpyCpiR)||2.9,CHF:0.3,AUD:2.4,CAD:2.3,NZD:2.5};
  const cpi3m= {USD:cpiSample(usCpi,3,cpi.USD),EUR:prev(eurCpiR)||cpi.EUR,GBP:prev(gbpCpiR)||cpi.GBP,JPY:prev(jpyCpiR)||cpi.JPY,CHF:0.5,AUD:2.7,CAD:2.5,NZD:2.7};
  const cpi6m= {USD:cpiSample(usCpi,6,cpi3m.USD),EUR:cpi.EUR,GBP:cpi.GBP,JPY:cpi.JPY,CHF:0.8,AUD:2.9,CAD:2.7,NZD:2.9};
  const tgt  = FB.tgt;

  // VIX
  let vix=18.2, vix5d=18.0;
  try {
    const closes=vixData.chart.result[0].indicators.quote[0].close.filter(v=>v!=null);
    if (closes.length>=5) { vix=parseFloat(closes[closes.length-1].toFixed(2)); vix5d=parseFloat((closes.slice(-5).reduce((a,b)=>a+b)/5).toFixed(2)); }
    else if (closes.length) { vix=parseFloat(closes[closes.length-1].toFixed(2)); vix5d=vix; }
  } catch(e) {}

  // Equity 5D (proxy přes VIX trend - nemáme SPX zdarma v reálném čase)
  const eq5d = vix > vix5d * 1.10 ? -2.5 : vix < vix5d * 0.92 ? +1.5 : 0;

  // ── Sestavení datového objektu ────────────────────────────────────────────
  const D = { cb, y10, y10_3d, y2, y2_3d, y2_5d, cpi, cpi3m, cpi6m, tgt, fx3, fx5, vix, vix5d, eq5d };

  // ── Regime ───────────────────────────────────────────────────────────────
  const regime = classifyRegime(vix, vix5d, eq5d, CCYS.map(c=>y2[c]||0));
  const regW = {
    panic:   CFG.reg_panic,   riskoff: CFG.reg_riskoff,
    neutral: CFG.reg_neutral, carry:   CFG.reg_carry,
  }[regime];
  const mktW = {
    panic:   CFG.mkt_panic,   riskoff: CFG.mkt_riskoff,
    neutral: CFG.mkt_neutral, carry:   CFG.mkt_carry,
  }[regime];

  // ── Měnová skóre ──────────────────────────────────────────────────────────
  const ccyScores = {};
  for (const ccy of CCYS) {
    const s = calcStructural(ccy, D);
    const c = CFG.w_expect * calcExpectations(ccy, D) + CFG.w_cpi * calcCpiScore(ccy, D);
    const m = calcMarket(ccy, D, mktW);
    ccyScores[ccy] = Math.max(-100, Math.min(100, Math.round((s*regW[0]+c*regW[1]+m*regW[2])*50)));
  }

  // ── Pair biases ───────────────────────────────────────────────────────────
  const PAIRS = {
    EURUSD:['EUR','USD'],GBPUSD:['GBP','USD'],USDJPY:['USD','JPY'],
    USDCHF:['USD','CHF'],AUDUSD:['AUD','USD'],USDCAD:['USD','CAD'],
    NZDUSD:['NZD','USD'],EURGBP:['EUR','GBP'],EURJPY:['EUR','JPY'],
    EURCHF:['EUR','CHF'],EURAUD:['EUR','AUD'],EURCAD:['EUR','CAD'],
    GBPJPY:['GBP','JPY'],GBPAUD:['GBP','AUD'],AUDJPY:['AUD','JPY'],
    CADJPY:['CAD','JPY'],NZDJPY:['NZD','JPY'],
  };
  const pairBiases = {};
  for (const [sym,[a,b]] of Object.entries(PAIRS)) pairBiases[sym] = calcPairBias(a,b,ccyScores,D);

  // Zlato (inverzní k USD + výnosům)
  const goldDiff = -ccyScores.USD*0.65 - (y10.USD-4.0)*30 + (vix>25?20:0);
  const gBull = 1/(1+Math.exp(-goldDiff*CFG.sigmoid_k));
  const goldBias = { bias:gBull>0.60?'Bullish':(1-gBull)>0.60?'Bearish':'Neutral',
    bull:Math.round(gBull*100),bear:Math.round((1-gBull)*100),
    conf:Math.min(5,Math.max(1,Math.round(Math.abs(goldDiff)/12))),score_diff:Math.round(goldDiff),
    conf_txt:Math.abs(goldDiff)>30?'Strong':Math.abs(goldDiff)>15?'Moderate':'Weak',
    drivers:['USD strength','US 10Y yields','Risk sentiment'] };
  pairBiases.XAUUSD=goldBias;
  pairBiases.XAGUSD={...goldBias,bull:Math.min(100,goldBias.bull-3),bear:Math.min(100,goldBias.bear+3)};

  // US CPI/NFP
  let cpiSurprise=-0.2,nfpActual=228,nfpConsensus=140,nfpSurprise=88;
  if (usCpi&&usCpi.length>=13) {
    const yoy=i=>(usCpi[i].value/usCpi[i-12].value-1)*100;
    const latest=yoy(usCpi.length-1);
    const trend=[yoy(usCpi.length-4),yoy(usCpi.length-3),yoy(usCpi.length-2)];
    cpiSurprise=parseFloat((latest-trend.reduce((a,b)=>a+b)/3).toFixed(2));
  }
  if (usNfp&&usNfp.length>=2) {
    const d=usNfp.slice(1).map((r,i)=>Math.round(r.value-usNfp[i].value));
    nfpActual=d[d.length-1]; const p6=d.slice(-7,-1);
    nfpConsensus=Math.round(p6.reduce((a,b)=>a+b)/p6.length);
    nfpSurprise=nfpActual-nfpConsensus;
  }

  const rates=fxNow&&fxNow.rates?fxNow.rates:{};
  const dxyCh = fx3.USD||0;
  const sorted=Object.entries(ccyScores).sort((a,b)=>b[1]-a[1]);

  return {
    statusCode:200,
    headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Cache-Control':'public, max-age=1800'},
    body: JSON.stringify({
      currency_scores: ccyScores,
      cb_rates: cb, yields_10y: y10, yields_2y: y2,
      strong_ccys: sorted.filter(([,v])=>v>15).map(([k])=>k),
      weak_ccys:   sorted.filter(([,v])=>v<-15).map(([k])=>k),
      pair_biases: pairBiases,
      market_regime: regime,
      vix, vix5d, dxy_change: dxyCh,
      yields10y: y10.USD, yields10y_prev: prev(us10y)||y10.USD,
      cpi_actual: cpi.USD, cpi_surprise: cpiSurprise,
      nfp_actual: nfpActual, nfp_consensus: nfpConsensus, nfp_surprise: nfpSurprise,
      rates,
      sources: {
        engine: 'Poor Mans OIS v4: structural+cyclical(expectations+CPI)+market',
        ois: 'Rate gap + Repricing 3D/5D (FRED 2Y yields) with confirmation filter',
        cb_rates: 'FRED: FEDFUNDS,ECBDFR,BOERUKQ,BoJ,SNB,RBA,BoC,RBNZ',
        yields: 'FRED: DGS10,DGS2,DE/GB/JP 10Y+2Y',
        fx: 'Frankfurter (ECB)',vix: 'Yahoo Finance ^VIX',
        limitation: 'Missing: OIS curves, rate futures, Bloomberg consensus, PMI realtime',
      },
      fetched_at: new Date().toISOString(),
    }),
  };
};
