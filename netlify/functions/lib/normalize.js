// ─────────────────────────────────────────────────────────────────────────────
// Normalizace: raw Finnhub + Yahoo → NormalizedFundamentals
// ─────────────────────────────────────────────────────────────────────────────
// Principy:
//  - null pro chybějící, ne 0
//  - procenta vždy v percentech (12 = 12%, ne 0.12)
//  - validace price > 0
//  - žádné null v aritmetice (helper safeNum)
// ─────────────────────────────────────────────────────────────────────────────

// Crypto detekce z tickeru
const CRYPTO_TICKERS = new Set([
  'BTCUSD', 'ETHUSD', 'BTC-USD', 'ETH-USD', 'BTCUSDT', 'ETHUSDT',
  'XBTUSD', 'XETHUSD',
]);

function isCryptoTicker(symbol) {
  const s = (symbol || '').toUpperCase();
  if (CRYPTO_TICKERS.has(s)) return true;
  // .USD nebo -USD suffix s krátkou base
  if (/^(BTC|ETH|XRP|SOL|ADA|DOGE|DOT|MATIC|AVAX|LINK)[\-]?USD[T]?$/.test(s)) return true;
  return false;
}

// Bezpečné číslo: vrací null pro NaN, undefined, Infinity, ne-číslo
function safeNum(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n;
}

// Procento: některé endpointy vrací 0.12 (= 12 %), jiné 12 (= 12 %).
// Pravidlo: pokud abs(x) < 1, předpokládáme decimálni → ×100.
// Pokud abs(x) >= 1, považujeme za procenta.
// (Růst > 100 % nebo < -100 % je vzácný a stejně bude zaokrouhlený.)
function toPercent(v) {
  const n = safeNum(v);
  if (n === null) return null;
  if (Math.abs(n) < 1) return n * 100;
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hlavní normalizace
// ─────────────────────────────────────────────────────────────────────────────
//
// Vstupy:
//   symbol     : "AAPL"
//   yahooData  : výstup yahoo.fetchPrice() → data
//   fhMetrics  : výstup finnhub.fetchMetrics() → data.metric
//   fhProfile  : výstup finnhub.fetchProfile() → data
//   fhQuote    : výstup finnhub.fetchQuote() → data (záloha pro cenu)
//
function normalize({ symbol, yahooData, fhMetrics, fhProfile, fhQuote }) {
  const s = (symbol || '').toUpperCase();

  // ── 1. Type detekce ──────────────────────────────────────────────────────
  let type = 'unknown';
  if (isCryptoTicker(s)) {
    type = 'crypto';
  } else if (yahooData?.type) {
    type = yahooData.type;       // stock | etf | crypto | …
  } else if (fhProfile && fhProfile.ticker) {
    // Finnhub nemá explicitní ETF flag v profile2 — defaultujeme na stock
    type = 'stock';
  }

  // ── 2. Cena: preferuj Finnhub quote (čerstvá), fallback Yahoo ────────────
  let price = safeNum(fhQuote?.c);
  if (!price || price <= 0) price = safeNum(yahooData?.price);

  // ── 3. Měna a profile info ───────────────────────────────────────────────
  const currency = fhProfile?.currency || yahooData?.currency || null;
  const exchange = fhProfile?.exchange || yahooData?.exchange || null;
  const name     = fhProfile?.name || null;
  const industry = fhProfile?.finnhubIndustry || null;
  const marketCap = safeNum(fhProfile?.marketCapitalization);  // v milionech USD

  // ── 4. Fundamentals z Finnhub ────────────────────────────────────────────
  const m = fhMetrics || {};

  // EPS TTM — Finnhub má více názvů, zkusíme všechny
  const epsTtm = safeNum(
    m.epsTTM ?? m['epsBasicExclExtraItemsTTM'] ?? m['epsInclExtraItemsTTM'] ?? m.epsAnnual
  );

  // P/E TTM
  const peTtm = safeNum(m.peTTM ?? m.peExclExtraTTM ?? m.peAnnual);

  // P/S TTM
  const psTtm = safeNum(m.psTTM ?? m.psAnnual);

  // P/B
  const pb = safeNum(m.pbAnnual ?? m.pbQuarterly);

  // Margins (Finnhub vrací v %, např. 25.4 = 25.4 %)
  const grossMargin     = toPercent(m.grossMarginTTM ?? m.grossMarginAnnual);
  const operatingMargin = toPercent(m.operatingMarginTTM ?? m.operatingMarginAnnual);
  const netMargin       = toPercent(m.netProfitMarginTTM ?? m.netProfitMarginAnnual);

  // Růsty — Finnhub často 0.123 = 12.3 % NEBO 12.3 = 12.3 %
  const revenueGrowth = toPercent(
    m.revenueGrowthTTMYoy ?? m.revenueGrowth5Y ?? m['revenueGrowthQuarterlyYoy']
  );
  const epsGrowth = toPercent(
    m.epsGrowthTTMYoy ?? m['epsGrowth5Y'] ?? m['epsGrowthQuarterlyYoy']
  );

  // Debt/Equity (poměr, NE procenta) — někdy přijde 1.5, někdy 150
  let debtToEquity = safeNum(m['totalDebt/totalEquityAnnual'] ?? m['totalDebt/totalEquityQuarterly']);
  if (debtToEquity !== null && debtToEquity > 20) {
    // pravděpodobně v procentech — převedeme zpět
    debtToEquity = debtToEquity / 100;
  }

  // FCF per share — ne vždy dostupné ve free tier
  const fcfPerShare = safeNum(
    m.freeCashFlowPerShareTTM ?? m.freeCashFlowPerShareAnnual ?? m['fcfPerShareTTM']
  );

  // Dividend yield — Finnhub vrací v % (např. 1.8 = 1.8 %)
  const dividendYield = toPercent(m.dividendYieldIndicatedAnnual ?? m.currentDividendYieldTTM);

  // ── 5. Validace price ────────────────────────────────────────────────────
  const priceValid = price && price > 0;

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
    // Meta
    sources: {
      price: priceValid ? (safeNum(fhQuote?.c) ? 'finnhub' : 'yahoo') : null,
      fundamentals: fhMetrics ? 'finnhub' : null,
      profile: fhProfile ? 'finnhub' : (yahooData ? 'yahoo' : null),
    },
  };
}

module.exports = { normalize, isCryptoTicker, safeNum, toPercent };
