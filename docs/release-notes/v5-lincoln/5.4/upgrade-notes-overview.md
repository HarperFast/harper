---
section: 'Upgrade Notes'
order: 10
---

Full-text indexes using fulltext 0.5.0 with current field-based declarations, or prerelease 0.6, rebuild locally after this upgrade. Plan for search unavailability and review the [Tantivy upgrade requirements](#tantivy-027-and-existing-index-rebuilds) before deploying; direct downgrade to fulltext 0.5.x is unsupported.

Harper 5.4 marks failed transactions as aborted in the RocksDB transaction log by default ([`storage.rocks.transactionLogAbortMarkers`](/reference/v5/database/storage-tuning#storagerockstransactionlogabortmarkers); see [Failed Transactions Are Marked Aborted](#failed-transactions-are-marked-aborted-in-the-transaction-log)). Harper 5.3.4 and earlier cannot read those markers and would treat the failed transactions as committed. Do not downgrade a node to them, or open its database files or backups with them, after it has run 5.4 with the setting on. Harper 5.3.5 and later read the markers. Setting it to `false` later stops new markers but does not remove ones already written.
