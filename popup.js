// ─── Constants ────────────────────────────────────────────────────────────────
const MONARCH_ENDPOINTS = [
  { app: 'https://app.monarchmoney.com', api: 'https://api.monarchmoney.com' },
  { app: 'https://app.monarch.com', api: 'https://api.monarch.com' },
];
const MONARCH_API  = MONARCH_ENDPOINTS[0].api;
const MONARCH_APP  = MONARCH_ENDPOINTS[0].app;
const GRAPHQL_URL  = `${MONARCH_API}/graphql`;

// ─── Headers ──────────────────────────────────────────────────────────────────
// The declarativeNetRequest rule in monarch_rules.json rewrites the Origin and
// Referer headers to https://app.monarchmoney.com at the network level, which satisfies
// Django's CSRF origin check.  We still need to send the X-Csrftoken header here.
function monarchHeaders(csrfToken) {
  const h = {
    'Accept': '*/*',
    'Content-Type': 'application/json',
    'Client-Platform': 'web',
    'monarch-client': 'web',
    'monarch-client-version': '2025.05',
  };
  if (csrfToken) h['X-Csrftoken'] = csrfToken;
  return h;
}

// ─── Session detection ────────────────────────────────────────────────────────
// Monarch sets cookies on shared subdomains which chrome.cookies
// may miss depending on exact domain permissions.  The most reliable approach
// is to inject a tiny script into an open Monarch tab and read
// document.cookie directly — same-origin, no permission edge-cases.

const MONARCH_TAB_PATTERNS = [
  'https://app.monarchmoney.com/*',
  'https://app.monarch.com/*',        // legacy URL, still used by some users
];

async function getCsrfFromTab() {
  const tabs = await chrome.tabs.query({ url: MONARCH_TAB_PATTERNS });
  if (!tabs.length) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: () => {
        const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
        return m ? decodeURIComponent(m[1]) : null;
      },
    });
    return results?.[0]?.result || null;
  } catch (e) {
    console.warn('Tab injection failed:', e);
    return null;
  }
}

// Combined: try tab injection first (most reliable), then fall back to
// chrome.cookies for every plausible domain/subdomain.
async function getCsrfToken() {
  const fromTab = await getCsrfFromTab();
  if (fromTab) return fromTab;

  const urls = [
    'https://api.monarchmoney.com',
    'https://app.monarchmoney.com',
    'https://api.monarch.com',
    'https://app.monarch.com',
    'https://monarch.com',
  ];
  for (const url of urls) {
    const cookie = await new Promise(resolve =>
      chrome.cookies.get({ url, name: 'csrftoken' }, resolve)
    );
    if (cookie?.value) return cookie.value;
  }
  return null;
}

async function hasSession() {
  // Presence of a csrftoken is a strong signal the user is logged in
  const csrf = await getCsrfToken();
  if (csrf) return true;

  // Also check for sessionid via chrome.cookies (it's httpOnly so we can't
  // read its value from document.cookie, but the extension API can detect it)
  const urls = [
    'https://api.monarchmoney.com',
    'https://app.monarchmoney.com',
    'https://api.monarch.com',
    'https://app.monarch.com',
    'https://monarch.com',
  ];
  for (const url of urls) {
    const cookie = await new Promise(resolve =>
      chrome.cookies.get({ url, name: 'sessionid' }, resolve)
    );
    if (cookie) return true;
  }
  return false;
}

// ─── Monarch GraphQL ──────────────────────────────────────────────────────────

function monarchApiForTabUrl(tabUrl) {
  try {
    return new URL(tabUrl).hostname.endsWith('monarchmoney.com')
      ? 'https://api.monarchmoney.com'
      : 'https://api.monarch.com';
  } catch {
    return MONARCH_API;
  }
}

async function monarchGraphQLFromTab(csrfToken, query, variables = {}) {
  const tabs = await chrome.tabs.query({ url: MONARCH_TAB_PATTERNS });
  if (!tabs.length) throw new Error('No open Monarch Money tab found');

  const errors = [];
  for (const tab of tabs) {
    const apiUrl = monarchApiForTabUrl(tab.url);
    try {
      const [injected] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: async ({ apiUrl, csrfToken, query, variables }) => {
          const fromCookie = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
          const token = fromCookie ? decodeURIComponent(fromCookie[1]) : csrfToken;
          try {
            const resp = await fetch(`${apiUrl}/graphql`, {
              method: 'POST',
              credentials: 'include',
              headers: {
                'Accept': '*/*',
                'Content-Type': 'application/json',
                'Client-Platform': 'web',
                'monarch-client': 'web',
                'monarch-client-version': '2025.05',
                ...(token ? { 'X-Csrftoken': token } : {}),
              },
              body: JSON.stringify({ query, variables }),
            });
            const text = await resp.text();
            if (!resp.ok) {
              return { ok: false, error: `Monarch API HTTP ${resp.status}${text ? ' - ' + text.slice(0, 240) : ''}` };
            }
            const json = JSON.parse(text);
            if (json.errors?.length) {
              return { ok: false, error: json.errors.map(e => e.message).join('; ') };
            }
            return { ok: true, data: json.data };
          } catch (e) {
            return { ok: false, error: e.message || String(e) };
          }
        },
        args: [{ apiUrl, csrfToken, query, variables }],
      });

      const result = injected?.result;
      if (result?.ok) return result.data;
      errors.push(`${apiUrl}: ${result?.error || 'empty injected result'}`);
    } catch (e) {
      errors.push(`${apiUrl}: ${e.message}`);
    }
  }

  throw new Error(errors.join(' | '));
}

async function monarchGraphQLViaExtension(csrfToken, query, variables = {}) {
  let resp;
  let lastError = null;
  for (const endpoint of MONARCH_ENDPOINTS) {
    const url = `${endpoint.api}/graphql`;
    try {
      resp = await fetch(url, {
        method: 'POST',
        credentials: 'include',        // sends sessionid + csrftoken cookies
        headers: monarchHeaders(csrfToken),
        body: JSON.stringify({ query, variables }),
      });
    } catch (e) {
      lastError = new Error(`${endpoint.api}: Network error: ${e.message}`);
      continue;
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      lastError = new Error(`${endpoint.api}: Monarch API HTTP ${resp.status}${body ? ' - ' + body.slice(0, 240) : ''}`);
      continue;
    }

    const json = await resp.json();
    if (json.errors?.length) {
      lastError = new Error(`${endpoint.api}: ${json.errors.map(e => e.message).join('; ')}`);
      continue;
    }
    return json.data;
  }

  throw lastError || new Error('Monarch API request failed');
}

async function monarchGraphQL(csrfToken, query, variables = {}) {
  try {
    return await monarchGraphQLFromTab(csrfToken, query, variables);
  } catch (e) {
    console.warn('Monarch tab GraphQL failed; trying extension fetch:', e.message);
    try {
      return await monarchGraphQLViaExtension(csrfToken, query, variables);
    } catch (fallbackError) {
      throw new Error(`Tab fetch failed: ${e.message}; extension fetch failed: ${fallbackError.message}`);
    }
  }
}

