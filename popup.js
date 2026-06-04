// ─── Constants ────────────────────────────────────────────────────────────────
const MONARCH_ENDPOINTS = [
  { app: 'https://app.monarchmoney.com', api: 'https://api.monarchmoney.com' },
  { app: 'https://app.monarch.com', api: 'https://api.monarch.com' },
];
const MONARCH_API  = MONARCH_ENDPOINTS[0].api;
const MONARCH_APP  = MONARCH_ENDPOINTS[0].app;
const GRAPHQL_URL  = `${MONARCH_API}/graphql`;
const ZERO_BALANCE_RE = /^\s*(?:-|\()?[\s$]*0+(?:[.,]0+)?\)?\s*$/;
const INACTIVE_MOHELA_STATUS_RE = /\b(?:inactive|paid\s*in\s*full|paid\s*off|closed|transferred|discharged|consolidated|cancell?ed)\b/i;

function localIsoDate(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function localIsoDateDaysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return localIsoDate(date);
}

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
  const queries = [
    {
      label: 'currentBalance',
      query: `query GetAccounts {
        accounts {
          id
          displayName
          currentBalance
          isManual
          type { name display }
        }
      }`,
    },
    {
      label: 'displayBalance',
      query: `query GetAccounts {
        accounts {
          id
          displayName
          displayBalance
          isManual
          type { name display }
        }
      }`,
    },
  ];

  let lastError = null;
  for (const attempt of queries) {
    try {
      const data = await monarchGraphQL(csrfToken, attempt.query);
      return data?.accounts || [];
    } catch (e) {
      lastError = e;
      console.warn(`Account fetch attempt "${attempt.label}" failed:`, e.message);
    }
  }

  throw lastError || new Error('Monarch account fetch failed');
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

  const startDate = localIsoDateDaysAgo(lookbackDays);
  const endDate = localIsoDate();
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

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '');
}

function daysAgoForDate(date) {
  const parsed = new Date(date + 'T00:00:00Z');
  if (isNaN(parsed.getTime())) return null;
  const today = new Date(localIsoDate() + 'T00:00:00Z');
  const days = Math.ceil((today - parsed) / 86400000);
  return days >= 0 ? days : null;
}

function dedupLookbackDaysForSync(mohelaLoans, prudentialAnnuity) {
  const dates = [
    ...(mohelaLoans?.transactions || []).map(tx => tx.date),
    ...(prudentialAnnuity?.transactions || []).map(tx => tx.date),
  ].filter(isIsoDate);

  const oldestDate = dates.sort()[0];
  const days = oldestDate ? daysAgoForDate(oldestDate) : null;
  return Math.max(730, (days || 0) + 7);
}

function normalizeText(value) {
  return String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseMoneyAmount(value) {
  if (typeof value === 'number') return value;

  const raw = normalizeText(value);
  if (!raw) return NaN;

  const isNegative = /^\s*(?:-|\()/.test(raw);
  const match = raw.match(/\d[\d,]*(?:\.\d+)?/);
  if (!match) return NaN;

  const parsed = parseFloat(match[0].replace(/,/g, ''));
  if (!Number.isFinite(parsed)) return NaN;
  return isNegative ? -parsed : parsed;
}

function moneyAmountsFromText(value, requireDollar = false) {
  const raw = normalizeText(value);
  if (!raw) return [];

  const re = requireDollar
    ? /(?:[-(]\s*)?\$\s*\d[\d,]*(?:\.\d+)?\)?/g
    : /(?:[-(]\s*)?\$?\s*\d[\d,]*(?:\.\d+)?\)?/g;

  return (raw.match(re) || [])
    .map(parseMoneyAmount)
    .filter(Number.isFinite);
}

function currentBalanceAmount(value) {
  const raw = normalizeText(value);
  if (!raw) return NaN;

  const labelled = raw.match(/(?:current\s+)?balance.{0,40}?((?:[-(]\s*)?\$?\s*\d[\d,]*(?:\.\d+)?\)?)/i);
  if (labelled) return parseMoneyAmount(labelled[1]);

  const dollarAmounts = moneyAmountsFromText(raw, true);
  if (dollarAmounts.length === 1) return dollarAmounts[0];

  return parseMoneyAmount(raw);
}

function isZeroBalanceValue(value) {
  const raw = normalizeText(value);
  if (!raw) return false;

  const dollarAmounts = moneyAmountsFromText(raw, true);
  if (dollarAmounts.length && dollarAmounts.every(amount => Math.abs(amount) < 0.005)) return true;

  const amount = currentBalanceAmount(raw);
  return ZERO_BALANCE_RE.test(raw) || (Number.isFinite(amount) && Math.abs(amount) < 0.005);
}

function isInactiveMohelaLoan(loan) {
  return [loan?.status, loan?.repaymentPlan, loan?.type, loan?.rowText]
    .map(normalizeText)
    .some(value => INACTIVE_MOHELA_STATUS_RE.test(value));
}

function isHiddenMohelaLoan(loan) {
  return isZeroBalanceValue(loan?.currentBalance) || isInactiveMohelaLoan(loan);
}

function visibleMohelaLoans(mohelaLoans) {
  return (mohelaLoans?.loans || []).filter(loan => !isHiddenMohelaLoan(loan));
}

function errorValueToMessage(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(errorValueToMessage).filter(Boolean).join('; ');
  if (typeof value === 'object') {
    if (Array.isArray(value.messages)) {
      return `${value.field ? value.field + ': ' : ''}${value.messages.join(', ')}`;
    }
    const fieldErrors = errorValueToMessage(value.fieldErrors);
    const message = value.message || value.detail || value.error || value.code;
    return [message, fieldErrors].filter(Boolean).join(': ');
  }
  return String(value);
}

function balanceUploadResponseErrorText(text) {
  if (!text) return '';
  try {
    const json = JSON.parse(text);
    if (json?.success === false) return errorValueToMessage(json.errors || json.error || json.detail || json.message) || 'Monarch balance-history upload was not successful';
    return errorValueToMessage(json?.errors || json?.error || json?.detail || json?.non_field_errors);
  } catch {
    return '';
  }
}

function parseJsonObject(text) {
  if (!text || typeof text !== 'string') return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function truncateForError(value, max = 500) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  if (!raw) return '';
  return raw.length > max ? `${raw.slice(0, max)}...` : raw;
}

function findKeyValueDeep(value, keyNames) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findKeyValueDeep(item, keyNames);
      if (found) return found;
    }
    return null;
  }

  for (const [key, item] of Object.entries(value)) {
    if (keyNames.includes(key) && typeof item === 'string' && item.trim()) {
      return item.trim();
    }
    const found = findKeyValueDeep(item, keyNames);
    if (found) return found;
  }
  return null;
}

