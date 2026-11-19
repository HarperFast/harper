---
section: 'Transactions'
order: 10
---

### Failed Transactions Are Marked Aborted in the Transaction Log

The new `storage.rocks.transactionLogAbortMarkers` setting is on by default (RocksDB only). When a transaction fails after its entry was written to the transaction log, the entry is now marked aborted, and replication, subscriptions, `read_audit_log` and replay after a crash all skip it. A write that keeps conflicting with other writes after its log entry was written no longer retries without limit: like other conflicting writes, it fails with HTTP `500` after 40 commit conflicts, or with HTTP `503` and code `TRANSACTION_COMMIT_CONFLICT_TIMEOUT` once it has been in conflict for longer than `storage.maxTransactionQueueTime`, whichever comes first. Writes applied from replication or a caching source, and a transaction part of which has already committed, still retry until they commit. Set the setting to `false` to keep the 5.3 behavior. Harper reads it once per process, so a change needs a `restart` of each node; `restart_service` does not apply it. Harper 5.3.4 and earlier cannot read the markers. See the [Upgrade Notes](#upgrade-notes) and [`storage.rocks.transactionLogAbortMarkers`](/reference/v5/database/storage-tuning#storagerockstransactionlogabortmarkers) ([harper#3928](https://github.com/HarperFast/harper/pull/3928)).

The new [`storage.rocks.transactionLogWriteIntents`](/reference/v5/database/storage-tuning#storagerockstransactionlogwriteintents) setting, off by default, makes a commit that would conflict with an older, still-open transaction wait for that transaction to finish, usually before writing its transaction-log entry. This shortens the longest waits under heavy write contention, but adds retries and lowers throughput when transactions are large or contention is low. It needs abort markers on and a full `restart` to change.