async function monarchFetchAccounts(csrfToken) {
  const data = await monarchGraphQL(csrfToken, `
    query GetAccounts {
      accounts {
        id
        displayName
        displayBalance
        isManual
        type { name display }
      }
    }
  `);
  return data?.accounts || [];
}

/**
 * Fetch all Monarch categories and return a map of role → categoryId:
 *   { transfer, income, fees, default }
 *
 * Mohela loan transactions always use `transfer`.
 * Prudential transactions use the role that matches their type:
 *   Investment  → income
 *   Withdrawal  → fees
 *   Reallocation → transfer
 */
async function monarchFetchCategories(csrfToken) {
  const data = await monarchGraphQL(csrfToken, `
    query GetCategories {
      categories { id name group { id name type } }
    }
  `);
  const cats = data?.categories || [];

  // Log all categories so we can see exactly what's available
  console.log('Monarch categories:', cats.map(c => `${c.name} (group: ${c.group?.name}, type: ${c.group?.type})`));

  // Find by name match first
  const findByName = (...terms) => {
    for (const t of terms) {
      const c = cats.find(c => new RegExp(t, 'i').test(c.name));
      if (c) return c.id;
    }
    return null;
  };

  // Find by group type — Monarch uses "expense", "income", "transfer" etc.
  const findByGroupType = (groupType, ...nameHints) => {
    const inGroup = cats.filter(c =>
      c.group?.type?.toLowerCase() === groupType.toLowerCase()
    );
    // Try name hints first within that group
    for (const hint of nameHints) {
      const c = inGroup.find(c => new RegExp(hint, 'i').test(c.name));
      if (c) return c.id;
    }
    // Fall back to the first category in that group
    return inGroup[0]?.id || null;
  };

  const fees = findByName('financial service fee', 'service fee', 'bank fee', 'fees', 'charges')
            || findByGroupType('expense', 'fee', 'charge', 'financial')
            || findByGroupType('expense');

  const transfer = findByName('transfer', 'loan payment', 'loan')
                || findByGroupType('transfer');

  const income = findByName('investment income', 'interest income', 'dividend income', 'other income', 'income')
              || findByGroupType('income');

  // Interest expense — used for daily student-loan interest accrual backfill.
  // Try specific names first, then any expense-group category with "interest" in the name,
  // then fall back to the generic fees bucket.
  const interest = findByName('student loan interest', 'loan interest', 'interest expense', 'interest')
                || findByGroupType('expense', 'interest')
                || fees;

  const result = { transfer, income, fees, interest, default: cats[0]?.id || null };
  console.log('Resolved category IDs:', result);
  return result;
}

/**
 * Pick the category ID for a Prudential annuity transaction.
 * Withdrawals / service fees / admin charges → fees (debit).
 * Everything else (investments, credits, reallocations, etc.) → transfer.
 */
function pruCategoryId(pruType, txName, categories) {
  const type = (pruType || '').toLowerCase();
  const name = (txName  || '').toLowerCase();

  const isDebit = type === 'withdrawal'
    || name.includes('fee')
    || name.includes('charge')
    || name.includes('admin');

  return isDebit
    ? (categories.fees     || categories.default)
    : (categories.transfer || categories.default);
}

/**
 * Fetch existing Monarch transactions and return a Set of fingerprints:
 *   "accountId|YYYY-MM-DD|absAmount"
 *
 * Throws if the query fails — callers MUST abort the sync in that case rather
 * than silently skipping or creating duplicates.
 */
async function monarchFetchExistingTransactions(csrfToken, accountIds, lookbackDays = 730) {
  if (!accountIds?.length) return new Set();

  const startDate = new Date(Date.now() - lookbackDays * 86400000)
    .toISOString().slice(0, 10);
  const endDate = new Date().toISOString().slice(0, 10);
  const pageSize = 500;

  // Use variables for pagination rather than inline literals, and try both the
  // current and legacy account filter names before falling back to broader checks.
  // Try progressively simpler queries until one works
  const attempts = [
    // Attempt 1: full current filter shape from the Monarch Money web client/API library
    {
      label: 'filtered-current',
      query: `query GetTransactionsForDedup($filters: TransactionFilterInput, $limit: Int, $offset: Int) {
        allTransactions(filters: $filters) {
          totalCount
          results(limit: $limit, offset: $offset) { id date amount account { id } }
        }
      }`,
      vars: { filters: { accounts: accountIds, startDate, endDate } },
    },
    // Attempt 2: older public examples used accountIds.
    {
      label: 'filtered-legacy-accountIds',
      query: `query GetTransactionsForDedup($filters: TransactionFilterInput, $limit: Int, $offset: Int) {
        allTransactions(filters: $filters) {
          totalCount
          results(limit: $limit, offset: $offset) { id date amount account { id } }
        }
      }`,
      vars: { filters: { accountIds, startDate, endDate } },
    },
    // Attempt 3: no account filter, in case Monarch changes/removes that input field again
    {
      label: 'date-only-filter',
      query: `query GetTransactionsForDedup($filters: TransactionFilterInput, $limit: Int, $offset: Int) {
        allTransactions(filters: $filters) {
          totalCount
          results(limit: $limit, offset: $offset) { id date amount account { id } }
        }
      }`,
      vars: { filters: { startDate, endDate } },
    },
    // Attempt 4: no filter at all, just limit
    {
      label: 'no-filter',
      query: `query GetTransactionsForDedup($limit: Int, $offset: Int) {
        allTransactions {
          totalCount
          results(limit: $limit, offset: $offset) { id date amount account { id } }
        }
      }`,
      vars: {},
    },
  ];

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const fingerprints = new Set();
      let offset = 0;
      let totalCount = null;
      let attemptFailed = false;

      while (true) {
        const data = await monarchGraphQL(csrfToken, attempt.query, {
          ...attempt.vars,
          limit: pageSize,
          offset,
        });
        const results = data?.allTransactions?.results;

        if (!Array.isArray(results)) {
          console.warn(`Dedup attempt "${attempt.label}" returned unexpected shape:`, data);
          lastError = new Error(`Unexpected response shape from attempt "${attempt.label}"`);
          attemptFailed = true;
          break;
        }

        const reportedCount = Number(data.allTransactions.totalCount);
        if (Number.isFinite(reportedCount)) totalCount = reportedCount;

        for (const tx of results) {
          if (tx.account?.id && tx.date && tx.amount != null) {
            fingerprints.add(`${tx.account.id}|${tx.date}|${Math.abs(tx.amount).toFixed(2)}`);
          }
        }

        offset += results.length;
        if (results.length < pageSize || (totalCount !== null && offset >= totalCount)) break;
      }

      if (attemptFailed) continue;

      console.log(`Monarch dedup (${attempt.label}): ${fingerprints.size} fingerprints, totalCount=${totalCount}`);
      return fingerprints;

    } catch (e) {
      console.warn(`Dedup attempt "${attempt.label}" failed:`, e.message);
      lastError = e;
    }
  }

  console.error('All dedup query attempts failed. Last error:', lastError);
  throw new Error(`All dedup query attempts failed. Last error: ${lastError?.message || 'unknown error'}`);
}

