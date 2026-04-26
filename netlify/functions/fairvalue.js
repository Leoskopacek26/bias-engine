// Netlify Function: fair value calculator
// ─────────────────────────────────────────────────────────────────────────────
// METODIKA:
//   AKCIE:   weighted blend DCF (40%) + sector-PE (30%) + PEG (20%) + P/B (10%)
//   ETF:     P/E vs sector medián + dividend yield + expense ratio penalty
//   KRYPTO:  200-DMA jako "fair" (Bitcoin Mayer Multiple proxy)
//
// ZDROJE:
//   FMP (Financial Modeling Prep) — primární, free tier 250 req/den
//   API klíč: https://site.financialmodelingprep.com/developer/docs
//   Předáváš ho jako ?fmpKey= v query nebo přes env FMP_KEY
//
// VRACÍ:
//   { results: { TICKER: { price, fairValue, diffPct, status, type, breakdown, reason, data, error? } }
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BiasEngine-FairValue/1.0)',
        'Accept': 'application/json',
      },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(new Error('timeout')); });
  });
}

async function fetchJson(url) {
  try {
    const r = await httpsGet(url);
    if (r.statusCode >= 200 && r.statusCode < 300) {
      try { return JSON.parse(r.body); } catch (e) { return null; }
    }
    return null;
  } catch (e) { return null; }
}

// ── FMP endpoints ────────────────────────────────────────────────────────────
const FMP = 'https://financialmodelingprep.com/api/v3';

async function fmpFetch(path, key) {
  const sep = path.includes('?') ? '&' : '?';
  const data = await fetchJson(`${FMP}${path}${sep}apikey=${encodeURIComponent(key)}`);
  return Array.isArray(data) ? data : (data || null);
}

// ── Sector P/E benchmarks (S&P 500 dlouhodobé mediány, fallback když chybí) ──
const SECTOR_PE = {
  'Technology':            28,
  'Communication Services':22,
  'Consumer Cyclical':     20,
  'Consumer Defensive':    18,
  'Financial Services':    14,
  'Healthcare':            22,
  'Energy':                12,
  'Industrials':           19,
  'Real Estate':           25,
  'Utilities':             17,
  'Basic Materials':       15,
};
const DEFAULT_PE = 18;

function classify(diffPct) {
  if (diffPct >= 15)  return 'UNDERVALUED';
  if (diffPct <= -15) return 'OVERVALUED';
  return 'FAIR';
}

// ── Crypto detekce ───────────────────────────────────────────────────────────
const CRYPTO_TICKERS = new Set(['BTCUSD', 'ETHUSD', 'BTC-USD', 'ETH-USD']);
function isCrypto(ticker) {
  return CRYPTO_TICKERS.has(ticker.toUpperCase());
}

