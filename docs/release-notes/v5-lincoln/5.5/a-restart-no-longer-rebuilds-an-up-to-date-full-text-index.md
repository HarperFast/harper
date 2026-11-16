---
section: 'Full-Text Search'
---

### A Restart No Longer Rebuilds an Up-to-Date Full-Text Index

Restarting a node shortly after a write could reset a healthy full-text index and rebuild it from the table, and searches on that index answered `503` until the rebuild finished. A shutdown within about a second of the last write to any table in the database saved the index's position in the transaction log but not the query coverage that goes with it. After the restart there was nothing left to index, so the first thing the index's writer was asked to do was save that coverage, and it treated a request that arrived before any indexing work as a failure. Harper then discarded the index. The writer now accepts a coverage update as its first work, so the index stays in place and is searchable as soon as the node is up.
