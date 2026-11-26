# Firestore data model

Single client, single pooled portfolio. Internal reporting tool: no sign-in, no roles, no approvals.
Instrument types: ntb, omo, commercial_paper, fixed_deposit, call_deposit (valued like a fixed deposit), money_market_fund.
Money and rates are stored as decimal **strings** (`"10000000000.00"`, `"0.0075"`), never numbers.
Dates are `"YYYY-MM-DD"` strings. Security rules: [`../firestore.rules`](../firestore.rules).

| Collection | Doc id | Purpose | Key fields |
| --- | --- | --- | --- |
| transactions | auto | Every cash or position movement | type, date, amount, instrumentId, reference, notes, updatedAt; a quarterly income payout to Access is a withdrawal with purpose `income_payout` and quarter (`2026Q4`) |
| instruments | auto | Each deal | type, counterpartyName, custodianName, fundId, pricingBasis, faceValue, cost, units, rate, discountRate, tradeDate, valueDate, maturityDate, updatedAt |
| mandateTerms | effectiveFrom date | Agreement terms, dated; client details live here | clientName, clientAddress, clientContact, startDate, anniversary, noticeDays, mgmtFeeRate, incentiveRate, hurdleSpread, incentiveReading, feeDayCount (quarterly or act365; app default quarterly), effectiveFrom |
| funds | auto | Money market funds (Clause 11 flag) | name, managerName, pricingBasis (price or yield), isMboManaged |
| fundPrices | `{fundId}_{date}` | Fund prices, or annual yields as fractions. Rows from an uploaded platform statement also carry `balance`, `income`, `subscription`, `redemption` (decimal strings) and `source: 'statement'`; from a fund's first such row the fund is valued at the balance | fundId, date, priceOrYield |
| audit | auto | Change history, append-only: one doc per save or delete | summary, kind (edit, delete, restore), at, changes [{coll, docId, before, after}] |
| settings | `limits` | Alert thresholds and deal limits (defaults in src/app/alerts.js until saved) | idleCash, idleDays, maturityWarnDays, liquidityShare, liquidityDays, concentrationShare, maxTenorDays, minRating |
| quarterlyResults | quarter label (`2026Q3`) | Closed quarter: frozen figures; its existence locks entries dated in the quarter; delete = reopen | quarter, periodStart, periodEnd, days, benchmark {auctionId, auctionDate, tenorDays, stopRate, trueYield, sourceUrl}, terms {...}, arip, watbr, hurdle, avgNav, hurdleMet, mgmtFee, incentiveClause8, incentiveClause12, incentiveWorksheet, worksheetIncome, worksheetBenchmarkIncome, openingNav, closingNav, inflows, withdrawals, fees, income, status (closed, billed), closedAt, billedOn |
| auctions | `{ntb|omo}-{date}-{tenor}` | CBN NTB primary and OMO auction results (feed or manual) | kind, date, tenorDays, stopRate (discount, fraction), trueYield (only if published), maturityDate, offeredM, subscribedM, allottedM (naira millions), source, sourceUrl |
| mpc | decision date | MPC decisions | date, mpr, corridor, title, source, sourceUrl |
| cpQuotes | auto or `fmdq-{postId}` | CP quotations; count as options once confirmed | date, issuer, title, size, tenorDays, yield, rating, confirmed, source, sourceUrl |
| feedStatus | feed key (cbn_ntb, cbn_omo, cbn_mpc, fmdq_cp, cbn_cpi, news) | Last run of each market feed; drives stale-feed alerts | feed, lastRunAt, lastSuccessAt, lastError, lastErrorAt, added, value (cbn_cpi: headline inflation) |
| news | `news-{sha1 of url}` | Money-market news (Nairametrics, BusinessDay RSS, filtered) and CBN circulars | date, title, url, source |
| auctionCalendar | `{kind}-{date}` | Auction dates entered from the CBN or DMO calendar (override the projection) | date, kind (ntb, omo, fgn_bond), tenors, notes |
| invoices | quarter label | Fees MBO billed, from the MCM income sheet (back-test) | quarter, periodEnd, days, mgmtFee, incentiveFee, totalFee, sheetIncome, sheetBenchmarkIncome, invoiceDate, source |
| counterparties | auto | Register of banks, CP issuers, fund managers, custodians | name, kind (bank, issuer, fund_manager, custodian), aliases (comma separated), notes |
| ratings | auto | Rating history (long-term national scale) | counterpartyId, counterparty, agency, rating, date, outlook, sourceUrl |
| limitSets | effective date | Dated versions of Settings > Limits; breaches are judged against the version in force | effectiveFrom + the settings/limits fields |

Transaction types: inflow, withdrawal, fee_debit, invest, mature, rollover, interest, fund_subscription, fund_redemption.
Amounts are positive magnitudes; the type gives the direction. A deal is an `instruments` doc plus its `invest`
(or `fund_subscription`) transaction, written together. Recording a `mature` or `fund_redemption` transaction
takes the holding off the Holdings list.

Not built yet: dailyNav (NAV is computed live), statements and reconciliation, news items, email digest.

## Access
There is no sign-in, so the rules cannot tell who is reading or writing. They only accept the collections
listed and reject malformed data; audit entries can be added but never changed or deleted. Anyone with the app's address can read and change the data.
