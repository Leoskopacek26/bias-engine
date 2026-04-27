// ─────────────────────────────────────────────────────────────────────────────
// SEC EDGAR data layer — Company Facts API
// ─────────────────────────────────────────────────────────────────────────────
// Free, žádný klíč. Vyžaduje User-Agent header (SEC pravidlo).
// Rate limit: 10 req/sec na IP (bohatě stačí).
//
// Endpointy:
//   ticker→CIK:    https://www.sec.gov/files/company_tickers.json   (~10k US tickerů)
//   Company Facts: https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json
//
// Vrací { data, error, status }.
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');
const cache = require('./cache');

const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const FACTS_URL   = 'https://data.sec.gov/api/xbrl/companyfacts/CIK';
const TIMEOUT_MS  = 10000;

// SEC vyžaduje validní User-Agent (jméno + kontakt).
// Pokud uživatel chce, nastaví v env SEC_USER_AGENT.
function userAgent() {
  return process.env.SEC_USER_AGENT
      || 'BiasEngine FairValue (contact via netlify deploy)';
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': userAgent(),
        'Accept': 'application/json',
        'Accept-Encoding': 'identity',
        'Host': new URL(url).host,
      },
    }, res => {
      // SEC dělá redirecty (např. www.sec.gov ↔ data.sec.gov)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(new Error('timeout')); });
  });
}

// ── Ticker → CIK mapping (cache 24 h) ───────────────────────────────────────
let _tickerMap = null;
let _tickerMapLoadedAt = 0;
const TICKER_MAP_TTL = 24 * 60 * 60 * 1000;

async function getTickerMap() {
  const now = Date.now();
  if (_tickerMap && (now - _tickerMapLoadedAt) < TICKER_MAP_TTL) {
    return _tickerMap;
  }
  // Cache hit?
  const cached = cache.get('sec:ticker_map');
  if (cached) {
    _tickerMap = cached;
    _tickerMapLoadedAt = now;
    return cached;
  }
  // Fetch from SEC
  try {
    const r = await httpsGet(TICKERS_URL);
    if (r.statusCode !== 200) {
      return { error: `SEC tickers HTTP ${r.statusCode}` };
    }
    const raw = JSON.parse(r.body);
    // raw je { "0": {cik_str, ticker, title}, "1": {...}, ... }
    // Postavíme {ticker_uppercase: {cik, name}}
    const map = {};
    for (const k of Object.keys(raw)) {
      const e = raw[k];
      if (!e || !e.ticker || !e.cik_str) continue;
      const cikPadded = String(e.cik_str).padStart(10, '0');
      map[e.ticker.toUpperCase()] = { cik: cikPadded, name: e.title };
    }
    _tickerMap = map;
    _tickerMapLoadedAt = now;
    cache.set('sec:ticker_map', map, cache.TTL.tickerMap || TICKER_MAP_TTL);
    return map;
  } catch (e) {
    return { error: `SEC tickers fetch: ${e.message}` };
  }
}

async function lookupCIK(ticker) {
  const sym = (ticker || '').toUpperCase().trim();
  // Speciální case: BRK.B → BRK-B v SEC mapování? — Pravidlo: tečku nahradit pomlčkou.
  const variants = [sym];
  if (sym.includes('.')) variants.push(sym.replace(/\./g, '-'));
  if (sym.includes('-')) variants.push(sym.replace(/-/g, '.'));

  const map = await getTickerMap();
  if (map.error) return { error: map.error };

  for (const v of variants) {
    if (map[v]) return { cik: map[v].cik, name: map[v].name, matchedAs: v };
  }
  return { error: `Ticker ${sym} not in SEC EDGAR (non-US or unlisted)` };
}