async function monarchUpdateBalance(csrfToken, accountId, balance) {
  return monarchGraphQL(csrfToken, `
    mutation Common_UpdateAccount($input: UpdateAccountMutationInput!) {
      updateAccount(input: $input) {
        account { id displayName displayBalance __typename }
        errors { message __typename }
        __typename
      }
    }
  `, { input: { id: accountId, displayBalance: balance } });
}

async function monarchCreateTransaction(csrfToken, accountId, date, amount, categoryId, notes, merchant) {
  return monarchGraphQL(csrfToken, `
    mutation Common_CreateTransactionMutation($input: CreateTransactionMutationInput!) {
      createTransaction(input: $input) {
        errors { message __typename }
        transaction { id __typename }
        __typename
      }
    }
  `, {
    input: {
      date,
      accountId,
      // Preserve sign: negative = expense/debit, positive = income/credit.
      // Callers are responsible for passing the correct sign.
      amount: parseFloat(amount.toFixed(2)),
      merchantName: merchant || 'Monarch Sync',
      // Only include categoryId when we actually have one — sending null
      // causes Monarch to return a field-required validation error.
      ...(categoryId ? { categoryId } : {}),
      notes: notes || 'Synced via Chrome Ext',
      shouldUpdateBalance: false,
    },
  });
}

// ─── Monarch balance history ───────────────────────────────────────────────────

/**
 * Fetch daily balance snapshots for a Monarch account over a date range.
 * Tries three different query shapes in case the schema has changed.
 * Returns an array of {date: "YYYY-MM-DD", balance: number} objects sorted
 * ascending, or an empty array if all attempts fail (never throws).
 */
async function monarchFetchBalanceHistory(csrfToken, accountId, startDate, endDate) {
  const attempts = [
    {
      label: 'historicalBalances-on-account',
      query: `query GetAccountBalanceHistory($accountId: ID!, $startDate: Date, $endDate: Date) {
        account(id: $accountId) {
          id
          historicalBalances(startDate: $startDate, endDate: $endDate) {
            date
            balance
          }
        }
      }`,
      vars: { accountId, startDate, endDate },
      extract: d => d?.account?.historicalBalances,
    },
    {
      label: 'snapshotHistoricalBalances',
      query: `query GetSnapshotBalances($accountId: ID!, $startDate: Date, $endDate: Date) {
        snapshotHistoricalBalances(accountId: $accountId, startDate: $startDate, endDate: $endDate) {
          date
          balance
        }
      }`,
      vars: { accountId, startDate, endDate },
      extract: d => d?.snapshotHistoricalBalances,
    },
    {
      label: 'balanceHistory-on-account',
      query: `query GetBalanceHistory($accountId: ID!, $startDate: Date, $endDate: Date) {
        account(id: $accountId) {
          id
          balanceHistory(startDate: $startDate, endDate: $endDate) {
            date
            balance
          }
        }
      }`,
      vars: { accountId, startDate, endDate },
      extract: d => d?.account?.balanceHistory,
    },
  ];

  for (const attempt of attempts) {
    try {
      const data = await monarchGraphQL(csrfToken, attempt.query, attempt.vars);
      const balances = attempt.extract(data);
      if (Array.isArray(balances)) {
        console.log(`Balance history (${attempt.label}): ${balances.length} entries for ${accountId}`);
        return balances
          .map(b => ({ date: b.date, balance: parseFloat(b.balance) }))
          .filter(b => b.date && !isNaN(b.balance))
          .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
      }
    } catch (e) {
      console.warn(`Balance history attempt "${attempt.label}" failed:`, e.message);
    }
  }
  console.warn('All balance history queries failed for account', accountId);
  return [];
}

// ─── Interest accrual backfill ─────────────────────────────────────────────────

/** Federal student-loan interest was frozen during COVID forbearance through Aug 31 2023. */
const FORBEARANCE_END_DATE = '2023-09-01';

/**
 * Inspect the last two months of Monarch balance history for a single Mohela loan account.
 * For every day where the balance was unchanged from the prior recorded day ("stagnant"),
 * create a daily interest accrual transaction so Monarch's net-worth history reflects
 * the true cost of the loan.
 *
 * This runs silently as part of every sync — no user action required beyond entering
 * the rate once in Settings.
 *
 * @param {string}  csrfToken
 * @param {string}  accountId          Monarch account ID for this loan
 * @param {string}  loanName           Human-readable name, used in transaction notes
 * @param {number}  annualRatePct      e.g. 6.54 for 6.54 % APR
 * @param {object}  categories         Category map from monarchFetchCategories()
 * @param {Set}     monarchFingerprints  Live dedup set (mutated in place)
 * @param {Set}     localSynced          Local dedup set (mutated in place)
 * @returns {{ created: number, skipped: number }}
 */
async function backfillLoanInterest(
  csrfToken, accountId, loanName, annualRatePct,
  categories, monarchFingerprints, localSynced
) {
  if (!annualRatePct || isNaN(annualRatePct) || annualRatePct <= 0) {
    return { created: 0, skipped: 0 };
  }

  const today = new Date().toISOString().slice(0, 10);

  // Look back up to 60 days, but never before the forbearance end date.
  const twoMonthsAgo    = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  const lookbackStart   = twoMonthsAgo > FORBEARANCE_END_DATE ? twoMonthsAgo : FORBEARANCE_END_DATE;

  const history = await monarchFetchBalanceHistory(csrfToken, accountId, lookbackStart, today);
  if (history.length < 2) return { created: 0, skipped: 0 };

  const dailyRate = annualRatePct / 100 / 365;
  let created = 0, skipped = 0;

  // Walk consecutive pairs. When the balance didn't change between two recorded
  // snapshots, every day in that span (exclusive of the first, inclusive of the
  // second and any gap days) had interest accruing with no corresponding Monarch
  // transaction. We create one transaction per such day.
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1];
    const curr = history[i];

    // Enforce hard floor — never touch pre-forbearance dates.
    if (curr.date <= FORBEARANCE_END_DATE) continue;

    // Only act on stagnant spans (balance unchanged, within $0.01 rounding).
    if (Math.abs(curr.balance - prev.balance) > 0.01) continue;

    // Enumerate every calendar day in the stagnant gap [prev.date+1 … curr.date].
    const gapDays = gapDatesBetween(prev.date, curr.date);
    for (const day of gapDays) {
      if (day <= FORBEARANCE_END_DATE) continue;

      // Daily interest is negative — it increases what the borrower owes.
      const dailyInterest = -(prev.balance * dailyRate);
      const absAmt        = Math.abs(dailyInterest);
      if (absAmt < 0.001) continue;

      const fp = `${accountId}|${day}|${absAmt.toFixed(2)}`;
      if (monarchFingerprints.has(fp) || localSynced.has(fp)) {
        skipped++;
        continue;
      }

      try {
        const catId = categories.interest || categories.fees || categories.default;
        const result = await monarchCreateTransaction(
          csrfToken, accountId, day,
          parseFloat(dailyInterest.toFixed(2)),
          catId,
          `Daily interest accrual — ${loanName} (${annualRatePct}% APR)`,
          'MOHELA Interest'
        );
        const errs = result?.createTransaction?.errors;
        if (errs?.length) throw new Error(errs[0].message);
        monarchFingerprints.add(fp);
        localSynced.add(fp);
        created++;
      } catch (err) {
        console.warn(`Interest backfill ${day} for "${loanName}":`, err.message);
      }
    }
  }

  console.log(`Interest backfill "${loanName}": ${created} created, ${skipped} skipped`);
  return { created, skipped };
}

