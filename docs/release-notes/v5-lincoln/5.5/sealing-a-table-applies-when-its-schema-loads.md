---
section: 'Storage'
---

### Sealing a Table Applies When Its Schema Loads

Adding `@sealed` to an existing table, or declaring `@table(sealed: false)`, now takes effect as soon as the schema loads, on every thread. Before, the running table kept its old setting until it was next loaded from disk, so a deploy that sealed a table kept accepting undeclared properties until a second restart. `@table(audit: false)` on an existing table still takes effect only the next time the table is loaded from disk, because open subscriptions read their events from the transaction log. See [`@sealed`](/reference/v5/database/schema#sealed) and [Enabling the Transaction Log Per Table](/reference/v5/database/transaction#enabling-the-transaction-log-per-table) ([harper#2564](https://github.com/HarperFast/harper/pull/2564)).
