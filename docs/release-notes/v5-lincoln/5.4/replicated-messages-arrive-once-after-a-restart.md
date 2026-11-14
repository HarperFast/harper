---
section: 'Replication'
---

### Replicated Messages Arrive Once After a Restart or Reconnect

After a node restarted, restarted its HTTP workers or reconnected replication, its subscribers could receive a burst of messages published on another node a second time. A resuming node asks its peer to re-send the part of the log just before what it had applied, so that a transaction committed late is not missed; record writes in that stretch were already dropped as duplicates, but published messages were applied and delivered again. On RocksDB, a replicated message the node's transaction log still holds is now skipped, and a message it never received is still delivered once; only a message at or below its topic's record version is looked up, so in-order messages cost nothing extra. Nothing needs to change in applications or configuration. A message is still applied again when it is re-sent after audit retention purged its entry, on a node configured without transaction-log abort markers, or when its topic's record was moved back by an earlier version before upgrading.
