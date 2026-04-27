// ─────────────────────────────────────────────────────────────────────────────
// Fair value calculation layer — ČISTÉ FUNKCE
// ─────────────────────────────────────────────────────────────────────────────
// Žádné HTTP volání, žádné externí závislosti.
// Vstup: NormalizedFundamentals (z lib/normalize.js)
// Výstup: { fairValue, upsidePct, status, confidence, method, explanation, debug }
// ─────────────────────────────────────────────────────────────────────────────

// ── Pomocníci ───────────────────────────────────────────────────────────────
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function pct(n)   { return Math.round(n * 10) / 10; }   // 1 desetinné
function rnd2(n)  { return Math.round(n * 100) / 100; } // 2 desetinná

// ── A) Fair P/E podle růstu (procenta) ──────────────────────────────────────
function getFairPE(growthPct) {
  if (!isNum(growthPct))      return 14;   // neutrální fallback
  if (growthPct <= 0)         return 10;
  if (growthPct <= 5)         return 13;
  if (growthPct <= 15)        return 18;
  if (growthPct <= 30)        return 26;
  return 35;
}

// ── B) Fair FCF multiple podle kvality ──────────────────────────────────────
// quality: 'weak' | 'stable' | 'growth'
function getFairFcfMultiple(quality) {
  if (quality === 'weak')   return 14;
  if (quality === 'growth') return 30;
  return 22;  // stable default
}

function inferQuality(n) {
  // růstová: vysoký growth + vysoká marže
  if (isNum(n.revenueGrowth) && n.revenueGrowth > 15 &&
      isNum(n.netMargin)     && n.netMargin     > 15) return 'growth';
  // slabá: záporný growth nebo vysoký dluh
  if ((isNum(n.revenueGrowth) && n.revenueGrowth < 0) ||
      (isNum(n.netMargin)     && n.netMargin     < 5) ||
      (isNum(n.debtToEquity)  && n.debtToEquity  > 3)) return 'weak';
  return 'stable';
}

// ── C) Quality multiplier podle marží, růstu, dluhu ─────────────────────────
function qualityMultiplier(n) {
  let m = 1.0;
  const detail = [];

  // Pozitivní
  if (isNum(n.netMargin) && n.netMargin > 20)         { m += 0.10; detail.push(`+0.10 net margin ${pct(n.netMargin)}%`); }
  if (isNum(n.grossMargin) && n.grossMargin > 50)     { m += 0.05; detail.push(`+0.05 gross margin ${pct(n.grossMargin)}%`); }
  if (isNum(n.operatingMargin) && n.operatingMargin > 20) { m += 0.05; detail.push(`+0.05 op margin ${pct(n.operatingMargin)}%`); }
  if (isNum(n.revenueGrowth) && n.revenueGrowth > 15) { m += 0.05; detail.push(`+0.05 rev growth ${pct(n.revenueGrowth)}%`); }
  if (isNum(n.epsGrowth) && n.epsGrowth > 15)         { m += 0.05; detail.push(`+0.05 eps growth ${pct(n.epsGrowth)}%`); }

  // Negativní
  if (isNum(n.debtToEquity) && n.debtToEquity > 4)    { m -= 0.25; detail.push(`-0.25 debt/eq ${rnd2(n.debtToEquity)}`); }
  else if (isNum(n.debtToEquity) && n.debtToEquity > 2) { m -= 0.15; detail.push(`-0.15 debt/eq ${rnd2(n.debtToEquity)}`); }
  if (isNum(n.netMargin) && n.netMargin < 5)          { m -= 0.10; detail.push(`-0.10 net margin ${pct(n.netMargin)}%`); }
  if (isNum(n.revenueGrowth) && n.revenueGrowth < 0)  { m -= 0.10; detail.push(`-0.10 rev growth ${pct(n.revenueGrowth)}%`); }
  if (isNum(n.epsGrowth) && n.epsGrowth < 0)          { m -= 0.10; detail.push(`-0.10 eps growth ${pct(n.epsGrowth)}%`); }

  // Cap
  if (m < 0.65) m = 0.65;
  if (m > 1.30) m = 1.30;

  return { multiplier: rnd2(m), detail };
}

