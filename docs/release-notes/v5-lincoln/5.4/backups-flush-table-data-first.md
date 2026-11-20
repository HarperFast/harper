---
section: 'Backups'
order: 60
---

### Backups Flush Table Data First

`create_backup` and `get_backup` now write each table's buffered changes to its data files before copying them. Before, a backup's data files held only what RocksDB had already flushed, and a restore rebuilt the rest from the transaction log. A record eviction cannot be rebuilt that way, so a backup taken soon after one kept the evicted record while its blob snapshot no longer had the record's blob. `restore_backup` then failed with status code 409, `references blob files the backup does not contain`, after it had replaced the database.

A backup taken by an earlier version is unchanged and can still fail this way; take a new backup after upgrading.

One case still fails the same way after upgrading: a database that Harper recovered by replaying its transaction log when it opened, for example at startup after a crash or after a `restore_backup`, and that has had no write since. Its backup's data files are current, but the backup records a replay position from before that recovery, so a restore replays the evicted record's write. `verify_backup` does not detect this. Write any record to a table in that database before taking the backup.

A backup of a database with much unflushed data takes longer by the time of that flush: about 0.7 seconds for 390 MiB in testing, with no change in write latency. A managed backup counts that unflushed data in the free space it requires. A record evicted while a backup is running can still be captured without its blob. See [how managed backups work](/reference/v5/backups/overview#how-managed-backups-work).
