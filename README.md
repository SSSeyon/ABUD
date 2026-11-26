# ABUD Portfolio

Internal reporting and monitoring tool for MBO Capital's management of the Access Holdings Plc unclaimed dividend pool.
Static site (GitHub Pages) + Firestore. No sign-in, no approvals. Nothing to install.

## Firebase setup (project `abud-24577`)

Done on 25 Nov 2026: Firestore database `(default)` created (Standard edition, production mode,
location `europe-west2` London, which cannot be changed), and [`firestore.rules`](firestore.rules) published.
After any change to `firestore.rules`, paste it into **Firestore → Rules** in the console and click **Publish**.

Still to do in the app: **Settings → Mandate terms**, add the current agreement terms. Add funds if any.

## Access

There is no sign-in. Anyone who has the app's address can view **and change** the data.
Keep the address internal. If the repository is public on GitHub, its address and Firebase project are discoverable.

## Deploy

Upload the folder to GitHub and turn on **Settings → Pages** (deploy from branch, root folder).
Files that matter: `index.html`, `styles.css`, `src/`.

## Using it

- **Holdings → New deal** records an investment (bill, OMO, CP, fixed deposit, fund). **Record maturity** when it pays out.
- **Transactions** for inflows from Access, withdrawals, interest and fee debits. Entries can be edited or deleted.
- **Dashboard** shows NAV (gross of fees), cash, holdings, quarter-to-date return and fee accrued, money flows (Sankey,
  bar or donut) and maturities due. The bell (top right) lists today's alerts; the sun/moon button switches dark mode.
- **Holdings**: click a holding for its daily statement (opening, inflows, withdrawals, income, closing).
  **Part-liquidate** on a fixed deposit takes out an amount plus the penalty and rolls the balance to the same maturity.
  **Upload fund statement** reads the money market fund Excel from the platform; the fund is then valued at its balance.
- **Quarter close → Income payout to Access**: each quarter's income goes to Access; from 2026Q4 net of MBO's fees,
  fixed when the quarter is closed. **Record payout** enters the withdrawal tagged to its quarter.
- **Reports → Daily NAV**: each day's NAV and the income from every investment, for the chosen period.

## Scheduled jobs (GitHub Actions)

- **Market feeds** (weekdays 07:30 and 19:00 Lagos): CBN auctions, MPC, inflation, FMDQ CP notices and news. No secrets.
- **Daily digest** (weekdays 07:00 Lagos): emails alerts, maturities due this week, cash to deploy and the top three
  options. Add repository secrets under Settings > Secrets and variables > Actions: `SMTP_URL` (for example
  `smtps://smtp.gmail.com:465` or `smtp://smtp.office365.com:587`), `SMTP_USER`, `SMTP_PASS` (an app password),
  `DIGEST_TO` (comma separated) and optionally `DIGEST_FROM`. Without them the job only prints the digest.
  Preview it any time at `digest.html`.
- **Nightly backup** (00:30 Lagos): every collection as one JSON file, kept 30 days as a workflow artifact.
  Restore it from Settings > Backup.

## Tests

`powershell -ExecutionPolicy Bypass -File serve.ps1`, then open http://localhost:8080/tests/.
Open http://localhost:8080/ for the app itself.