// ── D) Klasifikace upside ──────────────────────────────────────────────────
function classify(upsidePct) {
  if (!isNum(upsidePct)) return 'N/A';
  if (upsidePct > 15)    return 'UNDERVALUED';
  if (upsidePct < -15)   return 'OVERVALUED';
  return 'FAIR';
}

// ── E) Hlavní valuace pro AKCIE ─────────────────────────────────────────────
function valueStock(n) {
  const debug = [];
  const result = {
    symbol: n.symbol,
    type: 'stock',
    price: n.price,
    fairValue: null,
    upsidePct: null,
    status: 'N/A',
    confidence: 'N/A',
    method: null,
    explanation: '',
    debug,
  };

  if (!isNum(n.price) || n.price <= 0) {
    result.explanation = 'Chybí platná cena';
    return result;
  }

  // Růst: preferuj EPS growth, fallback rev growth
  const growth = isNum(n.epsGrowth) ? n.epsGrowth :
                 isNum(n.revenueGrowth) ? n.revenueGrowth : null;
  const growthSource = isNum(n.epsGrowth) ? 'eps' :
                       isNum(n.revenueGrowth) ? 'revenue' : 'none';
  debug.push(`growth: ${growth === null ? 'N/A' : pct(growth) + '%'} (${growthSource})`);

  // Quality multiplier
  const q = qualityMultiplier(n);
  debug.push(`qualityMultiplier: ${q.multiplier} [${q.detail.join(', ') || 'baseline'}]`);

  // ── Earnings model ──────────────────────────────────────────────────────
  let earningsFair = null;
  if (isNum(n.epsTtm) && n.epsTtm > 0) {
    const fairPE = getFairPE(growth);
    const baseValue = n.epsTtm * fairPE;
    earningsFair = baseValue * q.multiplier;
    debug.push(`earnings: EPS ${rnd2(n.epsTtm)} × fairPE ${fairPE} × quality ${q.multiplier} = ${rnd2(earningsFair)}`);
  } else if (isNum(n.epsTtm) && n.epsTtm <= 0) {
    debug.push(`earnings: SKIP (záporný EPS ${rnd2(n.epsTtm)})`);
  } else {
    debug.push(`earnings: SKIP (chybí EPS)`);
  }

  // ── FCF model ───────────────────────────────────────────────────────────
  let fcfFair = null;
  if (isNum(n.fcfPerShare) && n.fcfPerShare > 0) {
    const quality = inferQuality(n);
    const fairMul = getFairFcfMultiple(quality);
    const baseValue = n.fcfPerShare * fairMul;
    fcfFair = baseValue * q.multiplier;
    debug.push(`fcf: FCF/sh ${rnd2(n.fcfPerShare)} × ${fairMul} (${quality}) × ${q.multiplier} = ${rnd2(fcfFair)}`);
  } else {
    debug.push(`fcf: SKIP (chybí nebo <=0)`);
  }

  // ── Blend ──────────────────────────────────────────────────────────────
  let fairValue = null;
  let method = null;
  let confidence = 'N/A';

  if (isNum(earningsFair) && isNum(fcfFair)) {
    fairValue = earningsFair * 0.7 + fcfFair * 0.3;
    method = 'earnings(70%) + fcf(30%)';
  } else if (isNum(earningsFair)) {
    fairValue = earningsFair;
    method = 'earnings';
  } else if (isNum(fcfFair)) {
    fairValue = fcfFair;
    method = 'fcf';
  } else {
    result.explanation = 'Chybí EPS i FCF — fair value nelze spočítat';
    return result;
  }

  // ── Sanity check: P/E nesmí výrazně převyšovat fairPE pokud je earnings model jediný ──
  if (method === 'earnings' && isNum(n.peTtm) && isNum(growth)) {
    const fairPE = getFairPE(growth);
    if (n.peTtm > fairPE * 2.5) {
      // P/E je 2.5× nad férovým → výsledek nesmí být UNDERVALUED, kapneme fair value na price
      const cappedFv = Math.min(fairValue, n.price * 1.10);
      if (cappedFv !== fairValue) {
        debug.push(`sanity: P/E ${rnd2(n.peTtm)} >> fairPE ${fairPE} → cap fairValue ${rnd2(fairValue)} → ${rnd2(cappedFv)}`);
        fairValue = cappedFv;
      }
    }
  }

  // ── Confidence ─────────────────────────────────────────────────────────
  // HIGH: EPS + growth + margins + debt
  // MEDIUM: EPS + growth
  // LOW: jen jeden model
  const hasEps     = isNum(n.epsTtm) && n.epsTtm > 0;
  const hasGrowth  = isNum(growth);
  const hasMargins = isNum(n.netMargin) && isNum(n.grossMargin);
  const hasDebt    = isNum(n.debtToEquity);

  if (hasEps && hasGrowth && hasMargins && hasDebt) confidence = 'HIGH';
  else if (hasEps && hasGrowth)                     confidence = 'MEDIUM';
  else                                               confidence = 'LOW';

  const upsidePct = ((fairValue - n.price) / n.price) * 100;

  result.fairValue = rnd2(fairValue);
  result.upsidePct = pct(upsidePct);
  result.status = classify(upsidePct);
  result.confidence = confidence;
  result.method = method;

  // Lidský explanation
  const parts = [];
  if (isNum(n.epsTtm)) parts.push(`EPS ${rnd2(n.epsTtm)}`);
  if (isNum(growth))   parts.push(`growth ${pct(growth)}% (${growthSource})`);
  if (isNum(n.peTtm))  parts.push(`P/E ${rnd2(n.peTtm)}`);
  if (isNum(n.netMargin)) parts.push(`net margin ${pct(n.netMargin)}%`);
  if (isNum(n.debtToEquity)) parts.push(`D/E ${rnd2(n.debtToEquity)}`);
  result.explanation = parts.join(' · ');

  return result;
}

