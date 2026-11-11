# Received increment receipts

On tables with `audit: false`, `receivedIdentityRefs` records processed origin transactions by `(nodeId, log key)`, independently of record version. It proves processing, not that an increment is still numerically visible after another write. Losing that proof lets a re-delivered add fold again after the head advances: 13 becomes 16, or a replacement's 20 becomes 23 ([Keep increment receipts through invalidation and replacement on audit:false tables](https://github.com/HarperFast/harper/pull/4127)).

- Ordinary `_writeInvalidate` carries the staged-or-committed list into both `updateRecord` and `stagedEntry`. An incoming indexed projection keeps processed receipts like an overwriting plain patch.
- A replacement `_writeUpdate` keeps only its transaction's already-listed receipt. Older transactions' receipts reset. The committed fallback matters after an LMDB merge rewinds the version and the leading add deduplicates before the put re-applies.
- A flagged RocksDB copy snapshot resets receipts, including copied invalidations. A source refill with fresh content also resets them; a 304 revalidation preserves them with the cached body.
- A previously unseen older add still folds onto a newer head. Receipt carry does not change predecessor-skip semantics.

Receipts are encoded atomically with the row, excluded from audit entries, and subject to the existing encoder budget. `noAuditReceiptBoundaries.test.js` enforces the carry/reset boundaries through real source frames, storage commits and a native recommit.
