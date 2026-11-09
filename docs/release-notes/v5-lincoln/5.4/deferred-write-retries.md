---
section: 'Resource API'
---

### Deferred Write Retries and Repeated Updates

A deferred `save()` that commits outside an open `transaction()` scope now stays pending if it is refused with `409` because an earlier write under the same record lock is still committing. Await the earlier write, then call `save()` again: the retry persists the update without closing its instance prematurely or moving it behind later staged writes.

Repeated `update()` calls on one instance now merge into one pending write at its original transaction position, like `set()`. Later writes from other instances retain their order and override overlapping fields. For example, `A.update({ n: 1 }); B.update({ n: 5 }); A.update({ n: 2 });` in one transaction commits `n: 5`. A full replacement followed by a patch keeps the replacement's fields and semantics. Saving the merged update leaves no orphaned operation blocking a later `lock()`.
