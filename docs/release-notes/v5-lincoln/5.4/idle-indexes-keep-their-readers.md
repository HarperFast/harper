---
section: 'Full-Text Search'
---

### Idle Indexes Keep Their Readers

A full-text index whose table gets no writes no longer reopens its native reader on every worker about every 30 seconds. Harper's own background commits, which write nothing to the transaction log, woke the index's runner, and each wake started a new ownership of the index. A search that arrived while a worker reopened its reader could answer `503`. A runner now takes ownership only when the transaction log has moved, a rebuild is requested, or a query waits for coverage. Native vector indexes no longer repeat that cycle either.
