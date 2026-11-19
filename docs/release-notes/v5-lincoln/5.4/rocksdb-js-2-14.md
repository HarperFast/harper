---
section: 'Storage'
---

### rocksdb-js 2.14

Harper now uses rocksdb-js 2.14.0, which flushes and closes every database itself when the main thread calls `process.exit()`, so Harper no longer registers its own exit listener. `HARPER_NO_FLUSH_ON_EXIT` again skips that flush. A failed exit flush sets exit code `1` instead of throwing from the listener and skipping every later `exit` listener ([harper#4211](https://github.com/HarperFast/harper/pull/4211), [harper#4269](https://github.com/HarperFast/harper/pull/4269)).

`primaryStore.cache` now returns the RocksDB record cache, the same `WeakLRUCache` shape LMDB exposes; before, it was `undefined` on RocksDB ([harper#3449](https://github.com/HarperFast/harper/pull/3449)).
