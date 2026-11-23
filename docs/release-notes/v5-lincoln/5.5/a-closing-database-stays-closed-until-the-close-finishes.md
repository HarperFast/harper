---
section: Storage
---

### A Database That Is Closing Stays Closed Until the Close Finishes

While Harper closes a database, for example to restore or drop it, schema changes on other threads no longer reread it, and a `table()` or `database()` call for it fails with a retryable `DatabaseClosingError` (status code 503, code `DATABASE_CLOSING`) until the close finishes. Retry the call once the close is done. Before, a schema change during the close could read an LMDB database after its storage was released and crash the worker, and a declaration could return a table whose storage the close then shut.
