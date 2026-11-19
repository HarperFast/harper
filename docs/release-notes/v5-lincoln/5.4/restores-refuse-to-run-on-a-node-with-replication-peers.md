---
section: 'Backups'
order: 30
---

### Restores Refuse to Run on a Node With Replication Peers

`restore_backup` now fails on a node that lists replication peers in `system.hdb_nodes` or `replication.routes`, since replication would undo the restore or spread it to the cluster. Remove the node's peers before restoring and add fresh ones afterwards. While a restore runs, operations that add a peer fail with status code 409. See [restoring in a replicated cluster](/learn/administration/backup-and-recovery#restoring-in-a-replicated-cluster).
