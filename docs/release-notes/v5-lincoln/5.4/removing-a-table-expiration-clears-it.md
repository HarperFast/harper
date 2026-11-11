---
section: 'Storage'
---

### Removing a Table's Expiration Clears It

`@table` (and `defineTable`) now clears an `expiration` or `eviction` it no longer names, or sets to `0`, after a restart and on threads that load the table without declaring it. Before, the old value stayed in effect, so a table kept expiring records after its schema stopped declaring a TTL. If you relied on that, declare the value again. Records already written keep the expiry they were given. A negative or non-numeric `expiration`, `eviction` or `scanInterval` now fails the declaration with an error naming the table and argument, instead of failing the table later; `create_table` accepts `eviction` and rejects a negative or non-numeric `expiration` or `eviction` with a 400. Expired records are now removed on schedule after a restart with `threads.count: 0`, and on a table that has only `eviction`, without waiting for a write. See [`@table`](/reference/v5/database/schema#table).