/**
 * Return every calendar date strictly between startDate and endDate (inclusive),
 * i.e. [startDate+1 … endDate].  Both dates are "YYYY-MM-DD" strings.
 */
function gapDatesBetween(startDate, endDate) {
  const days = [];
  const d = new Date(startDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1); // start at startDate + 1
  const end = new Date(endDate + 'T00:00:00Z');
  while (d <= end) {
    days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

// ─── Settings panel ────────────────────────────────────────────────────────────

document.getElementById('settings-toggle').addEventListener('click', async () => {
  const panel = document.getElementById('settings-panel');
  const isVisible = panel.style.display === 'block';
  panel.style.display = isVisible ? 'none' : 'block';
  if (!isVisible) await renderSettings();
});

async function renderSettings() {
  const { monarchAccounts, monarchMapping, mohelaLoans, prudentialAnnuity, loanInterestRates } =
    await chrome.storage.local.get(['monarchAccounts', 'monarchMapping', 'mohelaLoans', 'prudentialAnnuity', 'loanInterestRates']);

  const connStatus    = document.getElementById('connection-status');
  const loginStatus   = document.getElementById('login-status');
  const mappingSection = document.getElementById('mapping-section');

  loginStatus.textContent = '';

  const csrfToken  = await getCsrfToken();
  const session    = await hasSession();
  const isConnected = !!(csrfToken && session);

  if (isConnected) {
    const n = (monarchAccounts || []).length;
    connStatus.innerHTML =
      '<span style="color:#22c55e;font-size:16px;line-height:1;">&#9679;</span>'
      + `<span style="font-weight:600;">Connected</span>`
      + `<span style="color:#888;">&nbsp;&mdash;&nbsp;${n > 0 ? n + ' accounts' : 'no accounts (click Refresh)'}</span>`;
    mappingSection.style.display = 'block';
    renderMappingRows(mohelaLoans, prudentialAnnuity, monarchAccounts || [], monarchMapping || {}, loanInterestRates || {});
    updateSyncMonarchButton(true);
  } else {
    connStatus.innerHTML =
      '<span style="color:#ccc;font-size:16px;line-height:1;">&#9679;</span>'
      + '<span style="color:#888;">Not connected &mdash; open Monarch Money and log in, then click Connect</span>';
    mappingSection.style.display = 'none';
    updateSyncMonarchButton(false);
  }
}

function renderMappingRows(mohelaLoans, prudentialAnnuity, monarchAccounts, mapping, loanInterestRates = {}) {
  const container = document.getElementById('mapping-rows');
  container.innerHTML = '';

  if (monarchAccounts.length === 0) {
    container.innerHTML = '<p style="font-size:11px;color:#b36b00">No Monarch accounts loaded — click "Refresh Accounts".</p>';
    return;
  }

  // Build combined list: Mohela loans + Prudential accounts
  // Keys are prefixed to avoid collisions: Mohela uses raw name, Prudential uses "pru:<name>"
  const items = [];
  (mohelaLoans?.loans || []).forEach(l => items.push({
    key: l.name, label: l.name, group: 'Mohela',
    scrapedRate: l.interestRate || '',   // e.g. "6.54%" — scraped from Mohela page
  }));
  (prudentialAnnuity?.accounts || []).forEach(a => items.push({
    key: `pru:${a.name}`, label: a.name, group: 'Prudential',
    scrapedRate: '',
  }));

  if (items.length === 0) {
    container.innerHTML = '<p style="font-size:11px;color:#888">No accounts synced yet — sync Mohela and/or Prudential first.</p>';
    return;
  }

  let lastGroup = null;
  items.forEach(({ key, label, group, scrapedRate }) => {
    if (group !== lastGroup) {
      const hdr = document.createElement('p');
      hdr.style.cssText = 'font-size:11px;font-weight:bold;color:#555;margin:8px 0 4px;';
      hdr.textContent = group;
      container.appendChild(hdr);
      lastGroup = group;
    }

    // ── Account → Monarch mapping row ────────────────────────────────────────
    const row = document.createElement('div');
    row.className = 'mapping-row';

    const span = document.createElement('span');
    span.className = 'loan-label';
    span.title = label;
    span.textContent = label;

    const select = document.createElement('select');
    select.dataset.loanName = key;
    const none = document.createElement('option');
    none.value = ''; none.textContent = '-- select --';
    select.appendChild(none);
    monarchAccounts.forEach(acc => {
      const opt = document.createElement('option');
      opt.value = acc.id;
      opt.textContent = acc.displayName || acc.id;
      if (mapping[key] === acc.id) opt.selected = true;
      select.appendChild(opt);
    });

    row.appendChild(span);
    row.appendChild(select);
    container.appendChild(row);

    // ── Interest rate input (Mohela only) ─────────────────────────────────────
    if (group === 'Mohela') {
      // Determine the best default value: saved override > scraped from Mohela page
      let defaultRate = loanInterestRates[key] ?? '';
      if (defaultRate === '' && scrapedRate) {
        // scrapedRate looks like "6.54%" or "6.54" — strip non-numeric except dot
        const parsed = parseFloat(scrapedRate.replace(/[^0-9.]/g, ''));
        if (!isNaN(parsed) && parsed > 0) defaultRate = parsed;
      }

      const rateRow = document.createElement('div');
      rateRow.className = 'rate-row';

      const lbl = document.createElement('label');
      lbl.textContent = 'Interest rate:';
      lbl.style.paddingLeft = '4px';

      const input = document.createElement('input');
      input.type = 'number';
      input.min  = '0';
      input.max  = '30';
      input.step = '0.01';
      input.placeholder = 'e.g. 6.54';
      input.dataset.rateLoanName = key;
      if (defaultRate !== '') input.value = defaultRate;

      const hint = document.createElement('span');
      hint.className = 'rate-hint';
      hint.textContent = '% APR — used to backfill stagnant days';

      rateRow.appendChild(lbl);
      rateRow.appendChild(input);
      rateRow.appendChild(hint);
      container.appendChild(rateRow);
    }
  });
}

// ── Open Monarch Money in browser ─────────────────────────────────────────────

document.getElementById('open-monarch').addEventListener('click', () => {
  chrome.tabs.create({ url: MONARCH_APP });
});

// ── Connect (read existing browser session) ───────────────────────────────────

document.getElementById('btn-connect').addEventListener('click', async () => {
  const statusEl = document.getElementById('login-status');
  statusEl.textContent = 'Detecting session…';
  statusEl.style.color = '#555';

  // First check: is Monarch Money even open in any tab?
  const monarchTabs = await chrome.tabs.query({ url: MONARCH_TAB_PATTERNS });
  if (monarchTabs.length === 0) {
    statusEl.textContent = 'Monarch Money is not open in any tab. Click "Open Monarch Money", log in, then click Connect.';
    statusEl.style.color = '#b36b00';
    return;
  }

  const csrfToken = await getCsrfToken();
  const session   = await hasSession();

  if (!csrfToken || !session) {
    statusEl.textContent = 'Monarch tab found but no session cookie detected — make sure you are fully logged in at app.monarchmoney.com, then click Connect again.';
    statusEl.style.color = '#b36b00';
    return;
  }

  statusEl.textContent = 'Session found — loading accounts…';

  try {
    const [accounts, categories] = await Promise.all([
      monarchFetchAccounts(csrfToken),
      monarchFetchCategories(csrfToken),
    ]);
    await chrome.storage.local.set({ monarchAccounts: accounts, monarchCategories: categories });
    console.log(`Monarch: loaded ${accounts.length} accounts`, accounts);
    console.log(`Monarch: categories`, categories);
    statusEl.textContent = '';
  } catch (err) {
    statusEl.textContent = `Could not load accounts: ${err.message}`;
    statusEl.style.color = 'red';
    console.error('Monarch connect error:', err);
    await renderSettings();
    return;
  }

  await renderSettings();
});

// ── Refresh accounts ──────────────────────────────────────────────────────────

document.getElementById('refresh-accounts').addEventListener('click', async () => {
  const statusEl  = document.getElementById('login-status');
  const csrfToken = await getCsrfToken();
  if (!csrfToken) {
    statusEl.textContent = 'Session expired — click "Open Monarch Money" to log in again.';
    statusEl.style.color = '#b36b00';
    return;
  }

  statusEl.textContent = 'Refreshing…';
  statusEl.style.color = '#555';
  try {
    const [accounts, categories] = await Promise.all([
      monarchFetchAccounts(csrfToken),
      monarchFetchCategories(csrfToken),
    ]);
    await chrome.storage.local.set({ monarchAccounts: accounts, monarchCategories: categories });
    const { monarchMapping, mohelaLoans, prudentialAnnuity, loanInterestRates } =
      await chrome.storage.local.get(['monarchMapping', 'mohelaLoans', 'prudentialAnnuity', 'loanInterestRates']);
    renderMappingRows(mohelaLoans, prudentialAnnuity, accounts, monarchMapping || {}, loanInterestRates || {});
    statusEl.textContent = `Loaded ${accounts.length} accounts`;
    statusEl.style.color = 'green';
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    statusEl.style.color = 'red';
  }
});

// ── Save mapping ──────────────────────────────────────────────────────────────

document.getElementById('save-mapping').addEventListener('click', async () => {
  const mapping = {};
  document.querySelectorAll('#mapping-rows select').forEach(sel => {
    if (sel.value) mapping[sel.dataset.loanName] = sel.value;
  });

  // Persist interest rates alongside the account mapping.
  const loanInterestRates = {};
  document.querySelectorAll('#mapping-rows input[data-rate-loan-name]').forEach(input => {
    const val = parseFloat(input.value);
    if (!isNaN(val) && val > 0) loanInterestRates[input.dataset.rateLoanName] = val;
  });

  await chrome.storage.local.set({ monarchMapping: mapping, loanInterestRates });
  const statusEl = document.getElementById('login-status');
  statusEl.textContent = `Mapping saved (${Object.keys(mapping).length} account${Object.keys(mapping).length !== 1 ? 's' : ''}${Object.keys(loanInterestRates).length ? ', rates saved' : ''})`;
  statusEl.style.color = 'green';
});

// ─── Sync to Monarch ───────────────────────────────────────────────────────────

document.getElementById('sync-monarch').addEventListener('click', syncToMonarch);

async function syncToMonarch() {
  const statusEl = document.getElementById('monarch-status');
  statusEl.textContent = 'Syncing to Monarch Money…';

  const csrfToken = await getCsrfToken();
  if (!csrfToken) {
    statusEl.textContent = 'No active Monarch session. Open Settings → Open Monarch Money to log in.';
    return;
  }

  const {
    mohelaLoans, prudentialAnnuity,
    monarchMapping, monarchCategories,
    syncedTransactions: syncedRaw,
    loanInterestRates,
  } = await chrome.storage.local.get([
    'mohelaLoans', 'prudentialAnnuity',
    'monarchMapping', 'monarchCategories', 'syncedTransactions',
    'loanInterestRates',
  ]);

  // Re-fetch categories every sync so stale cached IDs never persist
  statusEl.textContent = 'Fetching categories…';
  let categories;
  try {
    categories = await monarchFetchCategories(csrfToken);
    await chrome.storage.local.set({ monarchCategories: categories });
  } catch (e) {
    console.warn('Could not fetch categories, falling back to stored or empty:', e);
    categories = monarchCategories || { transfer: null, income: null, fees: null, default: null };
  }

  if (!monarchMapping || !Object.keys(monarchMapping).length) {
    statusEl.textContent = 'No account mapping. Open ⚙️ Settings and map your accounts first.';
    return;
  }

  statusEl.textContent = 'Checking existing Monarch transactions…';

  // Collect every Monarch account ID we're about to sync to
  const allMappedAccountIds = [
    ...Object.values(monarchMapping),
  ].filter(Boolean);

  // Primary dedup: query Monarch for what it already has.
  // If this fails we STOP — never risk creating duplicates without verification.
  let monarchFingerprints;
  try {
    monarchFingerprints = await monarchFetchExistingTransactions(
      csrfToken, allMappedAccountIds
    );
  } catch (err) {
    console.error('Monarch dedup failed:', err);
    statusEl.style.whiteSpace = 'pre-wrap';
    statusEl.textContent =
      '❌ Could not load existing Monarch transactions to check for duplicates. Sync aborted.\n\n'
      + `Details: ${String(err.message || err).slice(0, 700)}`;
    return;
  }

  // Secondary dedup: local Set as a fast offline cache (still useful but no longer sole guard)
  const localSynced = new Set(Array.isArray(syncedRaw) ? syncedRaw : []);

  statusEl.textContent = 'Syncing…';
  const errors   = [];
  let balancesOk = 0, balancesErr = 0, txOk = 0, txErr = 0, txSkip = 0;
  let backfillCreated = 0, backfillSkipped = 0;

  /**
   * True if a transaction already exists in Monarch OR in our local cache.
   * fingerprint = "monarchAccountId|YYYY-MM-DD|absAmount"
   */
  function isDuplicate(accountId, date, absAmount) {
    const fp = `${accountId}|${date}|${absAmount.toFixed(2)}`;
    return monarchFingerprints.has(fp) || localSynced.has(fp);
  }

  function markSynced(accountId, date, absAmount) {
    const fp = `${accountId}|${date}|${absAmount.toFixed(2)}`;
    localSynced.add(fp);
    monarchFingerprints.add(fp); // prevent double-creation if loop runs twice
  }

  // ── 1. Mohela balances + silent interest backfill ──────────────────────────
  for (const loan of (mohelaLoans?.loans || [])) {
    const accountId = monarchMapping[loan.name];
    if (!accountId) continue;
    const balance = parseFloat((loan.currentBalance || '').replace(/ /g, ' ').replace(/[^0-9.]/g, ''));
    if (!balance || isNaN(balance)) continue;

    // Backfill stagnant days with daily interest accrual before recording the
    // new balance.  Uses the rate saved in Settings; skips silently if unset.
    const annualRate = parseFloat(loanInterestRates?.[loan.name] ?? NaN);
    if (!isNaN(annualRate) && annualRate > 0) {
      statusEl.textContent = `Checking interest history for ${loan.name}…`;
      try {
        const result = await backfillLoanInterest(
          csrfToken, accountId, loan.name, annualRate,
          categories, monarchFingerprints, localSynced
        );
        backfillCreated += result.created;
        backfillSkipped += result.skipped;
      } catch (err) {
        // Never let backfill failures block the main balance update
        console.warn(`Interest backfill failed for "${loan.name}":`, err.message);
      }
    }

    statusEl.textContent = 'Syncing…';
    try {
      const result = await monarchUpdateBalance(csrfToken, accountId, balance);
      const errs = result?.updateAccount?.errors;
      if (errs?.length) throw new Error(errs[0].message);
      balancesOk++;
    } catch (err) {
      errors.push(`Balance "${loan.name}": ${err.message}`);
      balancesErr++;
    }
  }

  // ── 2. Mohela transactions — Transfer category ─────────────────────────────
  for (const tx of (mohelaLoans?.transactions || [])) {
    const accountId = monarchMapping[tx.accountRaw];
    if (!accountId) { txSkip++; continue; }
    const amount = parseFloat((tx.amount || '').toString().replace(/[^0-9.]/g, ''));
    if (!amount || isNaN(amount)) continue;
    const absAmt = Math.abs(amount);
    const date   = tx.date || new Date().toISOString().slice(0, 10);

    if (isDuplicate(accountId, date, absAmt)) { txSkip++; continue; }

    try {
      const result = await monarchCreateTransaction(
        csrfToken, accountId, date, amount,   // Mohela payments are positive (outflow)
        categories.transfer, 'MOHELA loan payment', 'MOHELA'
      );
      const errs = result?.createTransaction?.errors;
      if (errs?.length) throw new Error(errs[0].message);
      markSynced(accountId, date, absAmt);
      txOk++;
    } catch (err) {
      errors.push(`Mohela tx ${date} $${absAmt.toFixed(2)}: ${err.message}`);
      txErr++;
    }
  }

  // ── 3. Prudential balances ──────────────────────────────────────────────────
  for (const acct of (prudentialAnnuity?.accounts || [])) {
    const accountId = monarchMapping[`pru:${acct.name}`];
    if (!accountId) continue;
    const balance = parseFloat((acct.accountValue || '').replace(/[^0-9.]/g, ''));
    if (!balance || isNaN(balance)) continue;
    try {
      const result = await monarchUpdateBalance(csrfToken, accountId, balance);
      const errs = result?.updateAccount?.errors;
      if (errs?.length) throw new Error(errs[0].message);
      balancesOk++;
    } catch (err) {
      errors.push(`Balance "${acct.name}": ${err.message}`);
      balancesErr++;
    }
  }

  // ── 4. Prudential transactions — type-based category ───────────────────────
  const pruAccountId = (() => {
    for (const acct of (prudentialAnnuity?.accounts || [])) {
      const id = monarchMapping[`pru:${acct.name}`];
      if (id) return id;
    }
    return null;
  })();

  if (pruAccountId) {
    for (const tx of (prudentialAnnuity?.transactions || [])) {
      // Preserve original sign: -30 for fees (debit), +41 for credits
      const amount = parseFloat((tx.grossAmount || '').replace(/[^0-9.-]/g, ''));
      if (!amount || isNaN(amount)) continue;
      const absAmt = Math.abs(amount);

      if (isDuplicate(pruAccountId, tx.date, absAmt)) { txSkip++; continue; }

      const catId = pruCategoryId(tx.type, tx.name, categories);
      try {
        const result = await monarchCreateTransaction(
          csrfToken, pruAccountId, tx.date, amount, // signed amount
          catId, tx.name, 'Prudential'
        );
        const errs = result?.createTransaction?.errors;
        if (errs?.length) throw new Error(errs[0].message);
        markSynced(pruAccountId, tx.date, absAmt);
        txOk++;
      } catch (err) {
        errors.push(`Pru tx ${tx.date} ${tx.name}: ${err.message}`);
        txErr++;
      }
    }
  }

  // Persist local dedup cache (secondary guard — Monarch-side is primary)
  await chrome.storage.local.set({ syncedTransactions: [...localSynced] });
  updateSyncedCount(localSynced.size);

  // ── Build status line ───────────────────────────────────────────────────────
  const parts = [];
  if (balancesOk)      parts.push(`✅ ${balancesOk} balance${balancesOk !== 1 ? 's' : ''} updated`);
  if (balancesErr)     parts.push(`❌ ${balancesErr} balance error${balancesErr !== 1 ? 's' : ''}`);
  if (backfillCreated) parts.push(`📈 ${backfillCreated} interest day${backfillCreated !== 1 ? 's' : ''} backfilled`);
  if (txOk)            parts.push(`✅ ${txOk} tx synced`);
  if (txErr)           parts.push(`❌ ${txErr} tx error${txErr !== 1 ? 's' : ''}`);
  if (txSkip)          parts.push(`⏭️ ${txSkip} skipped`);

  let statusText = parts.length ? parts.join('  ') : 'Nothing to sync.';

  // Deduplicate error messages and show the first few in the UI
  if (errors.length) {
    const unique = [...new Set(errors)];
    statusText += '\n\n' + unique.slice(0, 3).join('\n');
    if (unique.length > 3) statusText += `\n…+${unique.length - 3} more (open popup DevTools → Console for full list)`;
    console.group(`Monarch Sync — ${errors.length} errors`);
    errors.forEach((e, i) => console.log(`${i + 1}.`, e));
    console.groupEnd();
  }

  statusEl.style.whiteSpace = 'pre-wrap';
  statusEl.textContent = statusText;
}

// ─── Tab switching ─────────────────────────────────────────────────────────────

document.getElementById('tab-mohela').addEventListener('click', () => switchTab('mohela'));
document.getElementById('tab-pru').addEventListener('click',    () => switchTab('pru'));

function switchTab(name) {
  document.getElementById('panel-mohela').style.display = name === 'mohela' ? '' : 'none';
  document.getElementById('panel-pru').style.display    = name === 'pru'    ? '' : 'none';
  document.getElementById('tab-mohela').classList.toggle('tab-active', name === 'mohela');
  document.getElementById('tab-pru').classList.toggle('tab-active',    name === 'pru');
}

// ─── Mohela Sync Now ───────────────────────────────────────────────────────────

document.getElementById('sync').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  setTimeout(loadData, 1500);
});