// ── Crypto fair value: 200-DMA (Mayer Multiple koncept) ──────────────────────
// "Mayer Multiple" = price / 200-DMA. 1.0 = fair, <1.0 undervalued, >2.4 historically OB
async function valueCrypto(ticker, debug) {
  const pair = ticker.toUpperCase().replace('-', '');
  const bybitSym = pair === 'BTCUSD' ? 'BTCUSDT' : 'ETHUSDT';
  // Bybit denní svíčky, 250 dní zpětně
  const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${bybitSym}&interval=D&limit=210`;
  const data = await fetchJson(url);
  if (!data || data.retCode !== 0 || !data.result || !Array.isArray(data.result.list)) {
    return { error: 'Bybit data nedostupná', type: 'crypto' };
  }
  // DESC → reverse to ASC
  const closes = data.result.list.map(k => parseFloat(k[4])).filter(v => !isNaN(v) && v > 0).reverse();
  if (closes.length < 50) return { error: `Málo dat (${closes.length})`, type: 'crypto' };
  const price = closes[closes.length - 1];
  const period = Math.min(200, closes.length - 1);
  const dma = closes.slice(-period).reduce((a, b) => a + b, 0) / period;
  const diffPct = ((price - dma) / dma) * 100;
  // Pro crypto invertujeme: cena pod DMA = undervalued
  // Mayer Multiple = price / DMA. Fair = 1.0. >1.4 = OB, <0.8 = OS.
  const mayerMultiple = price / dma;
  let status;
  if      (mayerMultiple < 0.85) status = 'UNDERVALUED';
  else if (mayerMultiple > 1.30) status = 'OVERVALUED';
  else                            status = 'FAIR';
  debug.push(`[${ticker}] crypto: price=${price.toFixed(2)} 200DMA=${dma.toFixed(2)} mayer=${mayerMultiple.toFixed(2)} → ${status}`);
  return {
    type: 'crypto',
    price, fairValue: dma,
    diffPct: ((dma - price) / price) * 100,  // pozitivní = undervalued
    status,
    breakdown: { '200-DMA': dma, mayerMultiple: +mayerMultiple.toFixed(2) },
    reason: `Mayer Multiple ${mayerMultiple.toFixed(2)} (price/200DMA). <0.85 = undervalued, >1.30 = overvalued.`,
  };
}

// ── Akcie: weighted blend DCF + PE + PEG + P/B ──────────────────────────────
function valueStock(profile, quote, ratios, metrics, growth, dcf, debug, ticker) {
  const price   = quote?.price ?? null;
  const eps     = quote?.eps ?? ratios?.netIncomePerShareTTM ?? null;
  const peTtm   = ratios?.peRatioTTM ?? quote?.pe ?? null;
  const pegTtm  = ratios?.pegRatioTTM ?? null;
  const pbTtm   = ratios?.priceToBookRatioTTM ?? null;
  const psTtm   = ratios?.priceToSalesRatioTTM ?? null;
  const debt2eq = ratios?.debtEquityRatioTTM ?? null;
  const fcfPS   = metrics?.freeCashFlowPerShareTTM ?? null;
  const bookPS  = metrics?.bookValuePerShareTTM ?? null;
  const revGrowth = growth?.revenueGrowth ?? null;
  const epsGrowth = growth?.epsgrowth ?? growth?.epsGrowth ?? null;
  const dcfVal  = dcf?.dcf ?? dcf?.['Discounted Cash Flow'] ?? null;
  const sector  = profile?.sector ?? 'Default';
  const sectorPE = SECTOR_PE[sector] ?? DEFAULT_PE;

  if (!price) {
    return { error: 'Chybí cena', type: 'stock', data: { sector } };
  }

  const components = [];

  // 1. DCF (50 %) — primární metoda když je dostupná
  if (dcfVal && dcfVal > 0) {
    components.push({ method: 'DCF', value: dcfVal, weight: 0.50 });
  }

  // 2. Sector P/E target (30 %)
  if (eps && eps > 0) {
    const peTarget = eps * sectorPE;
    components.push({ method: `Sector P/E (${sector}, ${sectorPE})`, value: peTarget, weight: 0.30 });
  }

  // 3. PEG-adjusted: fair value = EPS × growth_pct × 1 (PEG=1 = fair) (15 %)
  if (eps && eps > 0 && epsGrowth != null) {
    const growthPct = epsGrowth * 100;
    if (growthPct > 0 && growthPct < 50) {  // ignoruj nereálné růsty
      const pegTarget = eps * growthPct;  // PE = growth
      components.push({ method: `PEG (EPS×growth ${growthPct.toFixed(1)}%)`, value: pegTarget, weight: 0.15 });
    }
  }

  // 4. P/B sanity (5 %, jen když je smysluplné — book value × multiplier do 50 % aktuální ceny)
  // Pro tech/growth firmy je book value často mizivé a P/B kalkulace by zkreslila výsledek
  if (bookPS && bookPS > 0) {
    const pbMultiple = sector === 'Technology' ? 6.0 : sector === 'Financial Services' ? 1.3 : 2.5;
    const pbValue = bookPS * pbMultiple;
    // Zahrň P/B JEN pokud výsledná hodnota je v rozumném rozsahu (50 %–200 % ceny)
    // Jinak je to artefakt nízkého/vysokého book value, ne signál férové ceny
    if (pbValue >= price * 0.5 && pbValue <= price * 2.0) {
      components.push({ method: `Book Value × ${pbMultiple}`, value: pbValue, weight: 0.05 });
    }
  }

  // 5. FCF yield (5 %, pokud máme): FCF/share × inverzní yield 6 % (= 16.6× FCF)
  if (fcfPS && fcfPS > 0) {
    const fcfTarget = fcfPS * 16.6;
    components.push({ method: `FCF × 16.6 (~6 % yield)`, value: fcfTarget, weight: 0.05 });
  }

  if (!components.length) {
    return {
      type: 'stock',
      price,
      error: 'Nedostatek dat pro výpočet (chybí EPS, DCF, book value)',
      data: { sector, peTtm, pbTtm },
    };
  }

  // Re-normalizace vah
  const totalWeight = components.reduce((s, c) => s + c.weight, 0);
  const fairValue = components.reduce((s, c) => s + (c.value * c.weight), 0) / totalWeight;
  const diffPct = ((fairValue - price) / price) * 100;
  const status = classify(diffPct);

  // Důvod
  const reasons = [];
  if (peTtm && sectorPE)   reasons.push(`P/E ${peTtm.toFixed(1)} vs ${sector} sektor ~${sectorPE}`);
  if (revGrowth != null)   reasons.push(`tržby YoY ${(revGrowth * 100).toFixed(1)}%`);
  if (epsGrowth != null)   reasons.push(`EPS YoY ${(epsGrowth * 100).toFixed(1)}%`);
  if (debt2eq != null)     reasons.push(`debt/equity ${debt2eq.toFixed(2)}`);
  if (fcfPS != null)       reasons.push(`FCF/share ${fcfPS.toFixed(2)}`);

  debug.push(`[${ticker}] stock ${sector}: price=${price} fair=${fairValue.toFixed(2)} diff=${diffPct.toFixed(1)}% → ${status} | ${components.map(c => c.method + '=' + c.value.toFixed(2)).join(', ')}`);

  return {
    type: 'stock',
    price,
    fairValue: +fairValue.toFixed(2),
    diffPct: +diffPct.toFixed(1),
    status,
    breakdown: components.map(c => ({ method: c.method, value: +c.value.toFixed(2), weight: c.weight })),
    reason: reasons.join(' · '),
    data: { sector, peTtm, pegTtm, pbTtm, psTtm, debt2eq, fcfPS, revGrowth, epsGrowth, dcfVal, eps },
  };
}

// ── ETF: P/E vs market + dividend yield + expense ratio ─────────────────────
function valueETF(profile, quote, etfInfo, debug, ticker) {
  const price = quote?.price ?? null;
  const peEtf = quote?.pe ?? null;  // P/E vážený přes holdings (pokud FMP počítá)
  const yieldPct = etfInfo?.dividendYield ?? null;
  const expense = etfInfo?.expenseRatio ?? null;
  const aum = etfInfo?.aum ?? null;

  if (!price) return { type: 'etf', error: 'Chybí cena' };

  // Pro ETF: pokud máme P/E, srovnáme s market 18
  // Pokud máme yield, započítáme bonus za vyšší dividend
  let fairScore = 0;  // -1 = overvalued, 0 = fair, +1 = undervalued

  if (peEtf && peEtf > 0) {
    if (peEtf < 14)      fairScore += 0.5;
    else if (peEtf < 18) fairScore += 0.2;
    else if (peEtf > 25) fairScore -= 0.5;
    else if (peEtf > 21) fairScore -= 0.2;
  }
  if (yieldPct != null) {
    if (yieldPct > 0.04) fairScore += 0.3;   // >4% yield = příjmově atraktivní
    else if (yieldPct > 0.02) fairScore += 0.1;
  }
  if (expense != null) {
    if (expense > 0.0075) fairScore -= 0.2;  // drahý ETF = penalizuj
    else if (expense < 0.0010) fairScore += 0.1;
  }

  // Konverze score na implied fair value (max score ~1.0 → ±25 % range)
  const fairMultiplier = 1 + (fairScore * 0.25);
  const fairValue = price * fairMultiplier;
  const diffPct = (fairScore * 25);  // přímé mapování score → %
  const status = classify(diffPct);

  const parts = [];
  if (peEtf)    parts.push(`P/E ${peEtf.toFixed(1)}`);
  if (yieldPct) parts.push(`yield ${(yieldPct * 100).toFixed(2)}%`);
  if (expense)  parts.push(`expense ${(expense * 100).toFixed(2)}%`);

  debug.push(`[${ticker}] ETF: price=${price} score=${fairScore.toFixed(2)} fair=${fairValue.toFixed(2)} → ${status}`);

  return {
    type: 'etf',
    price,
    fairValue: +fairValue.toFixed(2),
    diffPct: +diffPct.toFixed(1),
    status,
    breakdown: { fairScore: +fairScore.toFixed(2), peEtf, yieldPct, expense, aum },
    reason: parts.join(' · ') || 'omezená data — orientační',
  };
}

// ── Per-ticker pipeline ──────────────────────────────────────────────────────
async function valueOne(ticker, fmpKey, debug) {
  if (isCrypto(ticker)) {
    return await valueCrypto(ticker, debug);
  }
  if (!fmpKey) {
    return { error: 'Chybí FMP API klíč', type: 'unknown' };
  }
  // Profil rozhodne stock vs ETF
  const profileArr = await fmpFetch(`/profile/${ticker}`, fmpKey);
  const profile = Array.isArray(profileArr) ? profileArr[0] : profileArr;
  if (!profile) {
    return { error: 'Ticker nenalezen ve FMP', type: 'unknown' };
  }
  const quoteArr = await fmpFetch(`/quote/${ticker}`, fmpKey);
  const quote = Array.isArray(quoteArr) ? quoteArr[0] : quoteArr;

  if (profile.isEtf || profile.isFund) {
    const etfInfoArr = await fmpFetch(`/etf-info?symbol=${ticker}`, fmpKey);
    const etfInfo = Array.isArray(etfInfoArr) ? etfInfoArr[0] : etfInfoArr;
    return valueETF(profile, quote, etfInfo, debug, ticker);
  }

  // Akcie: pull ratios + metrics + growth + DCF paralelně
  const [ratiosArr, metricsArr, growthArr, dcfArr] = await Promise.all([
    fmpFetch(`/ratios-ttm/${ticker}`, fmpKey),
    fmpFetch(`/key-metrics-ttm/${ticker}`, fmpKey),
    fmpFetch(`/financial-growth/${ticker}?limit=1`, fmpKey),
    fmpFetch(`/discounted-cash-flow/${ticker}`, fmpKey),
  ]);
  const ratios = Array.isArray(ratiosArr) ? ratiosArr[0] : ratiosArr;
  const metrics = Array.isArray(metricsArr) ? metricsArr[0] : metricsArr;
  const growth = Array.isArray(growthArr) ? growthArr[0] : growthArr;
  const dcf = Array.isArray(dcfArr) ? dcfArr[0] : dcfArr;
  return valueStock(profile, quote, ratios, metrics, growth, dcf, debug, ticker);
}

// ── Handler ──────────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  const qs = (event && event.queryStringParameters) || {};
  const tickers = (qs.tickers || qs.ticker || '')
    .split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
  const fmpKey = qs.fmpKey || process.env.FMP_KEY || '';
  const debug = [];
  const fetchedAt = new Date().toISOString();

  if (!tickers.length) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Missing ?tickers=AAPL,MSFT,...' }),
    };
  }

  console.log(`\n=== FAIR VALUE RUN (${tickers.length} tickerů) ===`);
  console.log(`FMP key: ${fmpKey ? 'YES (' + fmpKey.slice(0, 6) + '…)' : 'NO'}`);

  const t0 = Date.now();
  // Pro výkon: chunk po 6 paralelně (FMP free tier nemá rate limit per-min, ale buďme slušní)
  const results = {};
  const CHUNK = 6;
  for (let i = 0; i < tickers.length; i += CHUNK) {
    const batch = tickers.slice(i, i + CHUNK);
    const out = await Promise.all(batch.map(async t => {
      try {
        const r = await valueOne(t, fmpKey, debug);
        return [t, r];
      } catch (e) {
        debug.push(`[${t}] ERR: ${e.message}`);
        return [t, { error: e.message, type: 'error' }];
      }
    }));
    for (const [t, r] of out) results[t] = r;
  }
  const ms = Date.now() - t0;

  // Statistika
  const stats = { undervalued: 0, fair: 0, overvalued: 0, errors: 0 };
  for (const r of Object.values(results)) {
    if (r.error) stats.errors++;
    else if (r.status === 'UNDERVALUED') stats.undervalued++;
    else if (r.status === 'OVERVALUED')  stats.overvalued++;
    else                                  stats.fair++;
  }
  console.log(`Stats: U=${stats.undervalued} F=${stats.fair} O=${stats.overvalued} ERR=${stats.errors} | ${ms}ms`);
  for (const line of debug) console.log(line);

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=900',  // 15 min cache
    },
    body: JSON.stringify({
      results,
      stats,
      tickers,
      fmpKeyUsed: !!fmpKey,
      ms,
      debug: debug.slice(-300),
      fetched_at: fetchedAt,
    }),
  };
};
