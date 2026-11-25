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
- **Dashboard** shows NAV (gross of fees), cash, holdings, quarter-to-date return and fee accrued, and maturities due.

## Tests

`powershell -ExecutionPolicy Bypass -File serve.ps1`, then open http://localhost:8080/tests/ (35 tests).
Open http://localhost:8080/ for the app itself.
