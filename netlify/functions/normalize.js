// ─────────────────────────────────────────────────────────────────────────────
// Normalizace: SEC EDGAR (primary) + Yahoo (price) + Finnhub (optional) →
//              NormalizedFundamentals
// ─────────────────────────────────────────────────────────────────────────────
// Principy:
//  - null pro chybějící, ne 0
//  - procenta vždy v percentech (12 = 12%, ne 0.12)
//  - validace price > 0
//  - prioritní mergování: SEC > Finnhub > Yahoo (pro každé pole zvlášť)
// ─────────────────────────────────────────────────────────────────────────────

const CRYPTO_TICKERS = new Set([
  'BTCUSD', 'ETHUSD', 'BTC-USD', 'ETH-USD', 'BTCUSDT', 'ETHUSDT',
  'XBTUSD', 'XETHUSD',
]);

function isCryptoTicker(symbol) {
  const s = (symbol || '').toUpperCase();
  if (CRYPTO_TICKERS.has(s)) return true;
  if (/^(BTC|ETH|XRP|SOL|ADA|DOGE|DOT|MATIC|AVAX|LINK)[\-]?USD[T]?$/.test(s)) return true;
  return false;
}

function safeNum(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n;
}

function toPercent(v) {
  const n = safeNum(v);
  if (n === null) return null;
  if (Math.abs(n) < 1) return n * 100;
  return n;
}

