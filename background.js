const PRU_PROXY_SYMBOLS = ['IWF', 'IWD', 'IWM', 'SPY', 'VEA', 'AGG'];
const MARKET_CACHE_KEY = 'marketProxyPriceCache';
const MARKET_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

const PRU_FUND_PROXY_MAP = [
  {
    match: /large[-\s]*cap\s+growth/i,
    fundName: 'AST Large-Cap Growth Portfolio',
    ftMorningstarId: '0P00003DD1',
    proxySymbol: 'IWF',
  },
  {
    match: /large[-\s]*cap\s+value/i,
    fundName: 'AST Large-Cap Value Portfolio',
    ftMorningstarId: '0P00003C21',
    proxySymbol: 'IWD',
  },
  {
    match: /small[-\s]*cap\s+equity/i,
    fundName: 'AST Small-Cap Equity Portfolio',
    ftMorningstarId: '0P00003C20',
    proxySymbol: 'IWM',
  },
  {
    match: /large[-\s]*cap\s+equity/i,
    fundName: 'AST Large-Cap Equity Portfolio',
    ftMorningstarId: '0P0000Y09H',
    proxySymbol: 'SPY',
  },
  {
    match: /international\s+equity/i,
    fundName: 'AST International Equity Portfolio',
    ftMorningstarId: '0P00003DET',
    proxySymbol: 'VEA',
  },
  {
    match: /core\s+fixed\s+income/i,
    fundName: 'AST Core Fixed Income Portfolio',
    ftMorningstarId: '0P00009PZZ',
    proxySymbol: 'AGG',
  },
];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'PRU_BACKFILL_ESTIMATE') {
    backfillPrudentialBalances(msg.payload || {})
      .then(result => sendResponse({ ok: true, result }))
      .catch(error => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (msg?.balance && msg?.transactions) {
    console.log('Received data from Mohela page:', msg);
    chrome.storage.local.set({
      mohelaData: {
        lastSynced: new Date().toISOString(),
        balance: msg.balance,
        transactions: msg.transactions,
      },
    });
  }
  return false;
});

