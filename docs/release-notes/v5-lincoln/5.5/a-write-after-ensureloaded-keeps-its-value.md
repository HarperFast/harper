---
section: 'Resource API'
---

### A Write After `ensureLoaded()` on a Caching Table Keeps Its Value

On RocksDB, a write to a caching table made after `ensureLoaded()` in the same transaction could be overwritten by the background cache fill that `ensureLoaded()` started or waited for, so the table kept the source's value although the write was acknowledged. The write is now kept, except in some cases where the transaction had written another record before the fill resolved, tracked in [#4546](https://github.com/HarperFast/harper/issues/4546). For a transaction that had already written, the fill's version, and the `updatedTime` it stores, can be earlier than before, by up to how long the transaction ran before the fill. LMDB already kept the write. See [write-through caching](/reference/v5/resources/resource-api#write-through-caching).
