---
section: 'Full-Text Search'
---

### A Restart No Longer Rebuilds an Up-to-Date Full-Text Index

Restarting a node about a second after a write could reset a healthy full-text index and rebuild it from the table, and searches on that index answered `503` until the rebuild finished. An index saves its position in the transaction log first and the query coverage that goes with it a moment later. A node that stopped between the two, whether shut down cleanly or killed, started with the position saved and the coverage missing. Nothing was left to index, so the first thing the index's writer was asked to do was save that coverage, and it treated a request that arrived before any indexing work as a failure. Harper then discarded the index. The writer now accepts a coverage update as its first work, so the index stays in place and is searchable as soon as the node is up.
