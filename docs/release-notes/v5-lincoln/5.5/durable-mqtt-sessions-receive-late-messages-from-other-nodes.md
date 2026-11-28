---
section: 'Subscriptions'
---

### Durable MQTT Sessions Receive Late Messages From Other Nodes

A message published on another cluster node keeps that node's timestamp, so it can replicate in after a durable session saved its position and still sort below that position. A client that reconnected to the same node never received it. A session now also saves how far it has read each node's history, and a reconnect reads each history on from there in the order it arrived, for wildcard subscriptions with QoS 1 or 2 on RocksDB databases. This works from a subscription's first save, with no checkpoint. A late message that was delivered but not acknowledged before the disconnect is sent again. Messages the client already acknowledged are skipped, for up to 1,000 remembered acknowledgements per session; past that, or after Harper stops without saving the session, some acknowledged QoS 1 messages can be delivered again. A client that reconnects to a different node resumes from the session's checkpoint as before, and can still miss such messages there. Subscriptions to a single record are unchanged. See [Durable Sessions](/reference/v5/mqtt/overview#durable-sessions) ([harper#3790](https://github.com/HarperFast/harper/issues/3790)).
