---
section: 'Security'
---

### On LMDB, a Replicated Role Change Applies to the Next Request

On an LMDB node, a replicated role or user change could keep authorizing requests with the old permissions when it was stored under a version the node had already seen: a write from another node at the same timestamp that won the tie, or an older write that arrived out of order, possibly followed by a newer write landing back on an earlier version. The next request now uses the changed record, as it already did on RocksDB. No configuration is needed ([harper#4514](https://github.com/HarperFast/harper/pull/4514)).
