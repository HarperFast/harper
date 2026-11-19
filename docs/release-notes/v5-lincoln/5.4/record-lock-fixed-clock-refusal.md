---
section: 'Transactions'
order: 42
---

### Record Lock Writes Refused When the Transaction Clock Is Fixed Below the Admitted Version

On RocksDB, saving a write to a record held under `table.lock()` inside an explicit `transaction()` now fails with `409` whenever the transaction's clock was already fixed (by an earlier unlocked write or a prior saved write) below the record version `lock()` reloaded at admission ([harper#2712](https://github.com/HarperFast/harper/issues/2712)). Previously, only a `{ hold: true }` lock whose own earlier write, or admitted version, was stamped ahead of the clock was checked. A write under a lock admitted on a version committed after the transaction's first write was stamped at the older transaction time and lost under last-write-wins (on `audit: true` tables, merged out of order for disjoint fields and commutative operations).

- Applies to scoped locks (`table.lock(id)`), held locks (`table.lock(id, { hold: true })`), and static table writes (`put`, `patch`, `update`, `delete`) joined to a lock on the same key.
- Read-only scoped locks that stage no record change still commit without error.
- To avoid the `409`, acquire record locks before the transaction's first write, or save the locked record in its own transaction.
