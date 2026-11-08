---
section: 'Transactions'
order: 40
---

### Record Lock Fixes for Lapsed Leases, Deletes and Mid-Scope Commits

Four fixes to `table.lock()`:

- A hold lock whose lease ran out keeps refusing writes to its record from every instance on the same context, until that lock's `unlock()` or a new `lock()` of the record. Outside `transaction()`, the next write to any record in the database used to clear it, so a late write landed after another caller could have locked the record ([harper#4053](https://github.com/HarperFast/harper/issues/4053)). `unlock()` of a lapsed lock now also lets later writes to the record through inside `transaction()`; before, they kept failing with `409`.
- A `delete()` or `invalidate()` made through a transaction-scoped lock now commits when the lock is released early with `unlock()` or upgraded to `{ hold: true }`. It was discarded ([harper#3902](https://github.com/HarperFast/harper/issues/3902)).
- A second `lock()` of a record from the same context now joins the first one's wait when a commit happened while the first one waited. Before, it waited behind the first one's lock and failed with `423` ([harper#3913](https://github.com/HarperFast/harper/issues/3913)).
- A `lock()` whose wait ends while its own `transaction()` is running a mid-scope `commit()` now waits for that commit and then takes the lock. It used to fail with `500 Transaction was closed while waiting for a record lock`, or return a lock that the commit then released ([harper#4080](https://github.com/HarperFast/harper/issues/4080)). Such a `lock()` gives the record back while it waits, so another caller can take it first.
