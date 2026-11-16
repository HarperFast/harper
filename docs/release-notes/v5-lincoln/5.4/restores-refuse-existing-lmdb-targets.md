---
section: 'Backups'
---

### Restores Refuse Existing LMDB Targets

`restore_backup` now refuses a target with an existing sibling LMDB `.mdb` file with status code 409, including a database with no tables, instead of creating a RocksDB directory alongside it. This applies to online, `on_restart`, and offline restores. See [restore_backup](/reference/v5/backups/operations#restore_backup).
