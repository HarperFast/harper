---
section: 'Full-Text Search'
---

### Writes After an Idle Period Are Not Refused

Full-text and native vector indexes no longer refuse writes right after a quiet period. When a database had been idle for longer than an index's lag budget (30 seconds by default), the index counted the idle time as lag at its next commit, so for about a second writes to the indexed table got `503` with `code: "DERIVED_INDEX_LAGGING"` although the index was caught up. The distance an index measures behind what it has read now starts at the first change it has read but not yet saved, so idle time before that change does not count. See [Write backpressure](/reference/v5/full-text-search/overview#write-backpressure).
