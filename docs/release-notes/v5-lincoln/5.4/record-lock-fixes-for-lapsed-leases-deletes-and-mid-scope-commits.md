---
section: 'Transactions'
order: 40
---

### Record Lock Fixes for Lapsed Leases, Deletes and Mid-Scope Commits

Five fixes to `table.lock()` and immediate writes outside `transaction()`:

- A hold lock whose lease ran out keeps refusing writes to its record from every instance on the same context, until that lock's `unlock()` or a new `lock()` of the record. Outside `transaction()`, the next write to any record in the database used to clear it, so a late write landed after another caller could have locked the record ([harper#4053](https://github.com/HarperFast/harper/issues/4053)). `unlock()` of a lapsed lock now also lets later writes to the record through inside `transaction()`; before, they kept failing with `409`.
- A `delete()` or `invalidate()` made through a transaction-scoped lock now commits when the lock is released early with `unlock()` or upgraded to `{ hold: true }`. It was discarded ([harper#3902](https://github.com/HarperFast/harper/issues/3902)).
- Outside `transaction()`, `publish()`, `invalidate()`, and `delete()` now wait for their native commit to settle before resolving, and reject if that commit fails. A write a table source's hook makes during that commit, on the same context and database, resolves once it is part of the commit instead, since the commit is waiting for the hook. Before, they resolved while the commit was still in flight, so a following `save()` or `put()` under a `{ hold: true }` lock on an `audit: false` table could be silently dropped. An instance `delete(query)` outside `transaction()` resolves once every row's commit has settled. It commits up to 16 rows at a time; after a row fails it issues no more rows, but the rows already issued still commit before it rejects. When writes under one `{ hold: true }` lock overlap without being awaited, the last one issued now wins, even if the commits finish out of order. Before, on an `audit: false` table a later write could be silently dropped ([harper#4098](https://github.com/HarperFast/harper/issues/4098)).
- A second `lock()` of a record from the same context now joins the first one's wait when a commit happened while the first one waited. Before, it waited behind the first one's lock and failed with `423` ([harper#3913](https://github.com/HarperFast/harper/issues/3913)).
- A `lock()` whose wait ends while its own `transaction()` is running a mid-scope `commit()` now waits for that commit and then takes the lock. It used to fail with `500 Transaction was closed while waiting for a record lock`, or return a lock that the commit then released ([harper#4080](https://github.com/HarperFast/harper/issues/4080)). Such a `lock()` gives the record back while it waits, so another caller can take it first.
