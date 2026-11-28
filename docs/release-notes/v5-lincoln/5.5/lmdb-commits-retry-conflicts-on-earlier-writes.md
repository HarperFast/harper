---
section: Storage
---

### LMDB Commits Retry a Conflict on an Earlier Write, and Audit Entries Are Not Overwritten

On LMDB, a transaction that writes several records now retries when another write changed an earlier record before the commit and the transaction's last write creates a new record. Before, that conflict went unnoticed: none of the transaction's writes were stored, and the request still succeeded.

LMDB also no longer lets the next audit entry overwrite a delete or table-reload entry that it was still writing. RocksDB is not affected by either.