function balanceUploadSessionKey(uploadResult) {
  if (uploadResult?.sessionKey) return uploadResult.sessionKey;
  const json = parseJsonObject(uploadResult?.text);
  return findKeyValueDeep(json, ['session_key', 'sessionKey']);
}

function balanceUploadResponsePreview(uploadResult) {
  const json = parseJsonObject(uploadResult?.text);
  return truncateForError(json || uploadResult?.text || uploadResult || 'empty upload response');
}

function signedBalanceForHistory(balance, isLiability = false) {
  const amount = Math.abs(parseFloat(balance));
  return isLiability ? -amount : amount;
}

function numericBalance(value) {
  const parsed = typeof value === 'number' ? value : currentBalanceAmount(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function balanceMatches(actual, expected) {
  const parsed = numericBalance(actual);
  return Number.isFinite(parsed) && Math.abs(parsed - expected) <= 0.01;
}

function accountBalanceMatches(account, amount, isLiability = false) {
  if (!account) return false;
  const absolute = Math.abs(parseFloat(amount));
  const signed = signedBalanceForHistory(absolute, isLiability);
  const acceptable = isLiability ? [signed, absolute] : [absolute];

  return ['currentBalance', 'displayBalance'].some(field =>
    acceptable.some(expected => balanceMatches(account[field], expected))
  );
}

function accountBalanceSummary(account) {
  if (!account) return 'no account returned';
  const current = account.currentBalance ?? 'n/a';
  const display = account.displayBalance ?? 'n/a';
  return `current=${current}, display=${display}`;
}

function waitMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function monarchFetchAccount(csrfToken, accountId) {
  const attempts = [
    {
      label: 'UUID',
      query: `query GetAccountForBalanceVerify($id: UUID!) {
        account(id: $id) {
          id
          displayName
          currentBalance
          displayBalance
          isAsset
          isManual
          __typename
        }
      }`,
    },
    {
      label: 'ID',
      query: `query GetAccountForBalanceVerify($id: ID!) {
        account(id: $id) {
          id
          displayName
          currentBalance
          displayBalance
          isAsset
          isManual
          __typename
        }
      }`,
    },
  ];

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const data = await monarchGraphQL(csrfToken, attempt.query, { id: accountId });
      if (data?.account) return data.account;
    } catch (e) {
      lastError = e;
      console.warn(`Account verify fetch "${attempt.label}" failed:`, e.message);
    }
  }

  throw lastError || new Error('Could not fetch Monarch account after balance update');
}

async function monarchUpdateBalanceViaGraphQL(csrfToken, accountId, balance, { isLiability = false } = {}) {
  const query = `
    mutation Common_UpdateAccount($input: UpdateAccountMutationInput!) {
      updateAccount(input: $input) {
        account { id displayName currentBalance displayBalance __typename }
        errors { message code fieldErrors { field messages __typename } __typename }
        __typename
      }
    }
  `;

  const amount = Math.abs(parseFloat(balance));
  const signed = signedBalanceForHistory(amount, isLiability);
  const attempts = [
    { label: 'currentBalance', input: { id: accountId, currentBalance: isLiability ? signed : amount } },
    ...(isLiability ? [{ label: 'currentBalance-positive', input: { id: accountId, currentBalance: amount } }] : []),
    { label: 'displayBalance', input: { id: accountId, displayBalance: amount } },
    ...(isLiability ? [{ label: 'displayBalance-signed', input: { id: accountId, displayBalance: signed } }] : []),
  ];

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const result = await monarchGraphQL(csrfToken, query, { input: attempt.input });
      const errs = result?.updateAccount?.errors;
      if (errs?.length) throw new Error(errorValueToMessage(errs) || 'Monarch balance update failed');
      if (accountBalanceMatches(result?.updateAccount?.account, amount, isLiability)) {
        return result;
      }

      await waitMs(500);
      const account = await monarchFetchAccount(csrfToken, accountId);
      if (accountBalanceMatches(account, amount, isLiability)) {
        result.updateAccount.account = account;
        return result;
      }

      throw new Error(`Monarch accepted ${attempt.label}, but balance still reads ${accountBalanceSummary(account)}`);
    } catch (e) {
      lastError = e;
      console.warn(`Balance update attempt "${attempt.label}" failed:`, e.message);
    }
  }

  throw lastError || new Error('Monarch balance update failed');
}

async function verifyBalanceHistoryRows(csrfToken, accountId, rows) {
  const cleanRows = [...(rows || [])]
    .filter(row => isIsoDate(row.date) && Number.isFinite(row.balance));
  if (!cleanRows.length) return { ok: true, matched: 0 };

  const dates = cleanRows.map(row => row.date).sort();
  const expectedByDate = new Map(cleanRows.map(row => [row.date, row.balance]));

  for (const delayMs of [500, 2000, 4000]) {
    await waitMs(delayMs);
    const history = await monarchFetchBalanceHistory(csrfToken, accountId, dates[0], dates[dates.length - 1]);
    const actualByDate = new Map(history.map(row => [row.date, row.balance]));
    const missing = [];

    for (const [date, expected] of expectedByDate) {
      const actual = actualByDate.get(date);
      if (!balanceMatches(actual, expected)) {
        missing.push(`${date} expected ${expected.toFixed(2)}${Number.isFinite(actual) ? ` got ${actual.toFixed(2)}` : ''}`);
      }
    }

    if (!missing.length) return { ok: true, matched: cleanRows.length };

    if (delayMs === 4000) {
      return { ok: false, matched: cleanRows.length - missing.length, message: missing.slice(0, 3).join('; ') };
    }
  }

  return { ok: false, matched: 0, message: 'Balance history verification did not complete' };
}

