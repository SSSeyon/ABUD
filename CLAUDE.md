# Access Holdings unclaimed dividend portfolio app (ABUD Portfolio)

Internal reporting and monitoring tool for MBO Capital's management of the Access Holdings Plc unclaimed dividend pool.
Build plan (requirements background): https://claude.ai/artifact/6xMsGwYDAe6hpDBG4aQxoV
The plan predates these decisions, which override it: no sign-in, no roles, no maker-checker approvals,
no withdrawal-instruction verification or signatory register. Do not add them back unless asked.

## Stack (no installs, no build step)
- Static HTML + JavaScript ES modules, hosted on GitHub Pages.
- Firestore (Firebase SDK 13.4.0 from gstatic); decimal.js from jsDelivr. No Firebase Auth.
- No Node.js, npm, bundler or TypeScript. Types are JSDoc comments.
- Scheduled work (alerts, digest, scrapers), if built, goes in GitHub Actions cron.

## Rules
- Single client, single pooled portfolio. No client or portfolio keys anywhere. Do not add multi-client support.
- All money and rate arithmetic uses `src/engine/decimal.js`. Never use JS floating point for amounts or rates.
- Firestore stores money and rates as decimal strings, never numbers.
- Rates are fractions (0.0075 = 0.75%). Money is naira to the kobo.
- Rounding: full precision internally; round naira to the kobo only when an amount posts (`toKobo`).
  `rateRoundingDp` exists only to reproduce worksheets that rounded rates.
- NAV is gross of fees due to MBO. Fee debits are external flows, so ARIP stays gross of fees.
- Day count: Actual/365. Non-business days use the prior business day's NAV for the fee.
- Clause 8 incentive reading is the billing default; Clause 12 appears on internal outputs only.
- Every recorded transaction counts (the engine's `approved` flag is always true from the app).

## Layout
- `index.html`, `styles.css` app shell. `src/app/main.js` hash router (#/dashboard, #/holdings, #/transactions, #/settings).
- `src/app/firebase.js` Firestore init; `store.js` live onSnapshot state (+ 10 s "stalled" flag);
  `actions.js` every write (one batch); `portfolio.js` Firestore docs -> engine inputs; `ui.js` DOM helpers,
  formatting, modal forms; `views/` one file per screen. Forms live in modals so live re-renders don't wipe input.
- A deal = an `instruments` doc + its `invest`/`fund_subscription` transaction, written together.
  A `mature`/`fund_redemption` transaction takes the holding off the Holdings list.
- A `mature` dated before the contract maturity is an early termination: the holding leaves NAV that day.
- `src/engine/` pure calculation engine, no I/O.
- History import: `data/history-2026-09-30.json` (inception to 30 Sep 2026) is built by
  `tools/history/build-history.ps1` from `tools/history/source.txt` plus the workbook's bank ledger, fee table and
  fund yields; it prints a day-by-day cash reconciliation against the bank ledger. `src/app/history.js` maps it to
  documents with fixed `hist-` ids (rerunnable); Settings > Import history loads it into an empty database.
- `tests/` in-browser tests: `tests/harness.js` (describe/it/expect), `tests/engine/*.test.js`, `tests/app/*.test.js`,
  run from `tests/index.html`. Add new test files to its imports.
- `firestore.rules` open read/write on the five collections with shape validation; `firestore/MODEL.md`.
- `serve.ps1` local static server (PowerShell, no install).

## Running tests
`powershell -ExecutionPolicy Bypass -File serve.ps1`, then open http://localhost:8080/tests/
(ES modules do not load from file://).