// ── Company Facts (cache 7 dní) ─────────────────────────────────────────────
async function fetchCompanyFacts(cik) {
  const cacheKey = `sec:facts:${cik}`;
  const cached = cache.get(cacheKey);
  if (cached) return { data: cached, cached: true };

  try {
    const url = `${FACTS_URL}${cik}.json`;
    const r = await httpsGet(url);
    if (r.statusCode === 404) {
      return { error: 'SEC Company Facts not found (404)', status: 404 };
    }
    if (r.statusCode === 429) {
      return { error: 'SEC rate limit (429) — try again', status: 429 };
    }
    if (r.statusCode !== 200) {
      return { error: `SEC Facts HTTP ${r.statusCode}`, status: r.statusCode };
    }
    const data = JSON.parse(r.body);
    cache.set(cacheKey, data, cache.TTL.fund);
    return { data };
  } catch (e) {
    return { error: `SEC Facts fetch: ${e.message}` };
  }
}

// ── XBRL extrakce ──────────────────────────────────────────────────────────
// Z Company Facts JSON získat jednu metriku.
// `concepts` je seznam možných us-gaap názvů (priorita).
// `unit` je jednotka — "USD", "USD/shares", "shares".
function pickMetric(facts, concepts, unit) {
  for (const concept of concepts) {
    const c = facts?.facts?.['us-gaap']?.[concept];
    if (!c || !c.units || !c.units[unit]) continue;
    const records = c.units[unit];
    if (!Array.isArray(records) || !records.length) continue;
    return { concept, records };
  }
  return null;
}

// Najít poslední FY (annual 10-K) hodnotu
function latestAnnual(records) {
  if (!records || !records.length) return null;
  // Filtr: jen FY záznamy z 10-K formuláře (ne amendments)
  const fy = records.filter(r =>
    r.fp === 'FY' && (r.form === '10-K' || r.form === '20-F') && r.val != null
  );
  if (!fy.length) return null;
  // Sort by `end` descending
  fy.sort((a, b) => (b.end || '').localeCompare(a.end || ''));
  return fy[0];
}

// Sečíst poslední 4 quartální hodnoty (Q1+Q2+Q3+Q4 = TTM)
// Funguje pro flow metriky (revenue, net income, EPS, OCF, capex).
function sumLast4Quarters(records) {
  if (!records || !records.length) return null;
  const q = records.filter(r =>
    (r.fp === 'Q1' || r.fp === 'Q2' || r.fp === 'Q3' || r.fp === 'Q4') &&
    (r.form === '10-Q' || r.form === '10-K') && r.val != null
  );
  if (q.length < 2) return null;
  // Sort by `end` descending
  q.sort((a, b) => (b.end || '').localeCompare(a.end || ''));
  // Vezmi 4 nejnovější (různé end dates, nepočítej restated duplikáty)
  const seen = new Set();
  const picked = [];
  for (const r of q) {
    if (seen.has(r.end)) continue;
    seen.add(r.end);
    picked.push(r);
    if (picked.length === 4) break;
  }
  if (picked.length < 4) return null;
  const sum = picked.reduce((s, r) => s + r.val, 0);
  return { val: sum, periods: picked.map(p => `${p.fp} ${p.end}`), end: picked[0].end };
}

// Pokus: TTM via sum 4Q, fallback last FY
function ttmOrAnnual(records) {
  const ttm = sumLast4Quarters(records);
  if (ttm) return { ...ttm, source: 'TTM (sum 4Q)' };
  const annual = latestAnnual(records);
  if (annual) return { val: annual.val, end: annual.end, source: `FY${annual.fy} (annual)`, periods: [`FY ${annual.end}`] };
  return null;
}

// Najít hodnotu pro úplně poslední period (point-in-time, např. assets)
function latestPit(records) {
  if (!records || !records.length) return null;
  const valid = records.filter(r => r.val != null);
  if (!valid.length) return null;
  valid.sort((a, b) => (b.end || '').localeCompare(a.end || ''));
  return valid[0];
}

