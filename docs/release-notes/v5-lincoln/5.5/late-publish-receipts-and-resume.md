---
section: Replication
---

### Late Publishes Preserve Receipts and Subscription Bounds

On RocksDB tables with `audit: false`, repeated late publishes no longer displace the receipts that prevent a redelivered CRDT increment from applying twice. Late messages published while auditing is off are not included in later history replay. Single-record subscriptions keep their requested `startTime` when replaying a late message. A pruned record head at or below that cursor no longer causes a resume failure when the referenced late message is still retained. Replay still refuses when it encounters missing history above the cursor.