async function monarchGetBalanceUploadSession(csrfToken, sessionKey) {
  const attempts = [
    {
      label: 'with-error-message',
      query: `query Web_GetUploadBalanceHistorySession($sessionKey: String!) {
        uploadBalanceHistorySession(sessionKey: $sessionKey) {
          sessionKey
          status
          errorMessage
          __typename
        }
      }`,
    },
    {
      label: 'basic',
      query: `query Web_GetUploadBalanceHistorySession($sessionKey: String!) {
        uploadBalanceHistorySession(sessionKey: $sessionKey) {
          sessionKey
          status
          __typename
        }
      }`,
    },
  ];

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const data = await monarchGraphQL(csrfToken, attempt.query, { sessionKey });
      if (data?.uploadBalanceHistorySession) return data.uploadBalanceHistorySession;
    } catch (e) {
      lastError = e;
      console.warn(`Balance-history session query "${attempt.label}" failed:`, e.message);
    }
  }

  throw lastError || new Error('Could not read Monarch balance-history upload session');
}

async function monarchParseBalanceHistorySession(csrfToken, uploadResult) {
  const sessionKey = balanceUploadSessionKey(uploadResult);
  if (!sessionKey) {
    throw new Error(`Monarch upload response did not include session_key (${balanceUploadResponsePreview(uploadResult)})`);
  }

  const attempts = [
    {
      label: 'with-error-message',
      query: `mutation Web_ParseUploadBalanceHistorySession($input: ParseBalanceHistoryInput!) {
        parseBalanceHistory(input: $input) {
          uploadBalanceHistorySession {
            sessionKey
            status
            errorMessage
            __typename
          }
          __typename
        }
      }`,
    },
    {
      label: 'basic',
      query: `mutation Web_ParseUploadBalanceHistorySession($input: ParseBalanceHistoryInput!) {
        parseBalanceHistory(input: $input) {
          uploadBalanceHistorySession {
            sessionKey
            status
            __typename
          }
          __typename
        }
      }`,
    },
  ];

  let session = null;
  let lastError = null;
  for (const attempt of attempts) {
    try {
      const data = await monarchGraphQL(csrfToken, attempt.query, { input: { sessionKey } });
      session = data?.parseBalanceHistory?.uploadBalanceHistorySession || null;
      if (session) break;
    } catch (e) {
      lastError = e;
      console.warn(`Balance-history parse mutation "${attempt.label}" failed:`, e.message);
    }
  }

  if (!session) throw lastError || new Error('Monarch did not return a balance-history import session');

  for (const delayMs of [500, 1000, 2000, 3000, 5000]) {
    const status = String(session.status || '').toLowerCase();
    if (status === 'completed') return session;
    if (status === 'errored' || status === 'error') {
      throw new Error(session.errorMessage || `Monarch balance-history import status: ${session.status}`);
    }

    await waitMs(delayMs);
    session = await monarchGetBalanceUploadSession(csrfToken, sessionKey);
  }

  return session;
}

async function monarchUploadAndVerifyBalanceHistory(csrfToken, accountId, rows) {
  const uploadResult = await monarchUploadBalanceHistory(csrfToken, accountId, rows);
  let parseError = null;

  if (!uploadResult?.skipped) {
    try {
      const session = await monarchParseBalanceHistorySession(csrfToken, uploadResult);
      console.log('Balance-history import session:', session);
    } catch (err) {
      parseError = err;
      console.warn('Balance-history import parse step failed:', err.message);
    }
  }

  const verified = await verifyBalanceHistoryRows(csrfToken, accountId, rows);
  if (!verified.ok) {
    const importDetail = parseError
      ? `; import step failed: ${parseError.message}`
      : `; upload response: ${balanceUploadResponsePreview(uploadResult)}`;
    throw new Error(`Monarch accepted the balance-history upload, but the uploaded rows were not visible afterward (${verified.message})${importDetail}`);
  }
  return verified;
}

async function monarchUpdateBalance(csrfToken, accountId, balance, { isLiability = false } = {}) {
  const amount = Math.abs(parseFloat(balance));
  if (!Number.isFinite(amount)) throw new Error('Invalid balance amount');

  try {
    const result = await monarchUpdateBalanceViaGraphQL(csrfToken, accountId, amount, { isLiability });
    result.method = 'graphql';
    return result;
  } catch (graphqlErr) {
    console.warn('GraphQL balance update failed; trying balance-history upload:', graphqlErr.message);

    const today = localIsoDate();
    const signedBalance = signedBalanceForHistory(amount, isLiability);

    try {
      await monarchUploadAndVerifyBalanceHistory(csrfToken, accountId, [{ date: today, balance: signedBalance }]);
      return { method: 'balance-history', updateAccount: { errors: [] } };
    } catch (uploadErr) {
      throw new Error(`GraphQL balance update failed: ${graphqlErr.message}; balance-history upload failed: ${uploadErr.message}`);
    }
  }
}

async function monarchCreateTransaction(
  csrfToken, accountId, date, amount, categoryId, notes, merchant,
  shouldUpdateBalance = false
) {
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
      shouldUpdateBalance,
    },
  });
}

