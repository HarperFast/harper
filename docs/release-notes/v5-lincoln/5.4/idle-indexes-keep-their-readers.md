---
section: 'Full-Text Search'
---

### Idle Indexes Keep Their Readers

A full-text index in a database whose transaction log gets no new entries no longer reopens its native reader on every worker about every 30 seconds. Harper's own background commits write nothing to the transaction log. Each one still woke the index's runner, and each wake started a new ownership of the index. A search that arrived while a worker reopened its reader could answer `503`. A runner now takes ownership only when the transaction log has moved, a rebuild is requested, or a query waits for coverage. A write to any table in the database moves the log, so the reader is still reopened after a quiet period that ends with such a write. Native vector indexes no longer repeat the cycle either.
