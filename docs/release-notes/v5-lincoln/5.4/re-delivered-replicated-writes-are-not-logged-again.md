---
section: 'Replication'
---

### Re-delivered Replicated Writes Are Not Logged Again

When peers relay the log of an origin that was removed, wiped or restored, a replicated write can reach a node many times. A replicated invalidate arriving again onto the stub it left, and an out-of-order write whose audit walk cannot reach its own entry, were logged again on every delivery, and every peer forwarded each new copy. One record's log could grow to hundreds of thousands of copies until replication failed with `Message too large to send`. Both are now recognized as duplicates and skipped ([harper#4199](https://github.com/HarperFast/harper/pull/4199)).

Each RocksDB transaction log's purge bound, which decides whether a follower can resume incrementally, is now read from rocksdb-js's purge watermark: exact, and synced before each file is deleted. Before, Harper estimated it by probing the log, which missed keys issued ahead of the clock and forced needless base copies after downtime longer than `auditRetention`. Logs written before rocksdb-js 2.14 keep the old rule ([harper#4238](https://github.com/HarperFast/harper/pull/4238)).
