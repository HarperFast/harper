---
section: 'Storage'
---

### Migration and Compaction Keep Every Record and Catalog Row

`storage.migrateOnStart` no longer corrupts records of a table with `audit: false` that took increment patches ([`addTo`](/reference/v5/resources/resource-api), or a PATCH with `{"__op__": "add"}`) on LMDB. Those records keep the receipts that stop a re-delivered `add` from applying twice, and they read back after the move to RocksDB instead of failing with `Error decoding record` or returning a wrong value. A migration that cannot write a record now fails startup with the LMDB database left in place, instead of finishing without it.

`storage.compactOnStart` and `harper copy-db` now copy the residency mappings and the table-id counter in the database catalog. A migration copies them too, and starts replication bookkeeping fresh with its new transaction log, as it did before.

Neither fixes a database moved by an earlier release. `migrateOnStart` leaves the LMDB original under `<rootPath>/backup/<database>.mdb`; to redo an affected migration, stop Harper, restore that file to the database directory in place of the RocksDB database, and start with `migrateOnStart` again. Writes made since that migration are not in the backup.
