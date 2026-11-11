---
section: 'Subscriptions'
---

### MQTT Fan-Out Costs Less

Delivering a message to many MQTT subscribers takes a fraction of the CPU it did: under half for exact topics and `+` wildcards, and a tenth or less for durable QoS 1/2 subscriptions. The MQTT sessions subscribed to a record share one event for each change to it rather than building one each, which cuts the CPU of a delivery by about a fifth under bursts and sustained writes. A burst of messages to one client is written to its socket in a few writes rather than one per message, on TCP connections and on WebSocket connections served by Node, and takes under a third of the CPU to deliver. A subscription holds about a third of the memory, durable session saves share transactions. Because saves are batched, two latencies can rise slightly, though the work as a whole finishes sooner: a PUBREL when one QoS 2 subscriber is sent messages as fast as possible (by about half a millisecond), and the slowest SUBACKs in a burst of thousands of durable subscribes (by a few milliseconds).
