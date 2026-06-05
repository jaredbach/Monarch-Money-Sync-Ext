(() => {
  console.log("🔍 Mohela Sync: Running content script...");

  // Double-check we're on the Mohela account summary page
  if (!window.location.href.includes("mohela.studentaid.gov")) {
    console.log("Not on Mohela, skipping...");
    return;
  }

  const data = { loans: [] };

  // Loop through each loan row (one per <tr>)
  document.querySelectorAll("tr").forEach(row => {
    const link = row.querySelector("a[href*='/Loans/LoanDetails']");
    if (!link) return; // skip rows that aren't loans

    const name = link.textContent.trim();

  const currentBalance = row.querySelector(".loanDetails div:nth-of-type(3)")?.innerText.trim() || "";
    const interestRate = row.querySelector(".loanDetails div:nth-of-type(6)")?.innerText.trim() || "";
    const repaymentPlan = row.querySelector(".loanDetails .text-break")?.innerText.trim() || "";

    const type = row.querySelector("td[title='Type'], td.d-none.d-md-table-cell[title]")?.title?.trim() || "";
    const dueDate = row.querySelector(".amount-section .textoverflow")?.innerText.trim() || "";
    const status = row.querySelector(".status.textoverflow")?.innerText.trim() || "";
    const autoPay = row.querySelector(".autoPay .sr-only")?.textContent.includes("Enrolled") ? "Yes" : "No";
    const rowText = row.innerText?.replace(/\u00A0/g, " ").trim() || "";

    data.loans.push({
      name,
      currentBalance,
      interestRate,
      repaymentPlan,
      type,
      dueDate,
      status,
      autoPay,
      rowText
    });
  });

  // Grab total current balance
  // Grab total current balance and total number of loans from the section header
  // Prefer the explicit span elements inside the section header (handles &nbsp; and spacing)
  try {
    const tbSpan = document.querySelector('.section-header .loan:nth-of-type(1) span');
    if (tbSpan) {
      // normalize non-breaking spaces and trim
      const txt = tbSpan.textContent.replace(/\u00A0/g, ' ').trim();
      const match = txt.match(/\$[\d,]+\.\d{2}/);
      if (match) data.totalBalance = match[0];
      else if (txt) data.totalBalance = txt;
    }

    const tlSpan = document.querySelector('.section-header .loan:nth-of-type(2) span');
    if (tlSpan) {
      const txt = tlSpan.textContent.replace(/\u00A0/g, ' ').trim();
      const match = txt.match(/\d+/);
      if (match) data.totalLoans = match[0];
      else if (txt) data.totalLoans = txt;
    }
  } catch (e) {
    // ignore selector errors and fallback to previous fuzzy search below
    console.warn('Mohela Sync: section-header selector failed', e);
  }

  // Fallback: old fuzzy search if explicit selectors didn't find values
  if (!data.totalBalance) {
    const totalBalanceEl = Array.from(document.querySelectorAll("*"))
      .find(el => el.textContent && el.textContent.includes("Total Current Balance"));
    if (totalBalanceEl) {
      const match = totalBalanceEl.textContent.match(/\$[\d,]+\.\d{2}/);
      if (match) data.totalBalance = match[0];
    }
  }

  if (!data.totalLoans) {
    const totalLoansEl = Array.from(document.querySelectorAll("*"))
      .find(el => el.textContent && el.textContent.includes("Total Number of Loans"));
    if (totalLoansEl) {
      const match = totalLoansEl.textContent.match(/\d+/);
      if (match) data.totalLoans = match[0];
    }
  }

  // ✅ Save the scraped data
  // --- Transactions scraping: find recent transaction entries (date + per-account amounts)
  try {
    data.transactions = [];
    // Each .loan-title block contains a date and a list of accounts; the matching amounts live in a sibling td.amount-section
    document.querySelectorAll('.loan-title').forEach(loanTitle => {
      const dateEl = loanTitle.querySelector('.textoverflow');
      const dateRaw = dateEl ? dateEl.textContent.trim() : '';
      // normalize date MM/DD/YYYY -> YYYY-MM-DD when possible
      let date = dateRaw;
      const dm = dateRaw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (dm) {
        const mm = dm[1].padStart(2, '0');
        const dd = dm[2].padStart(2, '0');
        const yyyy = dm[3];
        date = `${yyyy}-${mm}-${dd}`;
      }

      const row = loanTitle.closest('tr');
      const amountTd = row ? row.querySelector('td.amount-section') : null;

      // account elements (titles like '1-01 Direct Loan - Subsidized')
      const accountEls = loanTitle.querySelectorAll('.elipse.bold');
      // per-account amount elements inside the amount column
      const amountEls = amountTd ? amountTd.querySelectorAll('.loanDetails .textoverflow') : [];

      if (amountEls.length === 0 && amountTd) {
        // no per-account breakdown found; use the overall amount (title or first div)
        const totalRaw = amountTd.getAttribute('title') || amountTd.querySelector('div')?.innerText || '';
        const accountRaw = accountEls[0]?.title || accountEls[0]?.textContent || '';
        data.transactions.push({ date, amount: totalRaw.trim(), accountRaw: accountRaw.trim() });
      } else {
        // zip accountEls and amountEls
        const count = Math.max(accountEls.length, amountEls.length);
        for (let i = 0; i < count; i++) {
          const acc = (accountEls[i]?.title || accountEls[i]?.textContent || '').trim();
          const amt = (amountEls[i]?.getAttribute('title') || amountEls[i]?.textContent || '').trim();
          // only push if we have either an account or an amount
          if (acc || amt) data.transactions.push({ date, amount: amt, accountRaw: acc });
        }
      }
    });
  } catch (e) {
    console.warn('Mohela Sync: transactions scraping failed', e);
  }

  data.lastWebsiteSyncAt = new Date().toISOString();

  chrome.storage.local.set({ mohelaLoans: data, mohelaLastWebsiteSyncAt: data.lastWebsiteSyncAt }, () => {
    console.log("✅ Mohela loan data saved:", data);
  });
})();
