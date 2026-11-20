---
section: 'Resource API'
---

### A Write After `ensureLoaded()` on a Caching Table Keeps Its Value

On RocksDB, a write to a caching table made after `ensureLoaded()` in the same transaction could be overwritten by the background cache fill that `ensureLoaded()` started, so the table kept the source's value although the write was acknowledged. A fill started inside a transaction is now versioned before that transaction's own writes, so the write is kept. A fill's version, and the `updatedTime` it stores, can therefore be slightly earlier than before. LMDB already kept the write. See [write-through caching](/reference/v5/resources/resource-api#write-through-caching).
