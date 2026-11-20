---
section: 'Subscriptions'
---

### Durable MQTT Sessions Receive Late Messages From Other Nodes

A message published on another cluster node keeps that node's timestamp, so it can replicate in after a durable session saved its position and still sort below that position. A client that reconnected to the same node never received it. A reconnect now also replays each other node's history from the last point that node could still publish at, for wildcard subscriptions with QoS 1 or 2 on RocksDB databases. This replay needs a checkpoint saved with the subscription that covers the publishing node, and history from that checkpoint that is still retained and that Harper can still vouch for. Without both, for example just after a node joins the cluster, that node's older messages can still be missed on reconnect even though the session is reported present. Messages the client already acknowledged are skipped, for up to 1,000 remembered acknowledgements per session; past that, or after Harper stops without saving the session, some acknowledged QoS 1 messages from other nodes can be delivered again. Subscriptions to a single record are unchanged. See [Durable Sessions](/reference/v5/mqtt/overview#durable-sessions) ([harper#3790](https://github.com/HarperFast/harper/issues/3790)).
