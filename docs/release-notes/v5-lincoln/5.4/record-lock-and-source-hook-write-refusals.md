---
section: 'Transactions'
order: 41
---

### Refusals for Source Hook Writes and Record Locks in a Closing Transaction

On RocksDB, writes a table source's write-through method makes to the record being written, and `table.lock()` calls in a `transaction()` that is closing for its own commit, now fail with `409` and a message saying what to do, instead of losing a write or failing with `500`:

- A source's `put`, `patch`, `delete` or `publish` that writes the record being written, before its first `await`, is refused with `409`. Before, the write resolved but the cached write overwrote it ([harper#4112](https://github.com/HarperFast/harper/issues/4112)). After an `await` the write follows the cached write, as before.
- When the cached write goes through a `lock()` holder, that source method can no longer change the holder before its first `await` (`409`). Before, a change it then tried to save was refused, yet stored by the cached write.
- Outside `transaction()`, `update()` through that holder from the source method is refused with `409`, because no commit would save it. Before, it stayed staged, and a later `lock()` of the record on the same context failed with `409` until the holder saved or unlocked.
- Inside `transaction()`, while a `commit()` of that transaction is still in flight, re-locking a transaction-scoped lock through the instance that holds it, or upgrading that lock to `{ hold: true }` through any instance (a source method of that commit included), is refused with `409`; await the commit, then call `Table.lock()` again. A `{ hold: true }` lock stays re-entrant. Before, the call returned the lock that commit then released, so the next write through it failed and nothing excluded other callers ([harper#4081](https://github.com/HarperFast/harper/issues/4081)).
- A `lock()` in a `transaction()` after a mid-scope `commit()` made while a read iterator was open is refused with `409`, even once the iterator is returned, until a later `commit()` reopens the transaction. A `lock()` from a source method of a write in another database, for a record in a database the commit has already committed, is refused with `409`. Both used to fail with `500 Transaction was closed while waiting for a record lock`. After its first `await` during the transaction's final commit, a source method's `lock()` of any record through the context it is given is refused with `409` too: that commit has released the context, so the lock used to be taken outside the transaction and held until its lease ran out ([harper#4122](https://github.com/HarperFast/harper/issues/4122)). A `lock()` waiting when its transaction finishes or aborts still fails with `500`.

Source methods should await or catch every write they make; an ignored refusal is an unhandled rejection.
