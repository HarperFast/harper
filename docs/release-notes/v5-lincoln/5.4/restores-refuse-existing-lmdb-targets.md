---
section: 'Backups'
---

### Restores Refuse Existing LMDB Targets

`restore_backup` now refuses an existing LMDB database with status code 409, including a database with no tables, instead of creating a RocksDB directory alongside its `.mdb` file. This applies to online, `on_restart`, and offline restores. See [restore_backup](/reference/v5/backups/operations#restore_backup).
