---
section: 'Storage'
---

### Local Replicas Give Way Under Storage Pressure

A node that keeps [local replicas](/reference/v5/database/schema#replicaexpiration-and-replicarefreshfraction) of records owned by other nodes now demotes them back to stubs when free space falls below `storage.reclamation.threshold`, oldest deadline first, shortening their lifetime as pressure rises. Records the node owns are not touched, and the next read fetches a demoted record again. Space returns when RocksDB compaction rewrites the old rows, not at the moment of demotion; see [Local replicas under storage pressure](/reference/v5/database/storage-tuning#local-replicas-under-storage-pressure). `describe_table` and `describe_all` now report [`replica_count` and `replica_size_estimate`](/reference/v5/operations-api/operations#replicas) per table.
