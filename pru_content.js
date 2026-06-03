(() => {
  const url = window.location.href;

  if (url.includes('prudential.com/mypru/myaccounts')) {
    waitFor('[data-qa="product-type"]', scrapeAccounts);
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

    chrome.storage.local.get('prudentialAnnuity', ({ prudentialAnnuity }) => {
      chrome.storage.local.set({ prudentialAnnuity: { ...(prudentialAnnuity || {}), accounts } });
    });
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
    chrome.storage.local.get('prudentialAnnuity', ({ prudentialAnnuity }) => {
      chrome.storage.local.set(
        { prudentialAnnuity: { ...(prudentialAnnuity || {}), transactions: unique } },
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