// ── F) ETF: vrací jen pokud je dostupné expense ratio + yield ──────────────
// Bez těchto dat radši N/A než falešná férovka.
function valueETF(n) {
  const result = {
    symbol: n.symbol,
    type: 'etf',
    price: n.price,
    fairValue: null,
    upsidePct: null,
    status: 'N/A',
    confidence: 'N/A',
    method: 'etf-no-data',
    explanation: 'ETF — Finnhub free tier nemá ETF expense ratio ani holdings; fair value nelze spočítat',
    debug: ['ETF detected, no fundamental data available'],
  };
  if (!isNum(n.price)) {
    result.explanation = 'Chybí cena';
    return result;
  }
  return result;
}

// ── G) Crypto: vždy N/A (nemá smysl fundamentální férovka) ────────────────
function valueCrypto(n) {
  return {
    symbol: n.symbol,
    type: 'crypto',
    price: n.price,
    fairValue: null,
    upsidePct: null,
    status: 'N/A',
    confidence: 'N/A',
    method: 'crypto-no-fundamentals',
    explanation: 'Krypto nemá fundamentální férovku (žádné EPS, FCF, dividendy). Pro hodnocení použij technickou analýzu.',
    debug: ['crypto → fair value not applicable'],
  };
}

// ── Hlavní routing ─────────────────────────────────────────────────────────
function valueOne(normalized) {
  if (!normalized || !normalized.symbol) {
    return { error: 'Invalid input', status: 'N/A' };
  }
  switch (normalized.type) {
    case 'crypto': return valueCrypto(normalized);
    case 'etf':    return valueETF(normalized);
    case 'stock':  return valueStock(normalized);
    default:
      return {
        symbol: normalized.symbol,
        type: normalized.type || 'unknown',
        price: normalized.price,
        fairValue: null,
        upsidePct: null,
        status: 'N/A',
        confidence: 'N/A',
        method: null,
        explanation: `Neznámý typ instrumentu: ${normalized.type}`,
        debug: [],
      };
  }
}

module.exports = {
  getFairPE,
  getFairFcfMultiple,
  qualityMultiplier,
  inferQuality,
  classify,
  valueStock,
  valueETF,
  valueCrypto,
  valueOne,
};
