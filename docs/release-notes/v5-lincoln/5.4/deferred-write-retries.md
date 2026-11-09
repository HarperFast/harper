---
section: 'Resource API'
---

### Deferred Write Retries and Repeated Updates

A deferred update refused with `409` because an earlier write under the same record lock is still committing now stays pending. Await the earlier write, then call `save()` again: the retry persists the update without closing its instance prematurely or moving it behind later staged writes.

Repeated `update()` calls on one instance now merge into one pending write when no other write to that key intervenes. A full replacement followed by a patch keeps the replacement's fields and semantics. Saving the merged update leaves no orphaned operation blocking a later `lock()`.
