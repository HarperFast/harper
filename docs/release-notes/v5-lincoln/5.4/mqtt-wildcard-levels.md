---
section: 'Subscriptions'
---

### Mid-Level `+` Topics Are Delivered by Pattern

As of 5.4.2, an MQTT subscription to a table whose topic has a `+` followed by another level (`Sensor/plant/+/temp`, `Sensor/+/<device>`, `Sensor/plant/+/#`) is handed only the records it matches. Its cost grows with the number of topic shapes under the same prefix (which levels are `+`), no longer with the number of such subscriptions: at 10,000 sessions each on its own `Sensor/site/+/m<i>`, a published message costs about 30 µs of CPU instead of 3 ms. A resource that overrides `subscribe()` is delivered as before.

As of 5.4.2, a `+` that comes before a `#` needs a topic level of its own, as the MQTT specification requires: `Sensor/plant/+/+/#` delivers `Sensor/plant/a/b` and every record under it, but no longer `Sensor/plant/a`, which earlier versions deliver. A client that relied on that should subscribe to `Sensor/plant/+/#`, which matches both. A durable (QoS 1 or 2) session on such a filter, saved by an earlier version and resumed after the upgrade, can skip messages it had not yet acknowledged from a transaction that also held a record with too few levels. See [Topics and Wildcards](/reference/v5/mqtt/overview#topics-and-wildcards).
