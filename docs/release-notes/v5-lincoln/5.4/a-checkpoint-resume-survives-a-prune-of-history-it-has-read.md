---
section: 'Subscriptions'
---

### A Checkpoint Resume Survives a Prune of History It Has Already Read

On RocksDB, a subscription that resumes from a checkpoint, such as a reconnecting QoS 1 or 2 MQTT session, replays the history after it. If audit retention moved past the checkpoint while that replay ran, the resume failed with a 410 (`RESUME_HISTORY_UNAVAILABLE`) and the session started over, even when retention removed only history the replay had already delivered. The resume now fails only when this node's own log may have lost history the replay had not yet read. A peer's log is still held to the checkpoint's position. See [`subscribe()`](/reference/v5/resources/resource-api).
