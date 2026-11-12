---
section: 'Backups'
order: 40
---

### Restored Vector Indexes Rebuild Instead of Losing Vectors

A backup does not contain the native file in which an HNSW vector index keeps its graph (the default on an audited table). After `restore_backup`, if a write reached such an index before any vector search did, the index started a new, empty graph: every vector restored from the backup disappeared from vector search, with no error. Now the restored index rebuilds from the restored records as soon as the database loads. While it rebuilds, vector searches on it return `503`.

An index damaged this way by an earlier version stays incomplete after the upgrade. To repair it, stop Harper, delete the index's file from the database directory (`<table>%2F<attribute>.hnsw`, or `<table>%2F<attribute>%40<generation>.hnsw` for a table that was dropped and recreated), and start Harper again: the index rebuilds on start. See [restoring a backup](/reference/v5/backups/overview).
