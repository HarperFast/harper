---
section: 'Subscriptions'
---

### A `startTime` Subscription No Longer Drops a Late Commit

On RocksDB, a table subscription with `startTime` used to switch from catch-up to live delivery at the newest `localTime` it had replayed. A transaction that committed during catch-up with a lower `localTime` was then delivered by neither, and some replayed events arrived twice. The switch now happens at live delivery's position in each transaction log, so each event arrives once. A write merged into a newer version, which live delivery already reports as the merged record, is now reported the same way during catch-up. If a transaction log cannot be read up to that position for about five seconds, the subscription ends with a 503 error; subscribe again to retry. See [`subscribe()`](/reference/v5/resources/resource-api).