// ─── Prudential Sync Now ───────────────────────────────────────────────────────

const PRU_ACCOUNTS_URL     = 'https://www.prudential.com/mypru/myaccounts/';
const PRU_TRANSACTIONS_URL = 'https://myservice.prudential.com/fliac1/s/pru-ann360-transactions';

document.getElementById('sync-pru').addEventListener('click', async () => {
  // Use a dedicated status line — never overwrite the data card while syncing
  const statusEl = document.getElementById('pru-sync-status');

  const tabs = await chrome.tabs.query({
    url: ['https://www.prudential.com/mypru/myaccounts/*', 'https://myservice.prudential.com/*'],
  });

  if (tabs.length === 0) {
    statusEl.innerHTML =
      '&#9888; No open Prudential tab found. '
      + '<a href="' + PRU_ACCOUNTS_URL + '" target="_blank">Open My Accounts &#8599;</a>'
      + ' while logged in, then click Sync again. '
      + '<small style="color:#84827f">(The green dot shows data from your last sync is still available.)</small>';
    return;
  }

  statusEl.textContent = 'Syncing…';

  for (const tab of tabs) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['pru_content.js'] });
  }

  // Listen for completion message from content script (sent after all pages scraped)
  let done = false;
  const onDone = (msg) => {
    if (msg?.type !== 'pru_sync_done') return;
    done = true;
    chrome.runtime.onMessage.removeListener(onDone);
    loadPrudentialData();
  };
  chrome.runtime.onMessage.addListener(onDone);

  // Fallback: if message never arrives within 12 s, refresh anyway
  setTimeout(() => {
    if (!done) {
      chrome.runtime.onMessage.removeListener(onDone);
      loadPrudentialData();
    }
  }, 12000);
});

