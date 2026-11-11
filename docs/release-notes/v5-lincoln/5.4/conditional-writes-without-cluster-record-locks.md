---
section: 'REST'
order: 30
---

### Conditional Writes Without Cluster Record Locks

A conditional `PUT`, `PATCH` or `DELETE` (`If-Match`, `If-None-Match`, `If-Unmodified-Since`) takes the record's lock by default in 5.4, so only one of several requests that saw the same `ETag` succeeds. On a replicated table that lock is a cluster record lock. When a node runs without cluster record locks (Harper Pro's `replication.recordLocks` is not enabled, the self-hosted default), its conditional writes to replicated tables are checked without a lock, as in 5.3: they no longer fail with `503`. Concurrent requests that saw the same `ETag` can then all succeed, and the last write wins.

With cluster record locks enabled, conditional writes keep the lock. Until a home map is in place they fail with `503`, and the message says how to establish one. `rest.preconditionLocks: false` still checks every conditional write without a lock. See [Conditional Writes](/reference/v5/rest/headers#conditional-writes).