function balanceHistoryCsvCell(value) {
  const raw = String(value ?? '');
  return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function balanceHistoryCsv(rows, accountName = '') {
  const cleanRows = [...rows]
    .filter(row => isIsoDate(row.date) && Number.isFinite(row.balance))
    .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

  const includeAccount = !!accountName;
  const header = includeAccount ? 'Date,Balance,Account' : 'Date,Balance';
  const body = cleanRows.map(row => {
    const values = [row.date, row.balance.toFixed(2)];
    if (includeAccount) values.push(accountName);
    return values.map(balanceHistoryCsvCell).join(',');
  });

  return [header, ...body].join('\n');
}

async function monarchUploadBalanceHistoryFromTab(csrfToken, accountId, csvContent) {
  const tabs = await chrome.tabs.query({ url: MONARCH_TAB_PATTERNS });
  if (!tabs.length) throw new Error('No open Monarch Money tab found');

  const errors = [];
  const filename = `balance-history-${accountId}.csv`;
  for (const tab of tabs) {
    const apiUrl = monarchApiForTabUrl(tab.url);
    try {
      const [injected] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: async ({ apiUrl, csrfToken, accountId, csvContent, filename }) => {
          const fromCookie = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
          const token = fromCookie ? decodeURIComponent(fromCookie[1]) : csrfToken;
          const form = new FormData();
          form.append('files', new Blob([csvContent], { type: 'text/csv' }), filename);
          form.append('account_files_mapping', JSON.stringify({ [filename]: accountId }));

          try {
            const resp = await fetch(`${apiUrl}/account-balance-history/upload/`, {
              method: 'POST',
              credentials: 'include',
              headers: {
                'Accept': 'application/json',
                'Client-Platform': 'web',
                'monarch-client': 'web',
                'monarch-client-version': '2025.05',
                ...(token ? { 'X-Csrftoken': token } : {}),
              },
              body: form,
            });
            const text = await resp.text();
            if (!resp.ok) {
              return { ok: false, error: `Monarch balance-history upload HTTP ${resp.status}${text ? ' - ' + text.slice(0, 240) : ''}` };
            }
            try {
              const json = text ? JSON.parse(text) : null;
              const errors = json?.errors || json?.error || json?.detail;
              if (errors) return { ok: false, error: Array.isArray(errors) ? errors.map(e => e.message || e).join('; ') : String(errors) };
            } catch {
              // Some successful upload responses are not JSON.
            }
            return { ok: true, text };
          } catch (e) {
            return { ok: false, error: e.message || String(e) };
          }
        },
        args: [{ apiUrl, csrfToken, accountId, csvContent, filename }],
      });

      const result = injected?.result;
      if (result?.ok) {
        const semanticError = balanceUploadResponseErrorText(result.text);
        if (!semanticError) {
          return {
            ...result,
            filename,
            sessionKey: balanceUploadSessionKey(result),
          };
        }
        errors.push(`${apiUrl}: ${semanticError}`);
        continue;
      }
      errors.push(`${apiUrl}: ${result?.error || 'empty injected result'}`);
    } catch (e) {
      errors.push(`${apiUrl}: ${e.message}`);
    }
  }

  throw new Error(errors.join(' | '));
}

async function monarchUploadBalanceHistoryViaExtension(csrfToken, accountId, csvContent) {
  const filename = `balance-history-${accountId}.csv`;
  let lastError = null;

  for (const endpoint of MONARCH_ENDPOINTS) {
    const form = new FormData();
    form.append('files', new Blob([csvContent], { type: 'text/csv' }), filename);
    form.append('account_files_mapping', JSON.stringify({ [filename]: accountId }));

    try {
      const resp = await fetch(`${endpoint.api}/account-balance-history/upload/`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Accept': 'application/json',
          'Client-Platform': 'web',
          'monarch-client': 'web',
          'monarch-client-version': '2025.05',
          ...(csrfToken ? { 'X-Csrftoken': csrfToken } : {}),
        },
        body: form,
      });
      const text = await resp.text();
      if (!resp.ok) {
        lastError = new Error(`${endpoint.api}: Monarch balance-history upload HTTP ${resp.status}${text ? ' - ' + text.slice(0, 240) : ''}`);
        continue;
      }
      try {
        const semanticError = balanceUploadResponseErrorText(text);
        if (semanticError) {
          lastError = new Error(`${endpoint.api}: ${semanticError}`);
          continue;
        }
      } catch {}
      const result = { ok: true, text, filename };
      result.sessionKey = balanceUploadSessionKey(result);
      return result;
    } catch (e) {
      lastError = new Error(`${endpoint.api}: Network error: ${e.message}`);
    }
  }

  throw lastError || new Error('Monarch balance-history upload failed');
}

async function monarchUploadBalanceHistory(csrfToken, accountId, rows) {
  if (!rows?.length) return { ok: true, skipped: true };

  let accountName = accountId;
  try {
    accountName = (await monarchFetchAccount(csrfToken, accountId))?.displayName || accountName;
  } catch (e) {
    console.warn('Could not fetch Monarch account name for balance-history CSV:', e.message);
  }

  const csvContent = balanceHistoryCsv(rows, accountName);
  try {
    return await monarchUploadBalanceHistoryFromTab(csrfToken, accountId, csvContent);
  } catch (e) {
    console.warn('Monarch tab balance-history upload failed; trying extension fetch:', e.message);
    try {
      return await monarchUploadBalanceHistoryViaExtension(csrfToken, accountId, csvContent);
    } catch (fallbackError) {
      throw new Error(`Tab upload failed: ${e.message}; extension upload failed: ${fallbackError.message}`);
    }
  }
}

// ─── Monarch balance history ───────────────────────────────────────────────────

/**
 * Fetch daily balance snapshots for a Monarch account over a date range.
 * Tries multiple query shapes in case the schema has changed.
 * Returns an array of {date: "YYYY-MM-DD", balance: number} objects sorted
 * ascending, or an empty array if all attempts fail (never throws).
 */