async function backfillPrudentialBalances({
  accountId,
  knownBalances,
  allocationSnapshots,
  selectedAllocationSnapshotId,
  maxBackfillDays = 60,
}) {
  const balances = cleanKnownBalances(knownBalances).slice(-400);
  if (balances.length < 1) {
    return { rows: [], debug: { reason: 'No known balances available' } };
  }

  const endDate = balances[balances.length - 1].date;
  const startDate = maxIsoDate(addIsoDays(endDate, -maxBackfillDays - 8), balances[0].date);
  const periodBalances = balances.filter(row => row.date >= addIsoDays(endDate, -maxBackfillDays) && row.date <= endDate);
  const allocation = chooseAllocationSnapshot(allocationSnapshots, selectedAllocationSnapshotId, accountId, endDate);
  const allocationRows = normalizeAllocationRows(allocation?.rows || []);
  const proxySymbols = [...new Set(allocationRows.map(row => row.proxySymbol).filter(Boolean))];

  if (!allocation || !allocationRows.length || !proxySymbols.length) {
    return {
      rows: [],
      debug: {
        reason: 'Missing usable Prudential allocation snapshot',
        allocationSnapshotId: allocation?.id || null,
      },
    };
  }

  const pricesBySymbol = {};
  const proxyFetchErrors = [];
  for (const symbol of proxySymbols) {
    try {
      pricesBySymbol[symbol] = await getProxyPriceHistory(symbol, startDate, endDate);
    } catch (error) {
      proxyFetchErrors.push(`${symbol}: ${error.message || String(error)}`);
      pricesBySymbol[symbol] = [];
    }
  }

  const usableAllocationRows = allocationRows.filter(row => (pricesBySymbol[row.proxySymbol] || []).length >= 2);
  const usableWeight = usableAllocationRows.reduce((sum, row) => sum + row.weight, 0);
  if (usableWeight < 0.5) {
    return {
      rows: [],
      debug: {
        reason: proxyFetchErrors.length
          ? `Proxy price history unavailable: ${proxyFetchErrors.join('; ')}`
          : 'Proxy price history unavailable',
        allocationSnapshotId: allocation.id,
        allocationSource: allocation.source,
        allocationEffectiveDate: allocation.effectiveDate,
        proxySymbols,
      },
    };
  }

  const normalizedUsableRows = usableAllocationRows.map(row => ({ ...row, weight: row.weight / usableWeight }));
  const returnsByDate = buildWeightedReturns(normalizedUsableRows, pricesBySymbol);
  const marketDates = Object.keys(returnsByDate).sort();
  const staleDetection = detectStaleBalanceDates(periodBalances, marketDates, returnsByDate);
  const candidateDates = staleDetection.dates
    .filter(date => date < endDate)
    .filter(date => daysBetweenIso(date, endDate) <= maxBackfillDays);

  console.log('Prudential stale detection:', staleDetection);
  console.log('Prudential allocation used:', {
    allocationSnapshotId: allocation.id,
    allocationSource: allocation.source,
    allocationEffectiveDate: allocation.effectiveDate,
    allocationRows: normalizedUsableRows,
    proxyFetchErrors,
  });

  if (!candidateDates.length) {
    return {
      rows: [],
      debug: {
        reason: staleDetection.reason || 'No stale or missing Prudential dates detected',
        repeatedBalanceCount: staleDetection.repeatedBalanceCount,
        allocationSnapshotId: allocation.id,
        allocationSource: allocation.source,
        allocationEffectiveDate: allocation.effectiveDate,
        proxySymbols,
        proxyFetchErrors,
      },
    };
  }

  const candidateSet = new Set(candidateDates);
  const actualAnchors = periodBalances.filter(row => !candidateSet.has(row.date));
  const rows = [];

  for (const date of candidateDates) {
    const prevAnchor = latestBeforeOrOn(actualAnchors, date);
    const nextAnchor = earliestAfterOrOn(actualAnchors, date);
    if (!prevAnchor && !nextAnchor) continue;

    const estimatedBalance = estimateBalanceForDate({
      date,
      prevAnchor,
      nextAnchor,
      returnsByDate,
      marketDates,
    });
    if (!Number.isFinite(estimatedBalance)) continue;

    const segmentDays = Math.max(
      prevAnchor ? daysBetweenIso(prevAnchor.date, date) : 0,
      nextAnchor ? daysBetweenIso(date, nextAnchor.date) : 0
    );
    const confidence = confidenceForEstimate({
      hasPrevAnchor: !!prevAnchor,
      hasNextAnchor: !!nextAnchor,
      allocation,
      allocationAgeDays: Math.abs(daysBetweenIso(allocation.effectiveDate, date)),
      proxyCoverage: proxyCoverageForDateRange(proxySymbols, pricesBySymbol, prevAnchor?.date || date, nextAnchor?.date || date),
      segmentDays,
      staleDetection,
    });

    rows.push({
      date,
      balance: roundMoney(estimatedBalance),
      estimated: true,
      estimatedMethod: 'prudential-weighted-proxy-return',
      confidence: confidence.level,
      confidenceReason: confidence.reason,
      anchorStartDate: prevAnchor?.date || null,
      anchorEndDate: nextAnchor?.date || null,
      allocationSnapshotId: allocation.id,
      allocationSource: allocation.source,
      allocationEffectiveDate: allocation.effectiveDate,
      proxySymbols,
      proxyFetchErrors,
      reconciliationApplied: !!(prevAnchor && nextAnchor),
      staleDetectionReason: staleDetection.reason,
    });
  }

  console.log('Prudential estimated balance rows:', rows);
  return {
    rows,
    debug: {
      staleDetection,
      repeatedBalanceCount: staleDetection.repeatedBalanceCount,
      allocationSnapshotId: allocation.id,
      allocationSource: allocation.source,
      allocationEffectiveDate: allocation.effectiveDate,
      proxySymbols,
      proxyFetchErrors,
      generatedRows: rows.length,
    },
  };
}

