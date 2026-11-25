---
section: 'Resource API'
---

### A Write After `ensureLoaded()` on a Caching Table Keeps Its Value

On RocksDB, a write to a caching table made after `ensureLoaded()` in the same transaction could be overwritten by the background cache fill that `ensureLoaded()` started or waited for, so the table kept the source's value although the write was acknowledged. That fill now orders before the transaction's writes, so the write is kept, unless the transaction had already written before it waited for another request's fill. A fill's version, and the `updatedTime` it stores, can therefore be slightly earlier than before. LMDB already kept the write. See [write-through caching](/reference/v5/resources/resource-api#write-through-caching).
