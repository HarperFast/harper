---
section: 'Full-Text Search'
---

### A Restart No Longer Rebuilds an Up-to-Date Full-Text Index

A full-text index that was fully up to date could be reset and rebuilt from its table when a node started. Searches on that index answered `503` until the rebuild finished. It happened when the node had stopped abruptly, such as a crash or a forced kill, in the moment after an index saved its position in the transaction log and before it saved the query coverage that goes with it. A clean shutdown saves both, so an ordinary restart was not affected. After such a stop there was nothing left to index, so the first thing the index's writer was asked to do was save that coverage, and it treated a request that arrived before any indexing work as a failure. Harper then discarded the index. The writer now accepts a coverage update as its first work, so the index stays in place and is searchable as soon as the node is up.
