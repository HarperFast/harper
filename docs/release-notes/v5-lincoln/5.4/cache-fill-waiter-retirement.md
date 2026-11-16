---
section: Resource API
---

### Cache-fill waiters during table removal

Requests waiting on a cache fill now report `loadedFromSource: false` when they receive the source's shared 404 or 410. If their table is removed from the schema while they wait, they receive the table's 404 error without reading its retired store or retrying the source. The admitted source request still completes, and failed fills stop issuing waiter warnings for the removed table.
