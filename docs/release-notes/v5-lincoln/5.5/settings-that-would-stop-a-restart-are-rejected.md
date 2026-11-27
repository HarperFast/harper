---
section: 'Configuration'
---

### Settings That Would Stop a Restart Are Rejected When Set

`set_configuration` now answers 400, and writes nothing, for values Harper used to accept and then failed on: an unknown [`storage.rocks.compression`](/reference/v5/database/storage-tuning) codec, which kept the next start from loading the system database; HTTP and operations API timeouts or `http.maxHeaderSize` that Node.js refuses, which stopped the server; and durations past about 24.8 days, below zero, or of the wrong type for `storage.transactionLog.coolingInterval`, [`storage.reclamation.interval`](/reference/v5/database/storage-tuning#storagereclamationinterval), [`storage.maxTransactionQueueTime`](/reference/v5/database/storage-tuning#storagemaxtransactionqueuetime) and `storage.longTransactionReportThreshold`, which Node.js runs every millisecond. `http.headersTimeout` may no longer exceed `http.timeout`, the operations API is checked with the values it inherits from `http`, and `storage.maxTransactionOpenTime`, `storage.reclamation.threshold`, `storage.rocks.blockCacheSize`, `storage.rocks.writeBufferManagerSize` and `threads.heapSnapshotNearLimit` are held to their documented types and ranges. `config-root.schema.json` states the same bounds.

Before upgrading, check the configuration file and any environment override for these settings: Harper now stops at startup, naming the setting, instead of starting with such a value. A codec name the installed build lacks is still caught when the database opens, as before. A duration written in milliseconds (`500ms`) needs rewriting as a fraction of a second (`0.5s`); `M` (months) and `y` (years) units, a reclamation interval of `0`, and a quoted number for an HTTP timeout or RocksDB size are also rejected.