async function monarchFetchBalanceHistory(csrfToken, accountId, startDate, endDate) {
  const attempts = [
    {
      label: 'snapshotsForAccount',
      query: `query GetAccountSnapshots($accountId: UUID!) {
        snapshots: snapshotsForAccount(accountId: $accountId) {
          date
          signedBalance
        }
      }`,
      vars: { accountId },
      extract: d => d?.snapshots?.map(s => ({ date: s.date, balance: parseFloat(s.signedBalance) })),
    },
    {
      label: 'balanceHistory-on-account-with-range',
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
      query: `query GetAccountBalanceHistory($accountId: UUID!) {
        account(id: $accountId) {
          id
          balanceHistory {
            date
            balance
          }
        }
      }`,
      vars: { accountId },
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
          .filter(b => b.date && !isNaN(b.balance) && b.date >= startDate && b.date <= endDate)
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

/** Federal student-loan interest resumed on Sept. 1, 2023 after COVID forbearance. */
const INTEREST_RESUME_DATE = '2023-09-01';

/**
 * Inspect the last two months of Monarch balance history for a single Mohela loan account.
 * For every existing history date where the balance was unchanged from the
 * prior recorded day ("stagnant"), upload a corrected balance-history row with
 * daily interest accrual included.
 *
 * This runs silently as part of every sync — no user action required beyond entering
 * the rate once in Settings.
 *
 * @param {string}  csrfToken
 * @param {string}  accountId          Monarch account ID for this loan
 * @param {string}  loanName           Human-readable name, used in logs
 * @param {number}  annualRatePct      e.g. 6.54 for 6.54 % APR
 * @returns {{ balancesUpdated: number, balanceError: string|null }}
 */
async function backfillLoanInterest(csrfToken, accountId, loanName, annualRatePct) {
  if (!annualRatePct || isNaN(annualRatePct) || annualRatePct <= 0) {
    return { balancesUpdated: 0, balanceError: null };
  }

  const today = localIsoDate();

  // Look back up to 60 days, but never before interest resumed.
  const twoMonthsAgo    = localIsoDateDaysAgo(60);
  const lookbackStart   = twoMonthsAgo > INTEREST_RESUME_DATE ? twoMonthsAgo : INTEREST_RESUME_DATE;

  const history = await monarchFetchBalanceHistory(csrfToken, accountId, lookbackStart, today);
  if (!history.length) return { balancesUpdated: 0, balanceError: null };

  const dailyRate = annualRatePct / 100 / 365;
  const balanceRowsByDate = new Map();
  const historyDates = new Set(history.map(row => row.date));
  let stagnantRunStart = null;

  // Walk consecutive pairs. When the balance didn't change between two recorded
  // snapshots, existing history dates in that span had interest accruing with no
  // corresponding Monarch balance update. We upload corrected balance rows; no
  // transactions are created.
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1];
    const curr = history[i];

    // Enforce hard floor — never touch dates before interest resumed.
    if (curr.date < INTEREST_RESUME_DATE) continue;

    // Only act on stagnant spans (balance unchanged, within $0.01 rounding).
    if (Math.abs(curr.balance - prev.balance) > 0.01) {
      stagnantRunStart = null;
      continue;
    }

    if (!stagnantRunStart) stagnantRunStart = prev;
    const baseBalance = Math.abs(stagnantRunStart.balance);
    const signedBaseBalance = -baseBalance;
    const dailyInterest = -(baseBalance * dailyRate);

    // Enumerate the stagnant gap, but only update dates already present in the
    // fetched balance history.
    const gapDays = gapDatesBetween(prev.date, curr.date);
    for (const day of gapDays) {
      if (!historyDates.has(day)) continue;
      if (day < INTEREST_RESUME_DATE) continue;
      const daysSinceRunStart = daysBetween(stagnantRunStart.date, day);
      if (daysSinceRunStart <= 0) continue;

      // Upload signed liability balances. Monarch's balance-history importer
      // expects loan balances as negative values.
      const correctedBalance = signedBaseBalance + dailyInterest * daysSinceRunStart;
      if (day < today) balanceRowsByDate.set(day, { date: day, balance: correctedBalance });
    }
  }

  const balanceRows = [...balanceRowsByDate.values()];
  let balancesUpdated = 0;
  let balanceError = null;
  if (balanceRows.length) {
    try {
      const verified = await monarchUploadAndVerifyBalanceHistory(csrfToken, accountId, balanceRows);
      balancesUpdated = verified.matched || balanceRows.length;
      console.log(`Balance history backfill "${loanName}": ${balancesUpdated} rows verified`);
    } catch (err) {
      balanceError = err.message || String(err);
      console.warn(`Balance history backfill failed for "${loanName}":`, err.message);
    }
  }

  console.log(`Interest balance history backfill "${loanName}": ${balancesUpdated} rows uploaded`);
  return { balancesUpdated, balanceError };
}

async function requestBackgroundMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
      } else if (!response?.ok) {
        reject(new Error(response?.error || 'Background request failed'));
      } else {
        resolve(response.result);
      }
    });
  });
}

