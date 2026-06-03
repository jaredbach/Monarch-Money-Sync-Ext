# Monarch Sync

A Chrome extension for manually syncing Mohela student loan data and Prudential annuity data into Monarch Money. It can also export the scraped data as CSV files.

## What It Syncs

- Mohela loan balances.
- Mohela loan payment transactions.
- Prudential annuity account values.
- Prudential annuity transactions.
- Manual Monarch Money account balances and transactions based on your saved account mapping.

## Duplicate Protection

Before creating transactions, the extension loads existing Monarch transactions and builds duplicate fingerprints using:

```text
accountId|YYYY-MM-DD|absoluteAmount
```

If existing Monarch transactions cannot be loaded, the sync aborts instead of risking duplicate transaction creation. A local sync history is also kept as a secondary guard.

## Project Files

- `manifest.json` - Chrome extension manifest v3.
- `popup.html` / `popup.js` - popup UI, Monarch connection, account mapping, CSV export, and sync logic.
- `content.js` - Mohela scraper.
- `pru_content.js` - Prudential scraper.
- `monarch_rules.json` - request header rewrite rules for Monarch CSRF checks.
- `background.js` - minimal background listener.
- `icon16.png`, `icon48.png`, `icon128.png` - extension icons.

## Install Locally

1. Open Chrome and go to `chrome://extensions/`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this folder:

```text
/Users/jaredbach/Documents/GitHub/Monarch-Money-Sync-Ext
```

After any code or manifest change, reload the unpacked extension from `chrome://extensions/`.

## First-Time Setup

1. Open Monarch Money in a normal browser tab and log in.
2. Open the extension popup.
3. Click the gear icon.
4. Click Connect.
5. Click Refresh Accounts if needed.
6. Map each Mohela and Prudential source account to the correct Monarch Money account.
7. Click Save Mapping.

## Daily Use

1. Open Mohela, log in, and click Sync Now on the Mohela tab in the extension.
2. Open Prudential, log in, and click Sync Now on the Prudential tab in the extension.
3. Confirm the account dots are green.
4. Click Sync All to Monarch Money.

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
chrome.storage.local.get(['mohelaLoans', 'prudentialAnnuity', 'monarchMapping', 'syncedTransactions'], console.log)
```

## Development

This is a vanilla JavaScript Chrome extension. There is no build step.

Useful checks:

```sh
node --check popup.js
python3 -m json.tool manifest.json
python3 -m json.tool monarch_rules.json
```

## Notes

This project uses unofficial browser and GraphQL behavior from Monarch Money, Mohela, and Prudential pages. If one of those sites changes its DOM, cookies, CSRF behavior, or GraphQL schema, the related scraper or sync call may need to be updated.
