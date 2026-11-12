---
section: 'Subscriptions'
---

### Catching up on many patches to one record

A durable MQTT session at QoS 1 or 2, and any subscription with `startTime` and `includeSuperseded`, now replays a long run of patches to a record in time proportional to its length. Catching up on 2,880 patches to one record takes about a tenth of a second instead of about 40 seconds. This applies to patches that set fields, on up to about 256 records in progress at once (128 KiB of record images per subscription). These replay as before: a run that includes CRDT operations such as `add`, a record larger than that budget, the records past it, and a single-record replay with `previousCount`, `rowFilter` or `eventFilter`. See [#3032](https://github.com/HarperFast/harper/issues/3032).