// ── Hlavní extrakce → znormalizovaný objekt s SEC metrikami ────────────────
function extractMetrics(facts) {
  if (!facts || !facts.facts) return null;

  // Revenue (TTM)
  const revenue = pickMetric(facts, [
    'Revenues',
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'RevenueFromContractWithCustomerIncludingAssessedTax',
    'SalesRevenueNet',
  ], 'USD');
  const revenueTTM = revenue ? ttmOrAnnual(revenue.records) : null;

  // Předchozí rok pro YoY growth
  let revenuePrior = null;
  if (revenue) {
    const annuals = revenue.records.filter(r => r.fp === 'FY' && r.val != null)
                                    .sort((a, b) => (b.end || '').localeCompare(a.end || ''));
    if (annuals.length >= 2) revenuePrior = { val: annuals[1].val, end: annuals[1].end };
  }
  const revenueGrowth = (revenueTTM && revenuePrior && revenuePrior.val > 0)
    ? ((revenueTTM.val - revenuePrior.val) / revenuePrior.val) * 100
    : null;

  // Net income (TTM)
  const netIncome = pickMetric(facts, ['NetIncomeLoss', 'ProfitLoss'], 'USD');
  const netIncomeTTM = netIncome ? ttmOrAnnual(netIncome.records) : null;
  let netIncomePrior = null;
  if (netIncome) {
    const annuals = netIncome.records.filter(r => r.fp === 'FY' && r.val != null)
                                       .sort((a, b) => (b.end || '').localeCompare(a.end || ''));
    if (annuals.length >= 2) netIncomePrior = { val: annuals[1].val, end: annuals[1].end };
  }

  // EPS diluted (TTM)
  const epsDiluted = pickMetric(facts, [
    'EarningsPerShareDiluted',
    'EarningsPerShareBasicAndDiluted',
    'EarningsPerShareBasic',
  ], 'USD/shares');
  const epsTTM = epsDiluted ? ttmOrAnnual(epsDiluted.records) : null;
  let epsPrior = null;
  if (epsDiluted) {
    const annuals = epsDiluted.records.filter(r => r.fp === 'FY' && r.val != null)
                                       .sort((a, b) => (b.end || '').localeCompare(a.end || ''));
    if (annuals.length >= 2) epsPrior = { val: annuals[1].val, end: annuals[1].end };
  }
  const epsGrowth = (epsTTM && epsPrior && Math.abs(epsPrior.val) > 0.01)
    ? ((epsTTM.val - epsPrior.val) / Math.abs(epsPrior.val)) * 100
    : null;

  // Operating income (TTM)
  const opIncome = pickMetric(facts, ['OperatingIncomeLoss'], 'USD');
  const opIncomeTTM = opIncome ? ttmOrAnnual(opIncome.records) : null;

  // Operating cash flow (TTM)
  const ocf = pickMetric(facts, [
    'NetCashProvidedByUsedInOperatingActivities',
    'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations',
  ], 'USD');
  const ocfTTM = ocf ? ttmOrAnnual(ocf.records) : null;

  // Capex (TTM, kladné číslo v SEC)
  const capex = pickMetric(facts, [
    'PaymentsToAcquirePropertyPlantAndEquipment',
    'PaymentsToAcquireProductiveAssets',
  ], 'USD');
  const capexTTM = capex ? ttmOrAnnual(capex.records) : null;

  // FCF = OCF - capex
  const fcfTTM = (ocfTTM && capexTTM) ? { val: ocfTTM.val - capexTTM.val, source: 'OCF − Capex' } : null;

  // Shares outstanding
  let sharesOutstanding = null;
  const cso = pickMetric(facts, ['CommonStockSharesOutstanding', 'CommonStockSharesIssued'], 'shares');
  if (cso) {
    const latest = latestPit(cso.records);
    if (latest) sharesOutstanding = latest.val;
  }
  // Fallback: weighted avg diluted
  if (!sharesOutstanding) {
    const wad = pickMetric(facts, [
      'WeightedAverageNumberOfDilutedSharesOutstanding',
      'WeightedAverageNumberOfSharesOutstandingBasic',
    ], 'shares');
    if (wad) {
      const annual = latestAnnual(wad.records);
      if (annual) sharesOutstanding = annual.val;
    }
  }

  // Balance sheet
  const assets = pickMetric(facts, ['Assets'], 'USD');
  const liabilities = pickMetric(facts, ['Liabilities'], 'USD');
  const equity = pickMetric(facts, ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'], 'USD');
  const assetsLatest = assets ? latestPit(assets.records) : null;
  const liabLatest = liabilities ? latestPit(liabilities.records) : null;
  const equityLatest = equity ? latestPit(equity.records) : null;

  // Debt-to-equity (z bilance)
  const totalDebt = pickMetric(facts, [
    'LongTermDebt',
    'LongTermDebtNoncurrent',
  ], 'USD');
  const ltDebtLatest = totalDebt ? latestPit(totalDebt.records) : null;
  let debtToEquity = null;
  if (ltDebtLatest && equityLatest && equityLatest.val > 0) {
    debtToEquity = ltDebtLatest.val / equityLatest.val;
  }

  // FCF / share
  let fcfPerShare = null;
  if (fcfTTM && sharesOutstanding && sharesOutstanding > 0) {
    fcfPerShare = fcfTTM.val / sharesOutstanding;
  }

  // Margins
  const grossProfit = pickMetric(facts, ['GrossProfit'], 'USD');
  const grossProfitTTM = grossProfit ? ttmOrAnnual(grossProfit.records) : null;
  const grossMargin = (grossProfitTTM && revenueTTM && revenueTTM.val > 0)
    ? (grossProfitTTM.val / revenueTTM.val) * 100 : null;
  const operatingMargin = (opIncomeTTM && revenueTTM && revenueTTM.val > 0)
    ? (opIncomeTTM.val / revenueTTM.val) * 100 : null;
  const netMargin = (netIncomeTTM && revenueTTM && revenueTTM.val > 0)
    ? (netIncomeTTM.val / revenueTTM.val) * 100 : null;

  return {
    name: facts.entityName || null,
    cik: facts.cik || null,
    sic: facts.sic || null,
    sicDescription: facts.sicDescription || null,

    revenue: revenueTTM?.val ?? null,
    revenueEnd: revenueTTM?.end ?? null,
    revenueSource: revenueTTM?.source ?? null,
    revenueGrowth,                          // %

    netIncome: netIncomeTTM?.val ?? null,
    netIncomeEnd: netIncomeTTM?.end ?? null,

    epsTtm: epsTTM?.val ?? null,
    epsTtmEnd: epsTTM?.end ?? null,
    epsTtmSource: epsTTM?.source ?? null,
    epsGrowth,                              // %

    opIncome: opIncomeTTM?.val ?? null,
    opCashFlow: ocfTTM?.val ?? null,
    capex: capexTTM?.val ?? null,
    fcf: fcfTTM?.val ?? null,
    fcfSource: fcfTTM?.source ?? null,

    sharesOutstanding,
    fcfPerShare,

    assets: assetsLatest?.val ?? null,
    liabilities: liabLatest?.val ?? null,
    equity: equityLatest?.val ?? null,
    debtToEquity,

    grossMargin,                            // %
    operatingMargin,                        // %
    netMargin,                              // %

    asOfDate: revenueTTM?.end || epsTTM?.end || null,
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

// Hlavní funkce: ticker → SEC fundamenty (znormalizované)
async function fetchFundamentals(ticker) {
  const lookup = await lookupCIK(ticker);
  if (lookup.error) return { error: lookup.error };

  const facts = await fetchCompanyFacts(lookup.cik);
  if (facts.error) return { error: facts.error, status: facts.status };

  const metrics = extractMetrics(facts.data);
  if (!metrics) return { error: 'SEC: empty XBRL facts' };

  return {
    data: {
      ...metrics,
      cik: lookup.cik,
      name: metrics.name || lookup.name,
      ticker: ticker.toUpperCase(),
      _cached: facts.cached || false,
    },
  };
}

async function healthCheck() {
  // Test ticker → CIK
  const r = await lookupCIK('AAPL');
  if (r.error) return { ok: false, error: r.error };
  // Test Company Facts download
  const f = await fetchCompanyFacts(r.cik);
  if (f.error) return { ok: false, error: f.error };
  return {
    ok: true,
    sample: { ticker: 'AAPL', cik: r.cik, name: f.data.entityName },
    tickerMapEntries: Object.keys(_tickerMap || {}).length,
  };
}

module.exports = {
  lookupCIK,
  fetchCompanyFacts,
  fetchFundamentals,
  extractMetrics,
  healthCheck,
  getTickerMap,
};
