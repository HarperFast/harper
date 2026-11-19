---
section: 'Storage'
---

### Record Cache Size Setting

The new `storage.recordCacheSize` setting sets how many entries each thread's in-memory record cache holds (RocksDB only; default `32768`, the size it already had). Harper now also sizes RocksDB's verification table, which lets a cache hit return without a RocksDB read, from the record cache size and the number of threads it starts. The table gets two slots per record those caches can hold, at least RocksDB's previous 131,072 (1 MB), and grown no further than 1/64 of memory. With 4 or more worker threads the table therefore grows even at the default cache size, to 4 MB on 4 workers; before, cache hits there could fall back to RocksDB reads. On an installation that still has LMDB databases, LMDB's record caches now keep their own default-sized budget instead of sharing one with the RocksDB record cache. The undocumented `HARPER_RECORD_CACHE_SIZE` environment variable is no longer read. See [`storage.recordCacheSize`](/reference/v5/database/storage-tuning#storagerecordcachesize).
