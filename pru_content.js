(() => {
  const url = window.location.href;

  const PRU_KNOWN_FUNDS = [
    { fundName: 'AST Large-Cap Growth Portfolio', proxySymbol: 'IWF', ftMorningstarId: '0P00003DD1' },
    { fundName: 'AST Large-Cap Value Portfolio', proxySymbol: 'IWD', ftMorningstarId: '0P00003C21' },
    { fundName: 'AST Small-Cap Equity Portfolio', proxySymbol: 'IWM', ftMorningstarId: '0P00003C20' },
    { fundName: 'AST Large-Cap Equity Portfolio', proxySymbol: 'SPY', ftMorningstarId: '0P0000Y09H' },
    { fundName: 'AST International Equity Portfolio', proxySymbol: 'VEA', ftMorningstarId: '0P00003DET' },
    { fundName: 'AST Core Fixed Income Portfolio', proxySymbol: 'AGG', ftMorningstarId: '0P00009PZZ' },
  ];

  if (url.includes('prudential.com/mypru/myaccounts')) {
    waitFor('[data-qa="product-type"]', scrapeAccounts);
  } else if (url.includes('myservice.prudential.com') && url.includes('pru-ann360-investment-allocation')) {
    waitForAllocationData(scrapeInvestmentAllocationPage);
  } else if (url.includes('myservice.prudential.com') && url.includes('pru-ann360-transactions')) {
    waitFor('.evo-datatable_mob-box', scrapeAllTransactionPages);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Wait for a CSS selector to appear in the DOM (Angular SPA). */
  function waitFor(selector, fn, timeout = 8000) {
    if (document.querySelector(selector)) { fn(); return; }
    const obs = new MutationObserver(() => {
      if (document.querySelector(selector)) { obs.disconnect(); fn(); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); fn(); }, timeout);
  }

  function waitForAllocationData(fn, timeout = 10000) {
    const hasAllocationData = () => {
      const text = document.body?.innerText || '';
      return PRU_KNOWN_FUNDS.some(fund => text.toLowerCase().includes(fund.fundName.toLowerCase()))
        || (/Variable Investment|% of Acct Value|Price\/Unit/i.test(text) && /\bAST\b/i.test(text));
    };

    if (hasAllocationData()) { fn(); return; }
    const obs = new MutationObserver(() => {
      if (hasAllocationData()) { obs.disconnect(); fn(); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); fn(); }, timeout);
  }

  /** Extract "$20,390.83" from an element that puts cents in a <sup>. */
  function extractBalance(el) {
    if (!el) return '';
    const raw = (el.innerText || el.textContent || '')
      .replace(/\s+/g, '').replace(/cents/gi, '');
    const m = raw.match(/\$[\d,]+\.?\d*/);
    return m ? m[0] : '';
  }

  /** MM/DD/YYYY → YYYY-MM-DD */
  function isoDate(raw) {
    const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    return m ? `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}` : raw;
  }

  // ── Accounts page ─────────────────────────────────────────────────────────

  function scrapeAccounts() {
    const accounts = [];
    document.querySelectorAll('[data-qa="product-type"]').forEach((el) => {
      const name = el.textContent.trim();
      const card = el.closest('pru-account-card, pru-annuity-card, article, section')
                || el.parentElement?.parentElement?.parentElement?.parentElement;

      const accountValue     = extractBalance((card || document).querySelector('.account-attribute-value'));
      const deathBenefitValue = extractBalance((card || document).querySelector('[data-qa="primary-value"]'));
      const asOfRaw = document.querySelector('[data-qa="as-of"]')?.textContent?.trim() || '';
      const asOfDate = (asOfRaw.match(/\d{2}\/\d{2}\/\d{4}/) || [''])[0] || asOfRaw.replace(/^As of\s*/i,'');

      accounts.push({ name, accountValue, deathBenefitValue, asOfDate });
      console.log(`Pru account: "${name}" value=${accountValue}`);
    });

    if (!accounts.length) { console.warn('Prudential: no accounts found'); return; }

    const allocationSnapshot = scrapeAllocationSnapshot(accounts[0]);
    const scrapedAt = new Date().toISOString();

    chrome.storage.local.get('prudentialAnnuity', ({ prudentialAnnuity }) => {
      chrome.storage.local.set({
        prudentialAnnuity: { ...(prudentialAnnuity || {}), accounts, lastWebsiteSyncAt: scrapedAt },
        prudentialLastWebsiteSyncAt: scrapedAt,
      });
    });

    saveAllocationSnapshot(allocationSnapshot);
  }

  function scrapeAllocationSnapshot(account) {
    const rows = scrapeAllocationRowsFromVisibleText();
    if (!rows.length) return null;

    const effectiveDate = isoDate((account?.asOfDate?.match(/\d{1,2}\/\d{1,2}\/\d{4}/) || [''])[0] || account?.asOfDate || '');
    return {
      id: `scraped-pru-${Date.now()}`,
      accountId: `pru:${account?.name || 'Prudential'}`,
      sourceAccountName: account?.name || 'Prudential',
      effectiveDate: /^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) ? effectiveDate : new Date().toISOString().slice(0, 10),
      capturedAt: new Date().toISOString(),
      source: 'scraped',
      rows,
      notes: 'Scraped from visible Prudential allocation text',
    };
  }

  function scrapeInvestmentAllocationPage() {
    chrome.storage.local.get('prudentialAnnuity', ({ prudentialAnnuity }) => {
      const storedAccount = (prudentialAnnuity?.accounts || [])[0] || null;
      const fallbackName = findPageAccountName() || 'Prudential Annuity';
      const account = storedAccount || { name: fallbackName, asOfDate: findPageAsOfDate() };
      const rows = scrapeAllocationRowsFromStructuredDom();
      const fallbackRows = scrapeAllocationRowsFromVisibleText();
      const mergedRows = mergeAllocationRows([...rows, ...fallbackRows]);

      if (!mergedRows.length) {
        console.warn('Pru allocation page: no allocation rows found');
        chrome.runtime.sendMessage({ type: 'pru_allocation_snapshot_empty' });
        return;
      }

      const effectiveDate = parseIsoOrToday(findPageAsOfDate() || account.asOfDate);
      saveAllocationSnapshot({
        id: `scraped-pru-allocation-${Date.now()}`,
        accountId: `pru:${account.name || fallbackName}`,
        sourceAccountName: account.name || fallbackName,
        effectiveDate,
        capturedAt: new Date().toISOString(),
        source: 'scraped',
        rows: mergedRows,
        notes: 'Scraped from Prudential investment allocation page',
      });
    });
  }

  function saveAllocationSnapshot(allocationSnapshot) {
    if (!allocationSnapshot) return;
    chrome.storage.local.get('allocationSnapshots', ({ allocationSnapshots = [] }) => {
      const remaining = allocationSnapshots.filter(snapshot =>
        !(snapshot.source === 'scraped'
          && snapshot.sourceAccountName === allocationSnapshot.sourceAccountName
          && snapshot.effectiveDate === allocationSnapshot.effectiveDate)
      );
      chrome.storage.local.set({
        allocationSnapshots: [...remaining, allocationSnapshot],
        prudentialLastWebsiteSyncAt: allocationSnapshot.capturedAt || new Date().toISOString(),
      }, () => {
        chrome.runtime.sendMessage({
          type: 'pru_allocation_snapshot_saved',
          snapshotId: allocationSnapshot.id,
          rowCount: allocationSnapshot.rows.length,
        });
      });
    });
    console.log('Pru allocation snapshot:', allocationSnapshot);
  }

  function scrapeAllocationRowsFromStructuredDom() {
    return mergeAllocationRows([
      ...scrapeAllocationRowsFromMobileBoxes(),
      ...scrapeAllocationRowsFromTables(),
    ]);
  }

  function scrapeAllocationRowsFromMobileBoxes() {
    const rows = [];
    document.querySelectorAll('.evo-datatable_mob-box, [class*="mob-box"]').forEach(box => {
      const data = {};
      box.querySelectorAll('.evo-datatable_mob-row, [class*="mob-row"]').forEach(row => {
        const label = normalizeLabel(row.querySelector('.evo-datatable_mob-label, [class*="mob-label"]')?.textContent || '');
        const value = (row.querySelector('.evo-datatable_mob-value, [class*="mob-value"]')?.textContent || '').trim();
        if (label) data[label] = value;
      });
      const row = allocationRowFromTextAndFields(box.innerText || '', data);
      if (row) rows.push(row);
    });
    return rows;
  }

  function scrapeAllocationRowsFromTables() {
    const rows = [];
    document.querySelectorAll('table').forEach(table => {
      const headers = Array.from(table.querySelectorAll('thead tr:last-child th')).map(th => normalizeLabel(th.textContent));
      table.querySelectorAll('tbody tr, tr').forEach(tr => {
        if (tr.closest('thead')) return;
        const rowHeader = tr.querySelector('th[scope="row"], th[data-label]');
        const cells = Array.from(tr.querySelectorAll('th[scope="row"], th[data-label], td'));
        if (!cells.length) return;
        const data = {};
        cells.forEach((cell, index) => {
          const label = normalizeLabel(cell.getAttribute('data-label')) || headers[index] || '';
          const value = readableCellText(cell);
          if (label) data[label] = value;
        });
        const rowText = `${readableCellText(rowHeader)} ${tr.innerText || ''}`;
        const row = allocationRowFromTextAndFields(rowText, data);
        if (row) rows.push(row);
      });
    });
    return rows;
  }

  function allocationRowFromTextAndFields(rowText, data = {}) {
    const known = findKnownFund(rowText)
      || findKnownFund(Object.values(data).join(' '));
    if (!known) return null;

    const valueText = findFieldValue(data, ['value', 'account value', 'acct value', 'current value', 'investment value', 'balance']);
    const unitText = findFieldValue(data, ['units', 'unit', 'number of units']);
    const priceText = findFieldValue(data, ['unit value', 'unit price', 'price/unit', 'price per unit', 'price', 'current price', 'contract price']);
    const weightText = findFieldValue(data, ['% of acct value', 'allocation', 'percent', 'percentage', 'percent of account', 'weight']);
    const inferred = inferAllocationNumbers(rowText);

    return {
      fundName: known.fundName,
      weight: parsePercentValue(weightText) ?? inferred.weight,
      value: parseMoneyValue(valueText) ?? parsePlainNumber(valueText) ?? inferred.value,
      units: parsePlainNumber(unitText) ?? inferred.units,
      contractPrice: parseMoneyValue(priceText) ?? parsePlainNumber(priceText) ?? inferred.contractPrice,
      proxySymbol: known.proxySymbol,
      ftMorningstarId: known.ftMorningstarId,
    };
  }

  function mergeAllocationRows(rows) {
    const byFund = new Map();
    rows.filter(Boolean).forEach(row => {
      const existing = byFund.get(row.fundName) || {};
      byFund.set(row.fundName, {
        ...existing,
        ...row,
        weight: firstFinite(existing.weight, row.weight),
        units: firstFinite(existing.units, row.units),
        contractPrice: firstFinite(existing.contractPrice, row.contractPrice),
        value: firstFinite(existing.value, row.value),
      });
    });
    return [...byFund.values()].filter(row =>
      Number.isFinite(row.weight)
      || Number.isFinite(row.value)
      || Number.isFinite(row.units)
      || Number.isFinite(row.contractPrice)
    );
  }

  function scrapeAllocationRowsFromVisibleText() {
    const lines = (document.body.innerText || '')
      .split(/\r?\n/)
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    return PRU_KNOWN_FUNDS.map(fund => {
      const index = lines.findIndex(line => line.toLowerCase().includes(fund.fundName.toLowerCase()));
      if (index < 0) return null;
      const chunk = lines.slice(index, index + 10).join(' ');
      const inferred = inferAllocationNumbers(chunk);
      return {
        fundName: fund.fundName,
        weight: inferred.weight,
        value: inferred.value,
        units: inferred.units,
        contractPrice: inferred.contractPrice,
        proxySymbol: fund.proxySymbol,
        ftMorningstarId: fund.ftMorningstarId,
      };
    }).filter(row =>
      row && (Number.isFinite(row.weight) || Number.isFinite(row.value) || Number.isFinite(row.units))
    );
  }

  function inferAllocationNumbers(text) {
    const weight = parsePercentValue(text);
    const moneyValues = [...String(text || '').matchAll(/\$\s*([0-9][0-9,]*(?:\.\d+)?)/g)]
      .map(match => parseFloat(match[1].replace(/,/g, '')))
      .filter(Number.isFinite);
    const value = moneyValues.length ? Math.max(...moneyValues) : undefined;
    const contractPrice = moneyValues.filter(n => n !== value).sort((a, b) => a - b)[0];
    const plainNumbers = [...String(text || '').matchAll(/(?:^|\s)([0-9][0-9,]*(?:\.\d+)?)(?:\s|$)/g)]
      .map(match => parseFloat(match[1].replace(/,/g, '')))
      .filter(n => Number.isFinite(n) && n !== weight && n !== value && n !== contractPrice);
    const units = plainNumbers.find(n => n > 0);
    return { weight, value, units, contractPrice };
  }

  function findKnownFund(text) {
    const raw = compactComparableText(text);
    return PRU_KNOWN_FUNDS.find(fund => raw.includes(compactComparableText(fund.fundName))) || null;
  }

  function findFieldValue(data, names) {
    const normalizedNames = names.map(normalizeLabel);
    const entries = Object.entries(data || {}).map(([key, value]) => [normalizeLabel(key), value]);

    for (const [key, value] of entries) {
      if (normalizedNames.includes(key)) return value;
    }

    for (const [key, value] of entries) {
      if (normalizedNames.some(name => name !== 'value' && key.includes(name))) return value;
    }
    return '';
  }

  function normalizeLabel(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/\*+$/, '')
      .replace(/\s+/g, ' ');
  }

  function readableCellText(cell) {
    if (!cell) return '';
    const title = cell.querySelector('[title]')?.getAttribute('title') || cell.getAttribute('title') || '';
    const text = (cell.textContent || '').replace(/\s+/g, ' ').trim();
    return text || title || '';
  }

  function compactComparableText(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  function parseMoneyValue(value) {
    const match = String(value || '').match(/\$?\s*([0-9][0-9,]*(?:\.\d+)?)/);
    if (!match) return undefined;
    const parsed = parseFloat(match[1].replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  function parsePlainNumber(value) {
    const match = String(value || '').match(/([0-9][0-9,]*(?:\.\d+)?)/);
    if (!match) return undefined;
    const parsed = parseFloat(match[1].replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  function parsePercentValue(value) {
    const match = String(value || '').match(/([0-9][0-9,]*(?:\.\d+)?)\s*%/);
    if (!match) return undefined;
    const parsed = parseFloat(match[1].replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  function firstFinite(a, b) {
    return Number.isFinite(a) ? a : b;
  }

  function parseIsoOrToday(value) {
    const date = isoDate((String(value || '').match(/\d{1,2}\/\d{1,2}\/\d{4}/) || [''])[0] || value || '');
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10);
  }

  function findPageAsOfDate() {
    const text = document.body?.innerText || '';
    const match = text.match(/(?:as\s+of\s*)?(\d{1,2}\/\d{1,2}\/\d{4})/i);
    return match ? match[1] : '';
  }

  function findPageAccountName() {
    const lines = (document.body?.innerText || '')
      .split(/\r?\n/)
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    return lines.find(line => /advanced series|annuity|fortitude/i.test(line)) || '';
  }

  // ── Transactions — paginate through all pages ─────────────────────────────

  async function scrapeAllTransactionPages() {
    // Step 1: try to maximize items-per-page so we need fewer page turns.
    // The "Transactions Per Page" dropdown might let us load 100 at once.
    await trySetMaxPerPage();

    const allTx = [];
    let page = 0;
    const MAX_PAGES = 20;

    while (page < MAX_PAGES) {
      // Scrape the current page's transactions
      const pageTx = scrapeCurrentTransactions();
      allTx.push(...pageTx);
      console.log(`Pru tx page ${page + 1}: ${pageTx.length} transactions (total so far: ${allTx.length})`);

      // Try to go to the next page
      const advanced = await goToNextPage();
      if (!advanced) break;
      page++;
    }

    // Deduplicate raw scraped transactions by date+name+amount key
    const seen = new Set();
    const unique = allTx.filter(tx => {
      const key = `${tx.date}|${tx.name}|${tx.grossAmount}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });

    console.log(`Pru tx total unique: ${unique.length}`);
    const scrapedAt = new Date().toISOString();
    chrome.storage.local.get('prudentialAnnuity', ({ prudentialAnnuity }) => {
      chrome.storage.local.set(
        {
          prudentialAnnuity: { ...(prudentialAnnuity || {}), transactions: unique, lastWebsiteSyncAt: scrapedAt },
          prudentialLastWebsiteSyncAt: scrapedAt,
        },
        () => {
          // Notify the popup that scraping is complete
          chrome.runtime.sendMessage({ type: 'pru_sync_done', count: unique.length });
        }
      );
    });
  }

  /** Scrape all .evo-datatable_mob-box cards currently visible. */
  function scrapeCurrentTransactions() {
    const results = [];
    document.querySelectorAll('.evo-datatable_mob-box').forEach(box => {
      const data = {};
      box.querySelectorAll('.evo-datatable_mob-row').forEach(row => {
        const label = (row.querySelector('.evo-datatable_mob-label')?.textContent || '')
          .trim().toLowerCase().replace(/\*+$/, '');
        const value = (row.querySelector('.evo-datatable_mob-value')?.textContent || '').trim();
        if (label) data[label] = value;
      });

      const rawDate   = data['date'] || '';
      const date      = rawDate ? isoDate(rawDate) : '';
      const type      = data['type']   || '';
      const name      = data['name']   || '';
      const grossAmt  = data['gross amount'] || '';
      const netAmt    = data['net amount']   || '';
      const status    = data['status'] || '';

      if (!date || !type) return;  // header artefact
      const numGross = parseFloat(grossAmt.replace(/[^0-9.-]/g, ''));
      if (type === 'Non-Financial' && (!numGross || numGross === 0)) return;

      results.push({ date, type, name, grossAmount: grossAmt, netAmount: netAmt, status });
    });
    return results;
  }

  /** Try to set the "Transactions Per Page" dropdown to its maximum option. */
  async function trySetMaxPerPage() {
    // Look for a <select> near the label text "Transactions Per Page"
    const selects = Array.from(document.querySelectorAll('select'));
    for (const sel of selects) {
      const label = sel.closest('label, div')?.textContent || '';
      const isPerPage = /transactions per page/i.test(label) ||
                        sel.id?.toLowerCase().includes('perpage') ||
                        sel.name?.toLowerCase().includes('perpage');
      if (isPerPage && sel.options.length > 1) {
        const maxOpt = Array.from(sel.options).reduce((best, opt) => {
          const v = parseInt(opt.value, 10);
          return (!isNaN(v) && v > (parseInt(best.value, 10) || 0)) ? opt : best;
        }, sel.options[0]);
        if (maxOpt.value !== sel.value) {
          sel.value = maxOpt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(1500);  // wait for table to reload
          console.log(`Pru: set transactions-per-page to ${maxOpt.value}`);
        }
        break;
      }
    }
  }

  /**
   * Find and click the "Next Page" button.
   * Returns true if navigation happened, false if no next page.
   */
  async function goToNextPage() {
    const nextBtn = findNextButton();
    if (!nextBtn) return false;

    // Snapshot the current first transaction to detect page change
    const snapshot = document.querySelector('.evo-datatable_mob-value')?.textContent?.trim() || '';

    nextBtn.click();

    // Wait up to 4 s for the table content to change
    const changed = await waitForContentChange(snapshot, 4000);
    if (!changed) {
      console.log('Pru: next-page click did not change content — stopping pagination');
      return false;
    }
    return true;
  }

  /** Find a non-disabled "Next" navigation button using multiple selector strategies. */
  function findNextButton() {
    const candidates = [
      // Common aria/title patterns for next-page buttons
      'button[title="Next Page"]:not([disabled])',
      'button[title="Next"]:not([disabled])',
      '[aria-label="Next Page"]:not([disabled])',
      '[aria-label="Next"]:not([disabled])',
      // Salesforce / nds pagination patterns
      '.nds-button[title*="Next"]:not([disabled])',
      '.evo-btn[title*="Next"]:not([disabled])',
      // Generic: a button whose visible text is ">" or "›" or "Next"
    ];

    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && !el.disabled) return el;
    }

    // Text-based fallback: scan all buttons for "Next" or "›" or ">"
    for (const btn of document.querySelectorAll('button:not([disabled])')) {
      const txt = btn.textContent?.trim();
      if (/^(next|›|»|>)$/i.test(txt)) return btn;
    }

    return null;
  }

  /** Poll until the first visible transaction text differs from snapshot (page changed). */
  function waitForContentChange(snapshot, timeout) {
    return new Promise(resolve => {
      const start = Date.now();
      const check = () => {
        const current = document.querySelector('.evo-datatable_mob-value')?.textContent?.trim() || '';
        if (current !== snapshot) { resolve(true); return; }
        if (Date.now() - start >= timeout) { resolve(false); return; }
        setTimeout(check, 200);
      };
      setTimeout(check, 300);  // first check after 300 ms
    });
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
})();
