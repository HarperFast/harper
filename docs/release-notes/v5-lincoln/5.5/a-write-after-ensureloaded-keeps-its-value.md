---
section: 'Resource API'
---

### A Write After `ensureLoaded()` on a Caching Table Keeps Its Value

On RocksDB, a write to a caching table made after `ensureLoaded()` in the same transaction could be overwritten by the background cache fill that `ensureLoaded()` started or waited for, so the table kept the source's value although the write was acknowledged. The write is now kept, except when the transaction had already written another record and then waited for a fill another request started; that case is tracked in [#4546](https://github.com/HarperFast/harper/issues/4546). LMDB already kept the write. See [write-through caching](/reference/v5/resources/resource-api#write-through-caching).