function cleanKnownBalances(knownBalances) {
  const byDate = new Map();
  for (const row of knownBalances || []) {
    if (!isIsoDate(row?.date)) continue;
    const balance = parseFloat(row.balance);
    if (!Number.isFinite(balance)) continue;
    const existing = byDate.get(row.date);
    if (!existing || row.source === 'scraped-current') {
      byDate.set(row.date, { ...row, balance });
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function chooseAllocationSnapshot(snapshots, selectedId, accountId, targetDate) {
  const filtered = (snapshots || [])
    .filter(snapshot => !accountId || !snapshot.accountId || snapshot.accountId === accountId)
    .filter(snapshot => isIsoDate(snapshot.effectiveDate) && Array.isArray(snapshot.rows));

  if (!filtered.length) return null;

  const selected = selectedId ? filtered.find(snapshot => snapshot.id === selectedId) : null;
  if (selected) return selected;

  const before = filtered
    .filter(snapshot => snapshot.effectiveDate <= targetDate)
    .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate))[0];
  if (before) return before;

  return filtered
    .sort((a, b) => Math.abs(daysBetweenIso(a.effectiveDate, targetDate)) - Math.abs(daysBetweenIso(b.effectiveDate, targetDate)))[0];
}

function normalizeAllocationRows(rows) {
  const withProxies = (rows || []).map(row => {
    const mapped = mapFundProxy(row.fundName, row.proxySymbol);
    return {
      ...row,
      fundName: row.fundName || mapped?.fundName || '',
      weight: parseFloat(row.weight),
      value: parseFloat(row.value),
      proxySymbol: mapped?.proxySymbol || normalizeSymbol(row.proxySymbol),
      ftMorningstarId: row.ftMorningstarId || mapped?.ftMorningstarId || '',
    };
  });

  const totalValue = withProxies.reduce((sum, row) => sum + (Number.isFinite(row.value) && row.value > 0 ? row.value : 0), 0);
  const prepared = withProxies.map(row => {
    let weight = Number.isFinite(row.weight) ? row.weight : NaN;
    if (!Number.isFinite(weight) && totalValue > 0 && Number.isFinite(row.value) && row.value > 0) {
      weight = row.value / totalValue * 100;
    }
    return { ...row, weight };
  });

  const totalWeight = prepared.reduce((sum, row) => sum + (Number.isFinite(row.weight) ? row.weight : 0), 0);
  if (!totalWeight) return [];

  return prepared
    .filter(row => Number.isFinite(row.weight) && row.weight > 0 && PRU_PROXY_SYMBOLS.includes(row.proxySymbol))
    .map(row => ({ ...row, weight: row.weight / totalWeight }));
}

function mapFundProxy(fundName, explicitSymbol) {
  const normalizedExplicit = normalizeSymbol(explicitSymbol);
  if (PRU_PROXY_SYMBOLS.includes(normalizedExplicit)) {
    return { proxySymbol: normalizedExplicit };
  }
  const rawName = String(fundName || '');
  return PRU_FUND_PROXY_MAP.find(item => item.match.test(rawName)) || null;
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

async function getProxyPriceHistory(symbol, startDate, endDate) {
  const normalized = normalizeSymbol(symbol);
  if (!PRU_PROXY_SYMBOLS.includes(normalized)) {
    throw new Error(`Market proxy symbol is not approved: ${symbol}`);
  }

  const cache = await storageGet(MARKET_CACHE_KEY, {});
  const symbolCache = cache[normalized] || {};
  const cacheKey = `${startDate}:${endDate}`;
  const cached = symbolCache[cacheKey];
  if (cached?.capturedAt && Date.now() - Date.parse(cached.capturedAt) < MARKET_CACHE_TTL_MS && Array.isArray(cached.rows)) {
    return cached.rows;
  }

  const rows = await fetchNasdaqPriceHistory(normalized, startDate, endDate);
  if (rows.length < 2) throw new Error(`Proxy price history unavailable for ${normalized}`);

  cache[normalized] = {
    ...symbolCache,
    [cacheKey]: { capturedAt: new Date().toISOString(), rows },
  };
  await storageSet({ [MARKET_CACHE_KEY]: cache });
  return rows;
}

async function fetchNasdaqPriceHistory(symbol, startDate, endDate) {
  const params = new URLSearchParams({
    assetclass: 'etf',
    fromdate: startDate,
    todate: endDate,
    limit: '9999',
  });
  const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/historical?${params.toString()}`;
  const resp = await fetch(url, {
    credentials: 'omit',
    headers: {
      'Accept': 'application/json',
    },
  });
  if (!resp.ok) throw new Error(`Nasdaq price fetch failed for ${symbol}: HTTP ${resp.status}`);

  const json = await resp.json();
  const rows = json?.data?.tradesTable?.rows;
  if (!Array.isArray(rows)) {
    throw new Error(`Nasdaq price fetch returned no rows for ${symbol}`);
  }

  return rows
    .map(row => ({
      date: usDateToIso(row.date),
      close: parseMarketNumber(row.close),
    }))
    .filter(row => row.date >= startDate && row.date <= endDate)
    .filter(row => Number.isFinite(row.close) && row.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function usDateToIso(value) {
  const match = String(value || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return match ? `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}` : '';
}

function parseMarketNumber(value) {
  const parsed = parseFloat(String(value || '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function buildWeightedReturns(allocationRows, pricesBySymbol) {
  const returnsByDate = {};
  for (const row of allocationRows) {
    const prices = pricesBySymbol[row.proxySymbol] || [];
    for (let i = 1; i < prices.length; i++) {
      const prev = prices[i - 1];
      const curr = prices[i];
      if (!prev?.close || !curr?.close) continue;
      const proxyReturn = curr.close / prev.close - 1;
      if (!Number.isFinite(proxyReturn)) continue;
      returnsByDate[curr.date] = (returnsByDate[curr.date] || 0) + row.weight * proxyReturn;
    }
  }
  return returnsByDate;
}

function detectStaleBalanceDates(knownBalances, marketDates, returnsByDate) {
  const knownByDate = new Map(knownBalances.map(row => [row.date, row]));
  const dates = new Set();
  const reasons = [];
  let repeatedBalanceCount = 0;

  for (let i = 1; i < knownBalances.length; i++) {
    const prev = knownBalances[i - 1];
    const curr = knownBalances[i];
    const datesBetween = marketDates.filter(date => date > prev.date && date < curr.date);
    if (datesBetween.length) {
      datesBetween.forEach(date => dates.add(date));
      reasons.push(`missing ${datesBetween.length} trading day${datesBetween.length !== 1 ? 's' : ''} between ${prev.date} and ${curr.date}`);
    }
  }

  let run = [];
  for (const row of knownBalances) {
    const prev = run[run.length - 1];
    if (!prev || Math.abs(prev.balance - row.balance) <= 0.01) {
      run.push(row);
    } else {
      addStaleRun(run);
      run = [row];
    }
  }
  addStaleRun(run);

  function addStaleRun(runRows) {
    if (runRows.length < 3) return;
    const runMarketDates = marketDates.filter(date => date >= runRows[0].date && date <= runRows[runRows.length - 1].date);
    if (runMarketDates.length < 3) return;
    const marketMove = runMarketDates.reduce((product, date) => product * (1 + (returnsByDate[date] || 0)), 1) - 1;
    if (Math.abs(marketMove) < 0.001) return;

    repeatedBalanceCount += Math.max(0, runRows.length - 1);
    for (const row of runRows.slice(1)) {
      dates.add(row.date);
    }
    reasons.push(`same balance repeated ${runRows.length} times while proxies moved ${(marketMove * 100).toFixed(2)}%`);
  }

  const latestKnown = knownBalances[knownBalances.length - 1];
  const lateMissing = latestKnown
    ? marketDates.filter(date => date > latestKnown.date).filter(date => !knownByDate.has(date))
    : [];
  if (lateMissing.length) {
    lateMissing.forEach(date => dates.add(date));
    reasons.push(`sync appears stale after ${latestKnown.date}`);
  }

  return {
    dates: [...dates].sort(),
    reason: reasons.join('; '),
    repeatedBalanceCount,
  };
}

function estimateBalanceForDate({ date, prevAnchor, nextAnchor, returnsByDate, marketDates }) {
  if (prevAnchor) {
    const forwardToDate = compoundReturn(returnsByDate, marketDates, prevAnchor.date, date);
    let estimate = prevAnchor.balance * forwardToDate;
    if (nextAnchor) {
      const forwardToNext = compoundReturn(returnsByDate, marketDates, prevAnchor.date, nextAnchor.date);
      const projectedNext = prevAnchor.balance * forwardToNext;
      if (projectedNext && Number.isFinite(projectedNext)) {
        const ratio = nextAnchor.balance / projectedNext;
        const elapsed = Math.max(1, marketDates.filter(d => d > prevAnchor.date && d <= date).length);
        const total = Math.max(elapsed, marketDates.filter(d => d > prevAnchor.date && d <= nextAnchor.date).length);
        estimate *= Math.pow(ratio, elapsed / total);
        console.log('Prudential reconciliation adjustment:', { date, ratio, elapsed, total });
      }
    }
    return estimate;
  }

  if (nextAnchor) {
    const growthToNext = compoundReturn(returnsByDate, marketDates, date, nextAnchor.date);
    return nextAnchor.balance / growthToNext;
  }

  return NaN;
}

function compoundReturn(returnsByDate, marketDates, startDate, endDate) {
  return marketDates
    .filter(date => date > startDate && date <= endDate)
    .reduce((product, date) => product * (1 + (returnsByDate[date] || 0)), 1);
}

function confidenceForEstimate({
  hasPrevAnchor,
  hasNextAnchor,
  allocation,
  allocationAgeDays,
  proxyCoverage,
  segmentDays,
  staleDetection,
}) {
  const reasons = [];
  let score = 0;
  if (hasPrevAnchor && hasNextAnchor) score += 3; else { score += 1; reasons.push('one balance anchor missing'); }
  if (allocation?.source === 'scraped' || allocation?.source === 'imported') score += 2; else reasons.push('manual allocation snapshot');
  if (allocationAgeDays <= 14) score += 2; else if (allocationAgeDays <= 60) score += 1; else reasons.push('allocation snapshot is stale');
  if (proxyCoverage >= 0.95) score += 2; else if (proxyCoverage >= 0.8) score += 1; else reasons.push('proxy coverage is incomplete');
  if (segmentDays <= 14) score += 2; else if (segmentDays <= 30) score += 1; else reasons.push('gap is over 30 days');
  if (staleDetection.repeatedBalanceCount) reasons.push('repeated stale balances triggered estimate');

  if (segmentDays > 60 || proxyCoverage < 0.6) return { level: 'very low', reason: reasons.join('; ') || 'weak estimate inputs' };
  if (score >= 9) return { level: 'high', reason: 'both anchors, recent allocation, complete proxy data' };
  if (score >= 6) return { level: 'medium', reason: reasons.join('; ') || 'mostly complete estimate inputs' };
  return { level: 'low', reason: reasons.join('; ') || 'limited estimate inputs' };
}

function proxyCoverageForDateRange(proxySymbols, pricesBySymbol, startDate, endDate) {
  const expectedDates = new Set();
  for (const symbol of proxySymbols) {
    for (const row of pricesBySymbol[symbol] || []) {
      if (row.date > startDate && row.date <= endDate) expectedDates.add(row.date);
    }
  }
  if (!expectedDates.size) return 0;

  let covered = 0;
  for (const date of expectedDates) {
    const allHaveDate = proxySymbols.every(symbol => (pricesBySymbol[symbol] || []).some(row => row.date === date));
    if (allHaveDate) covered++;
  }
  return covered / expectedDates.size;
}

function latestBeforeOrOn(rows, date) {
  return [...rows].filter(row => row.date <= date).sort((a, b) => b.date.localeCompare(a.date))[0] || null;
}

function earliestAfterOrOn(rows, date) {
  return [...rows].filter(row => row.date >= date).sort((a, b) => a.date.localeCompare(b.date))[0] || null;
}

function storageGet(key, fallback) {
  return new Promise(resolve => {
    chrome.storage.local.get(key, result => resolve(result?.[key] ?? fallback));
  });
}

function storageSet(values) {
  return new Promise(resolve => chrome.storage.local.set(values, resolve));
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '');
}

function addIsoDays(date, days) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetweenIso(startDate, endDate) {
  const start = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return 0;
  return Math.round((end - start) / 86400000);
}

function maxIsoDate(a, b) {
  return a > b ? a : b;
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}
