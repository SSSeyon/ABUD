# Firestore data model

Single client, single pooled portfolio. Internal reporting tool: no sign-in, no roles, no approvals.
Money and rates are stored as decimal **strings** (`"10000000000.00"`, `"0.0075"`), never numbers.
Dates are `"YYYY-MM-DD"` strings. Security rules: [`../firestore.rules`](../firestore.rules).

| Collection | Doc id | Purpose | Key fields |
| --- | --- | --- | --- |
| transactions | auto | Every cash or position movement | type, date, amount, instrumentId, reference, notes, updatedAt |
| instruments | auto | Each deal | type, counterpartyName, custodianName, fundId, pricingBasis, faceValue, cost, units, rate, discountRate, tradeDate, valueDate, maturityDate, updatedAt |
| mandateTerms | effectiveFrom date | Agreement terms, dated; client details live here | clientName, clientAddress, clientContact, startDate, anniversary, noticeDays, mgmtFeeRate, incentiveRate, hurdleSpread, incentiveReading, effectiveFrom |
| funds | auto | Money market funds (Clause 11 flag) | name, managerName, pricingBasis (price or yield), isMboManaged |
| fundPrices | `{fundId}_{date}` | Fund prices, or annual yields as fractions | fundId, date, priceOrYield |

Transaction types: inflow, withdrawal, fee_debit, invest, mature, rollover, interest, fund_subscription, fund_redemption.
Amounts are positive magnitudes; the type gives the direction. A deal is an `instruments` doc plus its `invest`
(or `fund_subscription`) transaction, written together. Recording a `mature` or `fund_redemption` transaction
takes the holding off the Holdings list.

Planned for later phases: benchmarkRates, dailyNav and quarterlyResults (quarter close), limits, alerts,
market data (cpQuotes, mpcDecisions, newsItems, feedStatus), statements for reconciliation.

## Access
There is no sign-in, so the rules cannot tell who is reading or writing. They only accept the five collections
above and reject malformed data. Anyone with the app's address can read and change the data.
