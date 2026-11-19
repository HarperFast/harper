---
section: 'Subscriptions'
---

### A Durable MQTT Session No Longer Skips a Message That Commits During Its Catch-Up

On RocksDB, a QoS 1 or 2 MQTT session that reconnects replays what it missed and then switches to live delivery. A transaction that committed while that replay ran, with a `localTime` at or below the session's saved position, was delivered by neither, and the session's position then moved past it. On a topic for a single record, the same happened to a message with a `localTime` below the record's latest write. Both are now delivered. On a single-record topic, a write the replay had already read is also no longer delivered a second time once the session is live. See [`subscribe()`](/reference/v5/resources/resource-api).
