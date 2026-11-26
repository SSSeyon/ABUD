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

## Decisions confirmed 26 Nov 2026
- Management fee: annual rate ÷ 4 per quarter, spread over the calendar quarter's days (`feeDayCount: 'quarterly'`, the app
  default via `appTerms`; the engine's own default stays `act365`). Matches the MCM income sheet.
- Incentive: all three readings shown (Clause 8, Clause 12, worksheet); billing stays Clause 8 until Access confirms.
  Worksheet reading = 10% × (quarter's naira income − shadow benchmark income); the shadow account takes every inflow and
  withdrawal and compounds daily at the latest 91-day true yield + spread (`shadowSeries`, engine `shadow.js`).
- Termination fee on whole months (part months rounded up); daily basis shown for reference only.
- Minimum counterparty rating BBB. Valuation stays accrual; incentive NAV base stays average daily NAV; round once on totals.
- Commencement 11 Aug 2021 (anniversary); mandate terms version effective 2021-08-11 added with the same rates.

## Layout
- Shell (like Wiwe Apartments): `#/home` (`views/home.js`) shows one card per section from `SECTIONS` in main.js; the
  logo always leads Home. A section with several screens shows them as `section-tabs`. Desktop: sidebar of sections.
  Phones (<= 860px): top bar (logo + title) and a bottom tab bar (Home, Dashboard, Alerts, Holdings); Home cards fill
  the screen (`fitHome`). Top bar on every screen: notifications bell (today's alerts; read ones kept in localStorage
  `abud-seen-alerts`) and the light/dark toggle (`abud-theme`, applied by index.html before paint; dark tokens live
  under `:root[data-theme="dark"]`, so never use a prefers-color-scheme media query for colours).
- Money flows on the Dashboard (and Management report): `periodFlows` in flows.js drawn as `sankey`, or `flowsAs('bars'|'donut')`
  (charts.js; choice remembered in `abud-flow-chart`). `donut`, `hBars`, `segmented` live in charts.js too.
- Numbers on screen are whole naira (`fmtNaira` rounds half up; `fmtCompact` for chart labels, e.g. ₦4,152m); only
  percentages keep decimals. Excel cells keep the full value with a `#,##0` format. Stat tiles shrink their figure
  with the tile (container query) so nothing overflows.
- `index.html`, `styles.css` app shell. `src/app/main.js` hash router (#/home, #/dashboard, #/alerts, #/holdings, #/ladder, #/transactions, #/counterparties, #/market, #/reports, #/navdaily, #/management, #/close, #/backtest, #/termination, #/history, #/settings).
- Positions (`positionsFor` in portfolio.js): every deal, plus one account per money market fund on an uploaded statement.
  `holdingsOn` and `periodReport` value through them. `daily.js`: `dailyBreakdown` (per position per day: open, in,
  out, income, close; income = close − open − in + out, so incomes + external flows = the NAV change) and
  `positionStatement`, plus `cashStatement` for the uninvested balance. Holdings ends with a "Cash and call deposits"
  group (cash at bank from `navSeries`, and open call deposits), so its total is NAV; the cash row opens the cash
  statement (`openHoldingStatement('cash')`). Every fund in `funds` always has a Holdings row: with nothing in it, an
  idle row (last redemption, Subscribe pre-filled, Upload statement). #/navdaily (`views/navdaily.js`) shows it by investment or class, as income or value; clicking a
  holding (Holdings rows, Daily NAV) opens its daily statement (`views/holdingdetail.js`).
- Fund statements: Holdings → Upload fund statement (`views/fundupload.js`, `fundstatement.js`: `parseStatement` finds the
  Date / Investment / Liquidation / Withdrawal / Rate / Earnings / Balance columns, `statementPlan` matches movements to
  recorded ones within ₦1). Daily rows go into `fundPrices/{fundId}_{date}` with `balance` (rows in closed quarters are
  left out); unmatched movements become subscriptions/redemptions on the fund account `instruments/acct-{fundId}`.
  From a fund's first statement day the engine values the whole fund at the statement balance (`FundStatementBook`;
  after the last row it accrues at the last rate), instead of deal by deal.
- Partial liquidation (fixed deposits only): `partialLiquidationPlan` in liquidation.js + `partialLiquidate` in actions.js.
  One change: early `mature` for value-to-date less penalty, new deposit for the balance at the same rate to the
  original maturity (`parentId`), its `invest`, and optionally a `withdrawal` of the amount needed.
- Quarterly income payout (Access's mandate): `src/app/payout.js`. Up to 2026Q3 the gross income was paid (plain
  withdrawals in the history); from `NET_PAYOUT_FROM` (2026Q4) payable = the closed quarter's `income` − `mgmtFee` −
  `incentiveClause8` (never below zero), fixed at close. A payout is a `withdrawal` with `purpose: 'income_payout'` and
  `quarter`; recorded from the Quarter close card or tagged on the Transactions form. Alert while one is outstanding;
  the fee computation document shows the income payable.
- Periods: `src/app/period.js` (QTD, YTD, any quarter, since inception, custom); one shared choice across Dashboard, Reports, History.
- Alerts: `src/app/alerts.js` computes them live from the data and the limits in force (`limitsFrom(data, date)`: latest
  `limitSets/{effectiveFrom}` version, else `settings/limits`, else plan defaults). New deals over the tenor limit or with
  a counterparty rated below `minRating` are refused (FGN bills exempt). Email: `digest.html` + `src/app/digest.js`
  (`buildDigest`), rendered in headless Chrome by `tools/digest/send-digest.ps1` in `.github/workflows/daily-digest.yml`
  (07:00 Lagos weekdays; SMTP secrets in GitHub; `src/app/rest.js` reads Firestore over REST so the page finishes loading).
- Rollover: Holdings → Roll over writes maturity + new deal + its investment entry as one change (same terms, principal = proceeds by default).
- Quarter close: `src/app/close.js` (benchmark = last 91-day NTB auction before the quarter; `computeClose` wraps the engine's
  `closePeriod`; `lockedBy`). Closing saves `quarterlyResults/{label}` with every figure frozen; while it exists `commit`
  refuses changes to transactions, fund prices or deals dated in (or held across) that quarter. Reopen = delete it.
  #/close also renders the statement of account (Cl. 9) and fee computation (Cl. 8; Clause 12 only on the screen).
- Market: `src/app/market.js` (latest auctions, MPC, events, `rankOpportunities` with the tenor, concentration and
  liquidity rules; FGN paper exempt from concentration). Data comes from `tools/feeds/fetch-feeds.ps1`, run by
  `.github/workflows/market-feeds.yml` (weekdays, no secrets; CBN JSON APIs have no CORS so the browser can't call them)
  and only ever adds missing docs. Every feed also has a manual form on #/market.
  News (`news`) and an auction calendar (`upcomingAuctions`: entered `auctionCalendar` dates, else projected from the
  recent cycle) are on #/market too; reinvestment options below the minimum rating are rejected.
- Back-test (#/backtest): `src/app/backtest.js` `runBacktest` reruns `computeClose` for every completed quarter (one NAV
  series, `withReport: false`) against `invoices/{quarter}` (billed fees, loaded from `data/invoices-mcm.json`, built
  by `tools/history/build-invoices.ps1` from the workbook's "MCM income" sheet).
- Termination (#/termination): `computeTermination` in close.js; End-Date Portfolio = `holdingsOn` at the date.
- Counterparties (#/counterparties): `src/app/counterparties.js` (rating scale and normalising, `ratingOn` = lowest of
  each agency's latest, downgrades, exposure by counterparty and custodian, `ratingAlerts`, `dealRatingCheck`).
- Management report (#/management): AUM, ARIP vs hurdle, fees under all readings vs billed, concentration, and
  `breachesBetween` (src/app/mgmt.js: month-end checks against the limits then in force).
- Excel: `downloadXlsx`/`excelButton` in ui.js (SheetJS 0.18.5 from jsDelivr, loaded on first use; `xMoney`, `xPct`,
  `xDate` cells). On Holdings (with filters), Reports, Management report, Back-test, Termination, Counterparties.
- Backups: Settings > Backup (download / restore, `src/app/backup.js`); `tools/backup/backup.ps1` in
  `.github/workflows/nightly-backup.yml` keeps a 30-day artifact.
- `src/app/firebase.js` Firestore init; `store.js` live onSnapshot state (+ 10 s "stalled" flag);
  `actions.js` every write (one batch); `portfolio.js` Firestore docs -> engine inputs; `ui.js` DOM helpers,
  formatting, modal forms; `views/` one file per screen. Forms live in modals so live re-renders don't wipe input.
- A deal = an `instruments` doc + its `invest`/`fund_subscription` transaction, written together.
  A `mature`/`fund_redemption` transaction takes the holding off the Holdings list.
- A `mature` dated before the contract maturity is an early termination: the holding leaves NAV that day.
- Asset classes: `ASSET_CLASSES` in portfolio.js (fixed order = fixed chart colour `--class-<key>` in styles.css);
  `call_deposit` is its own type, valued like `fixed_deposit`. `periodReport` drives #/reports.
- Change history: every write in actions.js goes through `commit`, which also appends an `audit` doc
  (before/after of each touched doc); #/history lists them with Undo. The audit write is separate so a
  rules problem never blocks the save itself.
- Look: MBO Capital crimson (#c4122f) and slate grey; charts are inline SVG in `src/app/charts.js`.
- `src/engine/` pure calculation engine, no I/O.
- History import: `data/history-2026-09-30.json` (inception to 30 Sep 2026) is built by
  `tools/history/build-history.ps1` from `tools/history/source.txt` plus the workbook's bank ledger, fee table and
  fund yields; it prints a day-by-day cash reconciliation against the bank ledger. `src/app/history.js` maps it to
  documents with fixed `hist-` ids (rerunnable); Settings > Import history loads it into an empty database.
- `tests/` in-browser tests: `tests/harness.js` (describe/it/expect), `tests/engine/*.test.js`, `tests/app/*.test.js`,
  run from `tests/index.html`. Add new test files to its imports.
- `firestore.rules` open read/write on the app collections with shape validation (audit is append-only); `firestore/MODEL.md`.
  Rules are published by pasting into the Firebase console; code must keep working before they are.
- `serve.ps1` local static server (PowerShell, no install).

## Running tests
`powershell -ExecutionPolicy Bypass -File serve.ps1` (add `-Port 8091` if 8080 is taken), then open http://localhost:8080/tests/
(ES modules do not load from file://).
