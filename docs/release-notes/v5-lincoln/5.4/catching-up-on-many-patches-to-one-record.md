---
section: 'Subscriptions'
---

### Catching up on many patches to one record

A durable MQTT session at QoS 1 or 2, and any subscription with `startTime` and `includeSuperseded`, now replays a long run of patches to a record in time proportional to its length. Catching up on 2,880 patches to one record takes about a tenth of a second instead of about 40 seconds. This applies to patches that set fields: a run that includes CRDT operations such as `add`, or a record larger than the replay keeps in memory, replays as before. See [#3032](https://github.com/HarperFast/harper/issues/3032).