function clearPruStatus() {
  const el = document.getElementById('pru-sync-status');
  if (el) el.textContent = '';
}

// ─── Prudential display ────────────────────────────────────────────────────────

async function loadPrudentialData() {
  const { prudentialAnnuity } = await chrome.storage.local.get('prudentialAnnuity');

  const accounts = prudentialAnnuity?.accounts || [];
  const txCount  = (prudentialAnnuity?.transactions || []).length;

  // ── Set dot immediately ────────────────────────────────────────────────────
  setDot('pru', accounts.length ? 'green' : 'red');
  clearPruStatus();

  const el        = document.getElementById('pru-balance');
  const exportBtn = document.getElementById('export-pru');
  const txBtn     = document.getElementById('export-pru-tx');
  const asOfEl    = document.getElementById('pru-asof');

  if (exportBtn) exportBtn.disabled = !accounts.length;
  if (txBtn)     txBtn.disabled     = !txCount;

  if (!prudentialAnnuity || accounts.length === 0) {
    el.innerHTML = prudentialAnnuity
      ? '<span class="no-data">No accounts found. Try Sync Now while on the My Accounts page.</span>'
      : '<span class="no-data">No data yet. Visit the Prudential pages while logged in.</span>';
    return;
  }

  if (asOfEl && accounts[0]?.asOfDate) asOfEl.textContent = `As of ${accounts[0].asOfDate}`;

  el.innerHTML = accounts.map(a => `
    <div>
      <b>${a.name}</b><br>
      Account Value: <strong>${a.accountValue || 'N/A'}</strong> &nbsp;&middot;&nbsp;
      Death Benefit: ${a.deathBenefitValue || 'N/A'}
    </div><hr>
  `).join('') + `<div style="color:#888;font-size:11px;">${txCount} transaction${txCount !== 1 ? 's' : ''} loaded</div>`;
}

