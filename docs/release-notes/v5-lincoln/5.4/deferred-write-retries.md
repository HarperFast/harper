---
section: 'Resource API'
---

### Deferred Write Retries and Repeated Updates

A deferred `save()` that commits outside an open `transaction()` scope now stays pending if it is refused with `409` because an earlier write under the same record lock is still committing. Await the earlier write, then call `save()` again: the retry persists the update without closing its instance prematurely or moving it behind later staged writes.

Repeated `update()` calls on one instance now merge into one pending write at its original transaction position, like `set()`. Later writes from other instances retain their order and override overlapping fields. For example, `A.update({ n: 1 }); B.update({ n: 5 }); A.update({ n: 2 });` in one transaction commits `n: 5`. A full replacement followed by a patch keeps the replacement's fields and semantics. Patches over a pending replacement still reject invalid operations with `400`. Saving the merged update leaves no orphaned operation blocking a later `lock()`.

Await an asynchronous `update()` before committing or checkpointing its transaction. If the transaction seals that update while its model hooks are still running, the update rejects with `409`; call `update()` again to start a fresh generation.

If initial write preparation fails, `save()` repeats that error until an explicit `update()` succeeds. This also applies to a held lock after correcting its fields with `set()`: call `update()` to prepare the corrected draft before saving. Retrying a prepared write after the lock-overlap `409` above still requires only `save()`.

After the first preparation failure, that update's changes remain in the draft and merge into the next `update()`, including the keyed form `update(id, changes)`. A later correction that also fails restores the preceding draft; fields supplied only by that rejected correction are discarded. Use a full replacement or a fresh instance to discard the retained draft.

Array PUT elements remain eager writes: a refused element is discarded because no instance owns its retry. Failed authorization or replacement preparation also leaves later setters saveable. Queued conditional updates may be discarded safely when `save()` reports the precondition failure.
