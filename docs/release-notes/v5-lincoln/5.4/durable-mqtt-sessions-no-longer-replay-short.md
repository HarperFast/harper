---
section: 'Subscriptions'
order: 20
---

### Durable MQTT Sessions No Longer Replay Short

A durable MQTT session now resumes through the same checked replay. When a reconnect's saved position names history that audit retention has removed, Harper deletes the session and reports `sessionPresent: false` (or, if the problem appears after `CONNACK`, sends an MQTT v5 `DISCONNECT` with reason code `0x83` and closes the connection) instead of delivering a partial catch-up. A position saved before a restore or copy, or on another cluster node, resumes best-effort, as before. A quiet topic's position is kept current, so retention on other tables does not reset it, and positions no longer skip unacknowledged messages that share a transaction. Resubscribing to a topic the session already holds continues from its saved position, and QoS 0 subscriptions are kept with the session and resume live. Each connection's Last Will is kept separately, so a connection that is taken over publishes its own will, never the newer connection's. See [Durable Sessions](/reference/v5/mqtt/overview#durable-sessions).
