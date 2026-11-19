---
section: 'Subscriptions'
---

### MQTT QoS 2 and Last Wills

MQTT QoS 2 exchanges now deduplicate deliveries, inbound and outbound. A retransmitted QoS 2 `PUBLISH` is published once per packet id, and an outbound delivery's `PUBREL` is sent only after its `PUBREC` is saved, so a subscriber that reconnects between `PUBREC` and `PUBCOMP` no longer gets the message again under a new packet id. This is not an unconditional exactly-once guarantee: a session keeps at most 1,000 delivery receipts, and past that a replay after reconnect resends deliveries whose receipts were not kept. On a durable session each of these steps waits for a session save, a few percent slower than QoS 1 in-process ([harper#3263](https://github.com/HarperFast/harper/pull/3263)).

A last will is now published for clients that are not super users, authorized like the client's other publishes against the will's topic. Before, only super users' wills were published; for anyone else the will was dropped, its stored row leaked, and each disconnect logged `Error publishing MQTT will`. See [QoS Levels](/reference/v5/mqtt/overview#qos-levels) and [Last Will](/reference/v5/mqtt/overview#last-will) ([harper#3302](https://github.com/HarperFast/harper/pull/3302)).
