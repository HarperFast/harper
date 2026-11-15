---
section: 'Storage'
---

### Changing a Plain Index to HNSW While Harper Runs

Changing an attribute from a plain `@indexed` index to an HNSW index on a running server now takes effect on every thread, including threads that do not declare the table and only reload its schema. Those threads used to keep writing plain index entries, which the HNSW index could not see. Until the Harper process restarts, the new HNSW index reads without its in-memory record cache, and Harper logs a warning naming the index; a restart restores the cache. See [Vector Indexing](/reference/v5/database/schema#vector-indexing).
