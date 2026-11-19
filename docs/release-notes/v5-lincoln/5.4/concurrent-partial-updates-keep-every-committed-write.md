---
section: 'Transactions'
---

### Concurrent Partial Updates Keep Every Committed Write

On an audited RocksDB table, concurrent partial updates (`update()` with `addTo`, `patch()`) could lose an acknowledged write when a transaction retried after a conflict, leaving an older write's field values. A retry now finds the committed log entries of transactions still in flight, so every acknowledged write is kept ([harper#3728](https://github.com/HarperFast/harper/pull/3728)).
