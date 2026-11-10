---
section: 'Subscriptions'
---

### A `+` Before a `#` Needs a Topic Level

A `+` that comes before a `#` in an MQTT topic filter now needs a topic level of its own: `plant/+/+/#` delivers `plant/a/b` and every record under it, but no longer `plant/a`, which earlier versions delivered. See [Topics and Wildcards](/reference/v5/mqtt/overview#topics-and-wildcards).
