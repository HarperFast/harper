---
section: 'Full-Text Search'
---

### Writes After an Idle Period Are Not Refused

A database left idle for longer than an index's lag budget (30 seconds by default) no longer refuses writes right after its next commit. Full-text and native vector indexes measured their lag from the last change they had saved, so the idle time counted as lag: for about a second, writes to the indexed table got `503` with `code: "DERIVED_INDEX_LAGGING"` while the index was fully caught up. Lag now counts only changes the index has read but not yet saved. See [Write backpressure](/reference/v5/full-text-search/overview#write-backpressure).
