---
section: 'Storage'
---

### Migration and Compaction Keep Audit Refs and Catalog Rows

`storage.migrateOnStart` no longer corrupts records of a table with `audit: false` that took increment patches ([`addTo`](/reference/v5/resources/resource-api), or a PATCH with `{"__op__": "add"}`) on LMDB. They read back after the move to RocksDB instead of failing with `Error decoding record` or returning a wrong value, and they keep the receipts that stop a re-delivered `add` from applying twice. A RocksDB record header can have room for fewer receipts than an LMDB one, so a record at the LMDB limit keeps its newest receipts, as RocksDB does for its own writes. A migration that cannot write a record now fails startup with the LMDB database left in place, instead of finishing without it.

`storage.compactOnStart` and `harper copy-db` now copy the residency mappings and the table-id counter in the database catalog. A migration copies them too, and starts replication bookkeeping fresh with its new transaction log, as it did before.

Neither repairs a database moved by an earlier release. After migrating a database, `migrateOnStart` moves its LMDB file to `<rootPath>/backup/<database>.mdb` (blob files are not part of it), or leaves it in place if that move fails.
