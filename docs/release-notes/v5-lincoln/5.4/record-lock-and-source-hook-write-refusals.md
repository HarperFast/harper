---
section: 'Transactions'
order: 41
---

### Refusals for Source Hook Writes and Record Locks in a Closing Transaction

On RocksDB, writes a table source's write-through method makes to the record being written, and `table.lock()` calls in a `transaction()` that is closing for its own commit, now fail with `409` and a message saying what to do, instead of losing a write or failing with `500`:

- A source's `put`, `patch`, `delete` or `publish` that writes the record being written, before its first `await`, is refused with `409`. Before, the write resolved but the cached write overwrote it ([harper#4112](https://github.com/HarperFast/harper/issues/4112)). After an `await` the write follows the cached write, as before.
- When the cached write goes through a `lock()` holder, that source method can no longer change the holder before its first `await` (`409`). Before, a change it then tried to save was refused, yet stored by the cached write.
- Outside `transaction()`, `update()` through that holder from the source method is refused with `409`, because no commit would save it. Before, it stayed staged, and a later `lock()` of the record on the same context failed with `409` until the holder saved or unlocked.
- Inside `transaction()`, re-locking a record through the instance that holds its lock (or upgrading it to `{ hold: true }`), while a `commit()` of that transaction is still in flight, is refused with `409`; await the commit, then call `Table.lock()` again. Before, the call returned the lock that commit then released, so the next write through it failed and nothing excluded other callers ([harper#4081](https://github.com/HarperFast/harper/issues/4081)).
- A `lock()` in a `transaction()` after a mid-scope `commit()` made while a read iterator was open is refused with `409` for the rest of that transaction, even once the iterator is returned. A `lock()` from a source method of a write in another database, for a record in a database the commit has already committed, is refused with `409` during a mid-scope `commit()`, and before the method's first `await` during the transaction's final commit. Both used to fail with `500 Transaction was closed while waiting for a record lock`. A `lock()` waiting when its transaction finishes or aborts still fails with `500`.

Source methods should await or catch every write they make; an ignored refusal is an unhandled rejection.