// First non-null helper
function pick(...vals) {
  for (const v of vals) if (v !== null && v !== undefined) return v;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hlavní normalizace
// ─────────────────────────────────────────────────────────────────────────────
//
// Vstupy:
//   symbol     : "AAPL"
//   priceData  : výstup price.fetchPrice() → data
//                { price, currency, type, source, fiftyTwoWeekHigh, ... }
//   secData    : výstup sec-edgar.fetchFundamentals() → data
//                { revenue, epsTtm, fcf, fcfPerShare, debtToEquity, margins, ... }
//   fhMetrics  : OPTIONAL — Finnhub metric obj (fallback when SEC chybí)
//   fhProfile  : OPTIONAL — Finnhub profile (jen meta info)
//
function normalize({ symbol, priceData, secData, fhMetrics, fhProfile }) {
  const s = (symbol || '').toUpperCase();

  // ── 1. Type detekce ──────────────────────────────────────────────────────
  let type = 'unknown';
  if (isCryptoTicker(s)) {
    type = 'crypto';
  } else if (priceData?.type && priceData.type !== 'unknown') {
    type = priceData.type;
  } else if (secData) {
    type = 'stock';   // SEC pokrývá jen veřejné firmy (≈ stock)
  } else if (fhProfile?.ticker) {
    type = 'stock';
  }

  // ── 2. Cena (z price aggregátoru) ────────────────────────────────────────
  const price = safeNum(priceData?.price);
  const priceValid = price && price > 0;

  // ── 3. Meta info ─────────────────────────────────────────────────────────
  const currency = pick(priceData?.currency, fhProfile?.currency, 'USD');
  const exchange = pick(priceData?.exchange, fhProfile?.exchange);
  const name     = pick(secData?.name, fhProfile?.name, secData?.entityName);
  const industry = pick(secData?.sicDescription, fhProfile?.finnhubIndustry);
  const marketCap = safeNum(fhProfile?.marketCapitalization); // v milionech USD

  // ── 4. Fundamentals — priorita SEC > Finnhub ─────────────────────────────
  const m = fhMetrics || {};
  const sec = secData || {};

  // EPS TTM
  const epsTtm = safeNum(pick(
    sec.epsTtm,
    m.epsTTM, m['epsBasicExclExtraItemsTTM'], m['epsInclExtraItemsTTM'], m.epsAnnual
  ));

  // P/E TTM (počítané z price/EPS pokud SEC poskytne EPS)
  let peTtm = null;
  if (priceValid && epsTtm && epsTtm > 0) {
    peTtm = price / epsTtm;
  } else {
    peTtm = safeNum(pick(m.peTTM, m.peExclExtraTTM, m.peAnnual));
  }

  // P/S TTM (z price × shares / revenue)
  let psTtm = null;
  if (priceValid && sec.revenue && sec.sharesOutstanding && sec.revenue > 0) {
    psTtm = (price * sec.sharesOutstanding) / sec.revenue;
  } else {
    psTtm = safeNum(pick(m.psTTM, m.psAnnual));
  }

  // P/B (z price × shares / equity)
  let pb = null;
  if (priceValid && sec.equity && sec.sharesOutstanding && sec.equity > 0) {
    pb = (price * sec.sharesOutstanding) / sec.equity;
  } else {
    pb = safeNum(pick(m.pbAnnual, m.pbQuarterly));
  }

  // Margins (SEC v %, Finnhub v % nebo decimal)
  const grossMargin = safeNum(pick(
    sec.grossMargin,
    toPercent(m.grossMarginTTM ?? m.grossMarginAnnual)
  ));
  const operatingMargin = safeNum(pick(
    sec.operatingMargin,
    toPercent(m.operatingMarginTTM ?? m.operatingMarginAnnual)
  ));
  const netMargin = safeNum(pick(
    sec.netMargin,
    toPercent(m.netProfitMarginTTM ?? m.netProfitMarginAnnual)
  ));

  // Růsty (v %)
  const revenueGrowth = safeNum(pick(
    sec.revenueGrowth,
    toPercent(m.revenueGrowthTTMYoy ?? m.revenueGrowth5Y ?? m['revenueGrowthQuarterlyYoy'])
  ));
  const epsGrowth = safeNum(pick(
    sec.epsGrowth,
    toPercent(m.epsGrowthTTMYoy ?? m['epsGrowth5Y'] ?? m['epsGrowthQuarterlyYoy'])
  ));

  // Debt/Equity
  let debtToEquity = safeNum(pick(
    sec.debtToEquity,
    m['totalDebt/totalEquityAnnual'],
    m['totalDebt/totalEquityQuarterly']
  ));
  if (debtToEquity !== null && debtToEquity > 20) {
    debtToEquity = debtToEquity / 100;
  }

  // FCF / share
  const fcfPerShare = safeNum(pick(
    sec.fcfPerShare,
    m.freeCashFlowPerShareTTM, m.freeCashFlowPerShareAnnual, m['fcfPerShareTTM']
  ));

  // Dividend yield (zatím jen Finnhub — SEC dividendy jsou complex)
  const dividendYield = toPercent(pick(
    m.dividendYieldIndicatedAnnual, m.currentDividendYieldTTM
  ));

  // ── 5. Source tracking ───────────────────────────────────────────────────
  const sources = {
    price: priceValid ? (priceData?.source || 'unknown') : null,
    fundamentals: secData
      ? 'sec'
      : (fhMetrics ? 'finnhub' : null),
    profile: secData
      ? 'sec'
      : (fhProfile ? 'finnhub' : (priceData ? 'yahoo' : null)),
  };

  return {
    symbol: s,
    type,
    price: priceValid ? price : null,
    name,
    currency,
    exchange,
    industry,
    marketCap,
    // Valuace
    epsTtm,
    peTtm,
    psTtm,
    pb,
    // Růsty (v %)
    revenueGrowth,
    epsGrowth,
    // Marže (v %)
    grossMargin,
    operatingMargin,
    netMargin,
    // Bilance
    debtToEquity,
    fcfPerShare,
    // Dividendy
    dividendYield,
    // Bilance raw (pro audit)
    revenue: safeNum(sec.revenue),
    netIncome: safeNum(sec.netIncome),
    fcf: safeNum(sec.fcf),
    sharesOutstanding: safeNum(sec.sharesOutstanding),
    asOfDate: sec.asOfDate || null,
    // 52w range (z Yahoo)
    fiftyTwoWeekHigh: safeNum(priceData?.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: safeNum(priceData?.fiftyTwoWeekLow),
    // Meta
    sources,
  };
}

module.exports = { normalize, isCryptoTicker, safeNum, toPercent, pick };
