---
section: 'Backups'
order: 60
---

### Backups Flush Table Data First

`create_backup` and `get_backup` now write each table's buffered changes to its data files before copying them. Before, a backup's data files held only what RocksDB had already flushed, and a restore rebuilt the rest from the transaction log. A record eviction cannot be rebuilt that way, so a backup taken soon after one kept the evicted record while its blob snapshot no longer had the record's blob. `restore_backup` then failed with status code 409, `references blob files the backup does not contain`, after it had replaced the database.

A backup taken by an earlier version is unchanged and can still fail this way; take a new backup after upgrading. A backup of a database with much unflushed data takes longer by the time of that flush: about 0.7 seconds for 390 MiB in testing, with no change in write latency. A record evicted while a backup is running can still be captured without its blob. See [how managed backups work](/reference/v5/backups/overview#how-managed-backups-work).