// ─── Prudential CSV exports ────────────────────────────────────────────────────

document.getElementById('export-pru').addEventListener('click', () => {
  chrome.storage.local.get('prudentialAnnuity', ({ prudentialAnnuity }) => {
    const accounts = prudentialAnnuity?.accounts || [];
    if (!accounts.length) { alert('No Prudential account data. Sync first.'); return; }
    const today = new Date().toISOString().slice(0, 10);
    const safe  = s => String(s).replace(/\r?\n/g, ' ').replace(/"/g, '""');
    const rows  = [['Date', 'Balance', 'Account']];
    accounts.forEach(a => {
      if (!a.accountValue) return;
      rows.push([safe(today), safe(a.accountValue), safe(a.name)]);
    });
    downloadCSV(rows, 'prudential_balances.csv');
  });
});

document.getElementById('export-pru-tx').addEventListener('click', () => {
  chrome.storage.local.get('prudentialAnnuity', ({ prudentialAnnuity }) => {
    const txs = prudentialAnnuity?.transactions || [];
    if (!txs.length) { alert('No Prudential transactions. Sync first.'); return; }
    const safe = s => String(s).replace(/\r?\n/g, ' ').replace(/"/g, '""');
    const rows = [['Date', 'Merchant', 'Category', 'Account', 'Original Statement', 'Notes', 'Amount', 'Tags']];
    const seen = new Set();
    txs.forEach(t => {
      const gross = parseFloat((t.grossAmount || '').replace(/[^0-9.-]/g, ''));
      if (!gross || isNaN(gross)) return;
      const key = `${t.date}|${t.name}|${gross.toFixed(2)}`;
      if (seen.has(key)) return;
      seen.add(key);
      rows.push([
        safe(t.date), 'Prudential', safe(t.type), 'Prudential Annuity',
        safe(t.name), 'Synced via Chrome Ext',
        safe(t.grossAmount), '',
      ]);
    });
    downloadCSV(rows, 'prudential_transactions.csv');
  });
});

// ─── CSV exports ───────────────────────────────────────────────────────────────

function mapAccount(rawName) {
  if (!rawName) return '';
  const m = rawName.match(/\b\d+-0*(\d+)\b/);
  if (m) { const idx = parseInt(m[1], 10); if (!isNaN(idx)) return `Federal Student Loan ${idx}`; }
  if (/Direct Loan - Subsidized/i.test(rawName))   return 'Federal Student Loan 1';
  if (/Direct Loan - Unsubsidized/i.test(rawName)) return 'Federal Student Loan 2';
  return rawName;
}

document.getElementById('export').addEventListener('click', () => {
  chrome.storage.local.get('mohelaLoans', ({ mohelaLoans }) => {
    if (!mohelaLoans?.loans?.length) { alert('No loan data. Sync Mohela first.'); return; }
    const rows   = [['Date', 'Balance', 'Account']];
    const today  = new Date().toISOString().slice(0, 10);
    const safe   = s => s.replace(/\r?\n/g, ' ').replace(/"/g, '""');
    const zeroRe = /^\s*[-(]?\s*\$?0+(?:[\.,]0+)?\s*[) -]?\s*$/;
    mohelaLoans.loans.forEach(loan => {
      const raw     = (loan.currentBalance || '').toString().replace(/ /g, ' ').trim();
      const numeric = parseFloat(raw.replace(/[^0-9.-]+/g, ''));
      if (!numeric || zeroRe.test(raw)) return;
      rows.push([safe(today), safe(raw), safe(mapAccount(loan.name || ''))]);
    });
    downloadCSV(rows, 'balances.csv');
  });
});

document.getElementById('export-transactions').addEventListener('click', () => {
  chrome.storage.local.get('mohelaLoans', ({ mohelaLoans }) => {
    if (!mohelaLoans?.transactions?.length) { alert('No transactions. Sync Mohela first.'); return; }
    const rows = [['Date', 'Merchant', 'Category', 'Account', 'Original Statement', 'Notes', 'Amount', 'Tags']];
    const safe = s => s.replace(/\r?\n/g, ' ').replace(/"/g, '""');
    const seen = new Set();
    mohelaLoans.transactions.forEach(t => {
      const date    = t.date || new Date().toISOString().slice(0, 10);
      const account = mapAccount(t.accountRaw || '').trim();
      if (!account) return;
      const numeric = parseFloat((t.amount || '').toString().replace(/[^0-9.-]+/g, ''));
      if (!numeric || isNaN(numeric)) return;
      const positive = Math.abs(numeric);
      const key = `${date}|${account}|${positive.toFixed(2)}`;
      if (seen.has(key)) return;
      seen.add(key);
      rows.push([safe(date), 'MOHELA', 'Transfer', safe(account), 'MOHELA Loan Payment', 'Synced via Chrome Ext', safe(`$${positive.toFixed(2)}`), '']);
    });
    downloadCSV(rows, 'transactions.csv');
  });
});

// ─── Helpers ───────────────────────────────────────────────────────────────────

function downloadCSV(rows, filename) {
  const csv  = rows.map(r => r.map(c => `"${c}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

function updateSyncMonarchButton(enabled) {
  const btn = document.getElementById('sync-monarch');
  btn.disabled = !enabled;
  btn.title = enabled ? '' : 'Connect to Monarch in Settings first';
}

/**
 * Set the status dot next to a tab label.
 * @param {'mohela'|'pru'} source
 * @param {'green'|'red'|'grey'} status
 */
function setDot(source, status) {
  const el = document.getElementById(`dot-${source}`);
  if (!el) return;
  const colors = { green: '#30a46c', red: '#e5484d', grey: '#bebbb8' };
  el.style.background = colors[status] ?? colors.grey;
  el.title = status === 'green'
    ? 'Data available — last scraped data is in storage and ready to push to Monarch'
    : status === 'red'
    ? 'No data yet — open the account website and click Sync Now'
    : 'Unknown';
}

// ─── Load & display Mohela data ────────────────────────────────────────────────

async function loadData() {
  const { mohelaLoans } = await chrome.storage.local.get('mohelaLoans');

  // ── Set dot immediately — don't block on CSRF/session checks ──────────────
  const hasLoans = !!(mohelaLoans?.loans?.length);
  setDot('mohela', hasLoans ? 'green' : 'red');

  const el        = document.getElementById('balance');
  const exportBtn = document.getElementById('export');
  const txBtn     = document.getElementById('export-transactions');
  const asOfEl    = document.getElementById('mohela-asof');

  if (!mohelaLoans) {
    el.innerHTML = '<span class="no-data">No data. Navigate to your Mohela account and click Sync.</span>';
    if (exportBtn) exportBtn.disabled = true;
    if (txBtn)     txBtn.disabled     = true;
  } else {
    const hasTx = !!(mohelaLoans.transactions?.length);
    if (exportBtn) exportBtn.disabled = !hasLoans;
    if (txBtn)     txBtn.disabled     = !hasTx;
    if (asOfEl) asOfEl.textContent = `As of ${new Date().toLocaleDateString()}`;

    el.innerHTML = `
      <div style="margin-bottom:6px;">
        <b>Total Balance:</b> ${mohelaLoans.totalBalance || 'N/A'} &nbsp;|&nbsp;
        <b>Loans:</b> ${mohelaLoans.totalLoans || 'N/A'}
      </div>
      ${(mohelaLoans.loans || []).map(l => `
        <div>
          <b>${l.name}</b><br>
          Balance: ${l.currentBalance} &nbsp;&middot;&nbsp; Rate: ${l.interestRate}<br>
          Plan: ${l.repaymentPlan} &nbsp;&middot;&nbsp; Status: ${l.status}
        </div><hr>
      `).join('')}
      ${hasTx ? `<div style="color:#84827f;font-size:11px;">${mohelaLoans.transactions.length} transaction${mohelaLoans.transactions.length !== 1 ? 's' : ''} loaded</div>` : ''}
    `;
  }

  // ── Session check runs after rendering so it never blocks the dot ─────────
  try {
    const csrfToken = await getCsrfToken();
    const session   = await hasSession();
    updateSyncMonarchButton(!!(csrfToken && session));
  } catch (e) {
    console.warn('Session check failed:', e);
  }
}

// ─── Reset sync history ────────────────────────────────────────────────────────

document.getElementById('reset-sync-history').addEventListener('click', async () => {
  const { syncedTransactions } = await chrome.storage.local.get('syncedTransactions');
  const count = Array.isArray(syncedTransactions) ? syncedTransactions.length : 0;
  if (!count) { alert('Sync history is already empty.'); return; }
  if (!confirm(`Clear ${count} synced transaction records?\n\nThis will NOT delete anything in Monarch Money — it only clears the local list that prevents duplicates. Only use this if you have already manually removed duplicate transactions from Monarch.`)) return;
  await chrome.storage.local.remove('syncedTransactions');
  updateSyncedCount(0);
  document.getElementById('monarch-status').textContent = 'Sync history cleared.';
});

async function updateSyncedCount(n) {
  const el = document.getElementById('synced-count');
  if (el) el.textContent = n ?? (await chrome.storage.local.get('syncedTransactions'))
    .syncedTransactions?.length ?? 0;
}

loadData();
loadPrudentialData();
updateSyncedCount();