async function backfillPrudentialBalanceEstimates(
  csrfToken,
  accountId,
  account,
  allocationSnapshots,
  selectedAllocationSnapshotByAccount
) {
  const currentBalance = Math.abs(currentBalanceAmount(account.accountValue));
  if (!currentBalance || !Number.isFinite(currentBalance)) {
    return { balancesUpdated: 0, balanceError: null };
  }

  const today = localIsoDate();
  const currentDate = parsePruDate(account.asOfDate) || today;
  const lookbackStart = localIsoDateDaysAgo(60);
  const history = await monarchFetchBalanceHistory(csrfToken, accountId, lookbackStart, today);
  const knownByDate = new Map(history.map(row => [row.date, {
    date: row.date,
    balance: Math.abs(row.balance),
    source: 'monarch-history',
  }]));

  knownByDate.set(currentDate, {
    date: currentDate,
    balance: currentBalance,
    source: 'scraped-current',
  });

  const scrapedSnapshots = matchingScrapedAllocationSnapshots(allocationSnapshots, account, accountId, true);
  const payload = {
    accountId,
    knownBalances: [...knownByDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    allocationSnapshots: scrapedSnapshots.map(snapshot => ({ ...snapshot, accountId })),
    selectedAllocationSnapshotId: null,
    maxBackfillDays: 60,
  };

  const estimateResult = await requestBackgroundMessage({
    type: 'PRU_BACKFILL_ESTIMATE',
    payload,
  });

  const estimatedRows = (estimateResult?.rows || [])
    .filter(row => row.estimated && isIsoDate(row.date) && Number.isFinite(row.balance))
    .filter(row => row.date < currentDate);

  if (!estimatedRows.length) {
    console.log(`Prudential backfill "${account.name}": no estimated rows`, estimateResult?.debug);
    if (/proxy price history unavailable/i.test(estimateResult?.debug?.reason || '')) {
      return { balancesUpdated: 0, balanceError: estimateResult.debug.reason, debug: estimateResult.debug };
    }
    return { balancesUpdated: 0, balanceError: null, debug: estimateResult?.debug };
  }

  console.log(`Prudential backfill "${account.name}": uploading estimates`, estimatedRows);
  const verified = await monarchUploadAndVerifyBalanceHistory(csrfToken, accountId, estimatedRows);
  await persistPrudentialEstimateMetadata(accountId, account.name, estimatedRows);
  return { balancesUpdated: verified.matched || estimatedRows.length, balanceError: null, debug: estimateResult?.debug };
}

async function persistPrudentialEstimateMetadata(accountId, sourceAccountName, rows) {
  const { prudentialBalanceEstimates = [] } =
    await chrome.storage.local.get('prudentialBalanceEstimates');
  const replacementDates = new Set(rows.map(row => `${accountId}|${row.date}`));
  const retained = prudentialBalanceEstimates.filter(row => !replacementDates.has(`${row.accountId}|${row.date}`));
  const savedAt = new Date().toISOString();
  await chrome.storage.local.set({
    prudentialBalanceEstimates: [
      ...retained,
      ...rows.map(row => ({
        ...row,
        accountId,
        sourceAccountName,
        savedAt,
        label: 'Estimated Prudential balance - proxy-derived, non-official',
      })),
    ],
  });
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

function daysBetween(startDate, endDate) {
  const start = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return 0;
  return Math.round((end - start) / 86400000);
}

function parsePruDate(value) {
  const raw = normalizeText(value);
  if (isIsoDate(raw)) return raw;
  const m = raw.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : '';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function prudentialAccountStorageId(account, monarchMapping = {}) {
  const key = `pru:${account?.name || ''}`;
  return monarchMapping[key] || key;
}

function matchingScrapedAllocationSnapshots(allocationSnapshots, account, accountId, allowSingleFallback = false) {
  const scraped = (allocationSnapshots || []).filter(snapshot => snapshot.source === 'scraped');
  const matching = scraped.filter(snapshot =>
    snapshot.accountId === accountId
    || snapshot.accountId === `pru:${account?.name || ''}`
    || snapshot.sourceAccountName === account?.name
  );
  if (matching.length || !allowSingleFallback) return matching;
  return scraped.length === 1 ? scraped : [];
}

function normalizeAllocationSnapshotRows(rows) {
  return (rows || [])
    .map(row => ({
      fundName: normalizeText(row.fundName),
      weight: parseOptionalNumber(row.weight),
      units: parseOptionalNumber(row.units),
      contractPrice: parseOptionalNumber(row.contractPrice),
      value: parseOptionalNumber(row.value),
      proxySymbol: normalizeText(row.proxySymbol).toUpperCase(),
      ftMorningstarId: normalizeText(row.ftMorningstarId),
    }))
    .filter(row => row.fundName || Number.isFinite(row.weight) || Number.isFinite(row.value));
}

function parseOptionalNumber(value) {
  if (value === '' || value == null) return undefined;
  const parsed = parseFloat(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function allocationWeightTotal(rows) {
  return rows.reduce((sum, row) => sum + (Number.isFinite(row.weight) ? row.weight : 0), 0);
}

function allocationWarningText(rows) {
  const weightTotal = allocationWeightTotal(rows);
  if (!rows.length) return 'No scraped allocation rows available for backfill.';
  if (weightTotal === 0 && rows.some(row => Number.isFinite(row.value) && row.value > 0)) {
    return 'Weights are blank; the backfill engine will derive weights from scraped values.';
  }
  if (Math.abs(weightTotal - 100) > 1) {
    return `Weights total ${weightTotal.toFixed(2)}%; estimate confidence may be lower.`;
  }
  return `Weights total ${weightTotal.toFixed(2)}%.`;
}

async function renderPruAllocationEditor() {
  const editor = document.getElementById('pru-allocation-editor');
  const summary = document.getElementById('pru-allocation-summary');
  if (!editor) return;

  const {
    prudentialAnnuity,
    allocationSnapshots = [],
    monarchMapping = {},
  } = await chrome.storage.local.get([
    'prudentialAnnuity',
    'allocationSnapshots',
    'monarchMapping',
  ]);

  const accounts = prudentialAnnuity?.accounts || [];
  const account = accounts[0];
  if (!account) {
    editor.innerHTML = '<span class="no-data">No Prudential account data yet.</span>';
    if (summary) summary.textContent = '';
    return;
  }

  const accountId = prudentialAccountStorageId(account, monarchMapping);
  const accountSnapshots = matchingScrapedAllocationSnapshots(allocationSnapshots, account, accountId, true)
    .sort((a, b) =>
      (b.effectiveDate || '').localeCompare(a.effectiveDate || '')
      || (b.capturedAt || '').localeCompare(a.capturedAt || '')
    );
  const selected = accountSnapshots[0] || null;
  const rows = normalizeAllocationSnapshotRows(selected?.rows || []);

  if (summary) {
    summary.textContent = accountSnapshots.length
      ? `${accountSnapshots.length} scraped snapshot${accountSnapshots.length !== 1 ? 's' : ''}`
      : 'Not scraped yet';
  }

  if (!selected || !rows.length) {
    editor.innerHTML = '<span class="no-data">No scraped allocation yet. Open Prudential\'s Investment Allocation page, then click Sync Now.</span>';
    return;
  }

  editor.innerHTML = `
    <div class="allocation-status">
      Last scraped ${escapeHtml(selected.effectiveDate || 'unknown date')}
      ${selected.capturedAt ? ` · ${escapeHtml(new Date(selected.capturedAt).toLocaleString())}` : ''}
    </div>
    <div class="allocation-table-wrap">
      <table class="allocation-table">
        <thead>
          <tr>
            <th class="col-fund">Fund</th>
            <th class="col-num">Weight %</th>
            <th class="col-num">Units</th>
            <th class="col-num">Price</th>
            <th class="col-num">Value</th>
            <th class="col-proxy">Proxy</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(row => `
            <tr>
              <td>${escapeHtml(row.fundName || '')}</td>
              <td>${escapeHtml(formatAllocationNumber(row.weight, 2))}</td>
              <td>${escapeHtml(formatAllocationNumber(row.units, 5))}</td>
              <td>${escapeHtml(formatAllocationNumber(row.contractPrice, 5))}</td>
              <td>${escapeHtml(formatAllocationNumber(row.value, 2))}</td>
              <td>${escapeHtml(row.proxySymbol || '')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    <div class="allocation-status">${escapeHtml(allocationWarningText(rows))}</div>
  `;
}

function formatAllocationNumber(value, decimals) {
  return Number.isFinite(value) ? value.toFixed(decimals) : '';
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
  const rawMohelaLoans = mohelaLoans?.loans || [];
  const activeMohelaLoans = visibleMohelaLoans(mohelaLoans);
  const hiddenMohelaCount = rawMohelaLoans.length - activeMohelaLoans.length;

  activeMohelaLoans.forEach(l => items.push({
    key: l.name,
    label: mapMohelaMappingLabel(l.name || '') || l.name,
    title: l.name,
    group: 'Mohela',
    scrapedRate: l.interestRate || '',   // e.g. "6.54%" — scraped from Mohela page
  }));
  (prudentialAnnuity?.accounts || []).forEach(a => items.push({
    key: `pru:${a.name}`, label: a.name, title: a.name, group: 'Prudential',
    scrapedRate: '',
  }));

  if (items.length === 0) {
    container.innerHTML = hiddenMohelaCount > 0
      ? '<p style="font-size:11px;color:#888">No active accounts to map — zero-balance and inactive Mohela loans are hidden.</p>'
      : '<p style="font-size:11px;color:#888">No accounts synced yet — sync Mohela and/or Prudential first.</p>';
    return;
  }

  let lastGroup = null;
  items.forEach(({ key, label, title, group, scrapedRate }) => {
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
    span.title = title || label;
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
    allocationSnapshots,
    pruSelectedAllocationSnapshotByAccount,
  } = await chrome.storage.local.get([
    'mohelaLoans', 'prudentialAnnuity',
    'monarchMapping', 'monarchCategories', 'syncedTransactions',
    'loanInterestRates',
    'allocationSnapshots',
    'pruSelectedAllocationSnapshotByAccount',
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
    statusEl.textContent = 'No account mapping. Open Settings and map your accounts first.';
    return;
  }

  const activeMohelaLoans = visibleMohelaLoans(mohelaLoans);
  const hiddenMohelaLoanNames = new Set(
    (mohelaLoans?.loans || [])
      .filter(isHiddenMohelaLoan)
      .map(loan => (loan.name || '').trim())
      .filter(Boolean)
  );

  statusEl.textContent = 'Checking existing Monarch transactions…';

  // Collect every Monarch account ID we're about to sync to
  const allMappedAccountIds = [
    ...Object.values(monarchMapping),
  ].filter(Boolean);

  // Primary dedup: query Monarch for what it already has.
  // If this fails we STOP — never risk creating duplicates without verification.
  let monarchFingerprints;
  try {
    const dedupLookbackDays = dedupLookbackDaysForSync(mohelaLoans, prudentialAnnuity);
    console.log(`Monarch dedup lookback: ${dedupLookbackDays} days`);
    monarchFingerprints = await monarchFetchExistingTransactions(
      csrfToken, allMappedAccountIds, dedupLookbackDays
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
  let backfillBalanceRows = 0;

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
  for (const loan of activeMohelaLoans) {
    const displayName = mapAccount(loan.name || '') || loan.name;
    const accountId = monarchMapping[loan.name];
    if (!accountId) continue;
    const balance = Math.abs(currentBalanceAmount(loan.currentBalance));
    if (!balance || !Number.isFinite(balance)) continue;

    // Backfill stagnant days with daily interest accrual before recording the
    // new balance.  Uses the rate saved in Settings; skips silently if unset.
    const annualRate = parseFloat(loanInterestRates?.[loan.name] ?? NaN);
    if (!isNaN(annualRate) && annualRate > 0) {
      statusEl.textContent = `Checking interest history for ${displayName}…`;
      try {
        const result = await backfillLoanInterest(
          csrfToken, accountId, loan.name, annualRate
        );
        backfillBalanceRows += result.balancesUpdated || 0;
        if (result.balanceError) {
          errors.push(`Interest balance history "${displayName}": ${result.balanceError}`);
        }
      } catch (err) {
        // Never let backfill failures block the main balance update
        console.warn(`Interest backfill failed for "${displayName}":`, err.message);
      }
    }

    statusEl.textContent = 'Syncing…';
    try {
      const result = await monarchUpdateBalance(csrfToken, accountId, balance, { isLiability: true });
      const errs = result?.updateAccount?.errors;
      if (errs?.length) throw new Error(errs[0].message);
      balancesOk++;
    } catch (err) {
      errors.push(`Balance "${displayName}": ${err.message}`);
      balancesErr++;
    }
  }

  // ── 2. Mohela transactions — Transfer category ─────────────────────────────
  for (const tx of (mohelaLoans?.transactions || [])) {
    if (hiddenMohelaLoanNames.has((tx.accountRaw || '').trim())) { txSkip++; continue; }
    const accountId = monarchMapping[tx.accountRaw];
    if (!accountId) { txSkip++; continue; }
    const amount = parseFloat((tx.amount || '').toString().replace(/[^0-9.]/g, ''));
    if (!amount || isNaN(amount)) continue;
    const absAmt = Math.abs(amount);
    const date   = tx.date || localIsoDate();

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
    const balance = Math.abs(currentBalanceAmount(acct.accountValue));
    if (!balance || !Number.isFinite(balance)) continue;
    statusEl.textContent = `Checking estimated balance history for ${acct.name}…`;
    try {
      const result = await backfillPrudentialBalanceEstimates(
        csrfToken,
        accountId,
        acct,
        allocationSnapshots || [],
        pruSelectedAllocationSnapshotByAccount || {}
      );
      backfillBalanceRows += result.balancesUpdated || 0;
      if (result.balanceError) {
        errors.push(`Prudential estimated balance history "${acct.name}": ${result.balanceError}`);
      }
    } catch (err) {
      errors.push(`Prudential estimated balance history "${acct.name}": ${err.message}`);
      console.warn(`Prudential estimated balance history failed for "${acct.name}":`, err.message);
    }

    statusEl.textContent = 'Syncing…';
    try {
      const result = await monarchUpdateBalance(csrfToken, accountId, balance, { isLiability: false });
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
  if (backfillBalanceRows) parts.push(`📉 ${backfillBalanceRows} balance histor${backfillBalanceRows !== 1 ? 'y rows' : 'y row'} backfilled`);
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

const MOHELA_TAB_PATTERNS = ['https://myaccount.mohela.studentaid.gov/*'];
const MOHELA_URL = 'https://myaccount.mohela.studentaid.gov/';

document.getElementById('sync').addEventListener('click', async () => {
  const statusEl = document.getElementById('mohela-sync-status');
  statusEl.textContent = 'Syncing...';

  const tabs = await chrome.tabs.query({ url: MOHELA_TAB_PATTERNS });
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const targetTab = tabs.find(tab => tab.id === activeTab?.id) || tabs[0];

  if (!targetTab) {
    statusEl.innerHTML =
      '&#9888; No open Mohela tab found. '
      + '<a href="' + MOHELA_URL + '" target="_blank">Open Mohela &#8599;</a>'
      + ' while logged in, then click Sync again. '
      + '<small style="color:#84827f">(The green dot shows data from your last sync is still available.)</small>';
    return;
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId: targetTab.id }, files: ['content.js'] });
    setTimeout(async () => {
      await loadData();
      statusEl.textContent = '';
    }, 1500);
  } catch (err) {
    console.warn('Mohela script injection failed:', err);
    await loadData();
    statusEl.textContent =
      'Could not refresh Mohela from the open tab. Make sure the Mohela tab is fully loaded, then try Sync Now again.';
  }
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

  // Listen before injection so fast allocation-page scrapes are not missed.
  let receivedMessage = false;
  const onDone = (msg) => {
    if (!['pru_sync_done', 'pru_allocation_snapshot_saved', 'pru_allocation_snapshot_empty'].includes(msg?.type)) return;
    receivedMessage = true;
    if (msg.type === 'pru_allocation_snapshot_saved') {
      statusEl.textContent = `Scraped and saved allocation snapshot (${msg.rowCount || 0} rows).`;
    } else if (msg.type === 'pru_allocation_snapshot_empty') {
      statusEl.textContent = 'No allocation rows found on the open Prudential page.';
    } else {
      statusEl.textContent = 'Prudential data refreshed.';
    }
    loadPrudentialData({ preserveStatus: true });
  };
  chrome.runtime.onMessage.addListener(onDone);

  for (const tab of tabs) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['pru_content.js'] });
  }

  // Fallback: if message never arrives within 12 s, refresh anyway
  setTimeout(() => {
    chrome.runtime.onMessage.removeListener(onDone);
    if (!receivedMessage) statusEl.textContent = '';
    loadPrudentialData({ preserveStatus: receivedMessage });
  }, 12000);
});

function clearPruStatus() {
  const el = document.getElementById('pru-sync-status');
  if (el) el.textContent = '';
}

// ─── Prudential display ────────────────────────────────────────────────────────

async function loadPrudentialData({ preserveStatus = false } = {}) {
  const { prudentialAnnuity, prudentialBalanceEstimates = [] } =
    await chrome.storage.local.get(['prudentialAnnuity', 'prudentialBalanceEstimates']);

  const accounts = prudentialAnnuity?.accounts || [];
  const txCount  = (prudentialAnnuity?.transactions || []).length;

  // ── Set dot immediately ────────────────────────────────────────────────────
  setDot('pru', accounts.length ? 'green' : 'red');
  if (!preserveStatus) clearPruStatus();

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
    await renderPruAllocationEditor();
    return;
  }

  if (asOfEl && accounts[0]?.asOfDate) asOfEl.textContent = `As of ${accounts[0].asOfDate}`;

  const estimateCount = prudentialBalanceEstimates.length;
  el.innerHTML = accounts.map(a => `
    <div>
      <b>${a.name}</b><br>
      Account Value: <strong>${a.accountValue || 'N/A'}</strong>
    </div><hr>
  `).join('')
    + `<div style="color:#888;font-size:11px;">${txCount} transaction${txCount !== 1 ? 's' : ''} loaded`
    + `${estimateCount ? ` &nbsp;&middot;&nbsp; ${estimateCount} estimated balance row${estimateCount !== 1 ? 's' : ''} tracked locally` : ''}</div>`;
  await renderPruAllocationEditor();
}

// ─── Prudential CSV exports ────────────────────────────────────────────────────

document.getElementById('export-pru').addEventListener('click', () => {
  chrome.storage.local.get('prudentialAnnuity', ({ prudentialAnnuity }) => {
    const accounts = prudentialAnnuity?.accounts || [];
    if (!accounts.length) { alert('No Prudential account data. Sync first.'); return; }
    const today = localIsoDate();
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

function mapMohelaMappingLabel(rawName) {
  const mapped = mapAccount(rawName);
  const m = mapped.match(/^Federal Student Loan (\d+)$/);
  return m ? `Federal Loan ${m[1]}` : mapped;
}

document.getElementById('export').addEventListener('click', () => {
  chrome.storage.local.get('mohelaLoans', ({ mohelaLoans }) => {
    const activeLoans = visibleMohelaLoans(mohelaLoans);
    if (!activeLoans.length) { alert('No active loan balances to export.'); return; }
    const rows   = [['Date', 'Balance', 'Account']];
    const today  = localIsoDate();
    const safe   = s => s.replace(/\r?\n/g, ' ').replace(/"/g, '""');
    activeLoans.forEach(loan => {
      const raw     = (loan.currentBalance || '').toString().replace(/ /g, ' ').trim();
      const numeric = currentBalanceAmount(raw);
      if (!Number.isFinite(numeric) || Math.abs(numeric) < 0.005) return;
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
      const date    = t.date || localIsoDate();
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
  const hasStoredLoans = !!(mohelaLoans?.loans?.length);
  const activeLoans = visibleMohelaLoans(mohelaLoans);
  const hasActiveLoans = activeLoans.length > 0;
  setDot('mohela', hasStoredLoans ? 'green' : 'red');

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
    if (exportBtn) exportBtn.disabled = !hasActiveLoans;
    if (txBtn)     txBtn.disabled     = !hasTx;
    if (asOfEl) asOfEl.textContent = `As of ${new Date().toLocaleDateString()}`;

    el.innerHTML = `
      <div style="margin-bottom:6px;">
        <b>Total Balance:</b> ${mohelaLoans.totalBalance || 'N/A'} &nbsp;|&nbsp;
        <b>Active Loans:</b> ${activeLoans.length}
      </div>
      ${activeLoans.length ? activeLoans.map(l => `
        <div>
          <b>${mapAccount(l.name || '') || l.name}</b><br>
          Balance: ${l.currentBalance} &nbsp;&middot;&nbsp; Rate: ${l.interestRate}
        </div><hr>
      `).join('') : '<span class="no-data">No active Mohela loan balances.</span>'}
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
