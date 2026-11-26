---
section: Storage
---

### A Record Created Without an Id After a Hard Restart No Longer Replaces a Stored Record

A table's stored id range can end below records that were written under a newer range, when the process is killed without a clean shutdown. After the restart, each thread's first auto-assigned id could be one of those records. A resource with `static loadAsInstance = false` then replaced that record on a POST to its collection, or a `create()` without an id, and answered with success. The default resource answered `409 Record already exists` instead. An auto-assigned id is now checked when the id range is extended, and an id that is already stored is skipped. Records replaced before this fix are not restored.
