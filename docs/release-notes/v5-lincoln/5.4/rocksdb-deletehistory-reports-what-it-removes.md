---
section: 'Storage'
---

### `Table.deleteHistory` on RocksDB Reports What It Removes

On a RocksDB database, `Table.deleteHistory(endTime)` now returns `0` without reading the audit log. It removes no audit entry: a RocksDB transaction log is shared by every table in its database and loses only whole files, through the retention settings or `delete_transaction_logs_before` for the whole database. Before, it read the whole log, reported every entry of the table as deleted, and removed the table's tombstones (records left by deletes) as a side effect, which made those deletes invisible to a subscription replaying from before them. To remove tombstones, pass `cleanupDeletedRecords: true` as the second argument; that still sweeps tombstones older than `endTime`. On LMDB the method is unchanged. Audit history removal on RocksDB is also now ordered behind a durable audit floor at startup, as it already was during normal operation.
