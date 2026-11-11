---
section: 'Storage'
---

### Removing a Table's Expiration Clears It

Removing `expiration` or `eviction` from `@table` (or from `defineTable` options), or setting it to `0`, now clears the saved value on every thread and after a restart. Before, the old value stayed in effect, so a table kept expiring records after its schema stopped declaring a TTL. If you relied on that, declare the value again. Records already written keep the expiry they were given. A negative or non-numeric `expiration`, `eviction` or `scanInterval` now fails the declaration or `create_table` with an error naming the table and argument, instead of failing the table later; `create_table` also accepts `eviction`. Expired records are now removed on schedule after a restart with `threads.count: 0`, and on a table that has only `eviction`, without waiting for a write. See [`@table`](/reference/v5/database/schema#table).
