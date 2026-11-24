---
section: Replication
---

### Replica Deadlines Stay With Their Records

Each local replica now stores its renewable deadline alongside its own record expiry. Cleanup demotes a replica without a deadline on its first sweep after upgrade. Under [storage pressure](/reference/v5/database/storage-tuning#local-replicas-under-storage-pressure), eligible replicas give way in primary-key order. Before downgrading a node, [drain its replicas](/reference/v5/database/schema#replicaexpiration-and-replicarefreshfraction).

On eligible indexed tables, [`describe_table`](/reference/v5/operations-api/operations#replicas) now counts the primary rows flagged as replicas. The default count comes from the last complete cleanup pass and is omitted until that first pass. Set `exact_count` for a current count, which scans all primary rows, or `skip_record_count` to omit counts. The former `estimated_replica_range` field is retired.
