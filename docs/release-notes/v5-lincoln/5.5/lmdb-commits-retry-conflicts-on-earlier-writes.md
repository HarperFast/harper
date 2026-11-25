---
section: Storage
---

### LMDB Commits Retry a Conflict on an Earlier Write, and Audit Entries Are Not Overwritten

On LMDB, a transaction that updated a record and then created a new one now retries when another write changed the first record before the commit. Before, the conflict went unnoticed when the last write was a new record: none of the transaction's writes were stored, and the request still succeeded.

LMDB also no longer lets the next audit entry overwrite a delete or table-reload entry that it was still writing. RocksDB is not affected by either.
