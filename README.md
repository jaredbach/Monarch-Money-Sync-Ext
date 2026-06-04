# Monarch Sync

A Chrome extension for manually syncing Mohela student loan data and Prudential annuity data into Monarch Money. It can also export the scraped data as CSV files.

## What It Syncs

- Mohela loan balances.
- Mohela loan payment transactions.
- Mohela daily loan interest backfill for stagnant recent balance-history days.
- Prudential annuity account values.
- Prudential annuity transactions.
- Prudential allocation snapshots from the Investment Allocation page.
- Prudential/Fortitude estimated annuity balance-history backfill for stale or missing recent trading days, using weighted market proxy returns.
- Manual Monarch Money account balances and transactions based on your saved account mapping.

## Duplicate Protection

Before creating transactions, the extension loads existing Monarch transactions and builds duplicate fingerprints using:

```text
accountId|YYYY-MM-DD|absoluteAmount
```

If existing Monarch transactions cannot be loaded, the sync aborts instead of risking duplicate transaction creation. A local sync history is also kept as a secondary guard.

The Monarch-side duplicate check expands to the oldest scraped Mohela or Prudential transaction date, so clearing local sync history should not recreate older transactions that already exist in Monarch.

## Project Files

- `manifest.json` - Chrome extension manifest v3.
- `popup.html` / `popup.js` - popup UI, Monarch connection, account mapping, CSV export, and sync logic.
- `content.js` - Mohela scraper.
- `pru_content.js` - Prudential scraper.
- `monarch_rules.json` - request header rewrite rules for Monarch CSRF checks.
- `background.js` - background listener plus approved Prudential proxy-price fetch/cache and estimator.
- `icon16.png`, `icon48.png`, `icon128.png` - extension icons.

## Install Locally

1. Open Chrome and go to `chrome://extensions/`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select the cloned repository folder.

```text
Monarch-Money-Sync-Ext
```

After any code or manifest change, reload the unpacked extension from `chrome://extensions/`.

## First-Time Setup

1. Open Monarch Money in a normal browser tab and log in.
2. Open the extension popup.
3. Click the gear icon.
4. Click Connect.
5. Click Refresh Accounts if needed.
6. Map each Mohela and Prudential source account to the correct Monarch Money account.
7. Enter each Mohela loan's APR if it is not already filled from the scraped Mohela data.
8. Click Save Mapping.

## Daily Use

1. Open Mohela, log in, and click Sync Now on the Mohela tab in the extension.
2. Open Prudential, log in, and click Sync Now on the Prudential tab while viewing My Accounts, Transactions, or the Investment Allocation page. The allocation page is scraped automatically when it is open.
3. Confirm the account dots are green.
4. Click Sync All to Monarch Money.

During Monarch sync, Mohela loans with a saved APR automatically check the last 60 days of Monarch balance history, ignore dates before September 1, 2023, upload corrected balance-history rows for stale days, and then record the new current balance. Interest backfill updates balance history only; it does not create interest transactions.

For Prudential/Fortitude variable annuities, the extension can estimate stale or missing recent balance-history rows using scraped Prudential allocation snapshots and approved ETF proxies: IWF, IWD, IWM, SPY, VEA, and AGG. Actual synced balances remain anchors. Generated rows are tracked locally as estimated, proxy-derived, and non-official.

## Prudential Allocations

Allocation snapshots are scraped automatically. Open Prudential's investment allocation page, such as `pru-ann360-investment-allocation`, while logged in, then click Sync Now on the Prudential tab. The extension reads the visible allocation table fields:

- Variable Investment
- % of Acct Value
- Units
- Price/Unit
- Value

The Prudential tab shows the latest scraped allocation snapshot for review, but backfill uses scraped snapshots only.

## CSV Exports

The popup can export:

- `balances.csv` for Mohela balances.
- `transactions.csv` for Mohela transactions.
- `prudential_balances.csv` for Prudential balances.
- `prudential_transactions.csv` for Prudential transactions.

## Troubleshooting

- If Monarch sync says there is no active session, open Monarch Money in a browser tab, confirm you are logged in, then click Connect again.
- If duplicate checking fails, the popup should show a Details line with the underlying Monarch API or browser-context error.
- If Mohela or Prudential data is missing, run Sync Now while logged into the relevant website and viewing the expected account page.
- If the extension UI does not reflect recent file changes, reload the unpacked extension in `chrome://extensions/`.

For raw stored data checks, open the extension popup console and run:

```js
chrome.storage.local.get(['mohelaLoans', 'prudentialAnnuity', 'monarchMapping', 'allocationSnapshots', 'prudentialBalanceEstimates', 'syncedTransactions'], console.log)
```

Do not commit exported CSVs, saved website HTML, screenshots, browser-console logs, or copied `chrome.storage.local` output. Those files can contain personal account balances, account names, transaction history, cookies, or session-derived data.

## Development

This is a vanilla JavaScript Chrome extension. There is no build step.

Useful checks:

```sh
osascript -l JavaScript popup.js
osascript -l JavaScript background.js
osascript -l JavaScript content.js
osascript -l JavaScript pru_content.js
python3 -m json.tool manifest.json
python3 -m json.tool monarch_rules.json
```

## Notes

This project uses unofficial browser and GraphQL behavior from Monarch Money, Mohela, and Prudential pages. If one of those sites changes its DOM, cookies, CSRF behavior, or GraphQL schema, the related scraper or sync call may need to be updated.
