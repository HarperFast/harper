---
section: 'Replication'
---

### A Late Message No Longer Moves Its Record Back

A published message older than its record — one replicated late, or published on a node whose clock is behind a peer's — set the record's version to its own. A later write that should have lost to the record's newer version could then win on that node, so nodes could hold different values for the same record. The record now keeps its newer version, and the message is still logged and delivered. On RocksDB, a subscription that replays a topic's history (`startTime`, `previousCount`, or a resuming MQTT session) and the record's history include the late message. A record that an earlier version already moved back keeps that version until its next newer write.
