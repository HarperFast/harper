---
section: 'Storage'
order: 10
---

### RocksDB Memtable Arena Sized From the Write Buffer Budget

RocksDB now sizes each column family's memtable arena block from the write buffer budget: `writeBufferManagerSize / 2048`, between 64 KiB and 1 MiB (previously a fixed 1 MiB). Every written table holds at least one block against the budget, even while idle, so with many tables on a small instance the fixed size used up most of the write budget and caused constant small flushes. Two new settings override the defaults: `storage.rocks.arenaBlockSize` (bytes) and `storage.rocks.writeBufferManagerFlushPolicy` (`oldest`, `largest`, or `largestAcrossDBs`). When `writeBufferManagerAllowStall` is `true`, the flush policy now defaults to `largestAcrossDBs`, so a stalled write no longer waits forever on memory held by idle databases. See [RocksDB Memory](/reference/v5/database/storage-tuning#rocksdb-memory) ([harper#3712](https://github.com/HarperFast/harper/pull/3712)).
