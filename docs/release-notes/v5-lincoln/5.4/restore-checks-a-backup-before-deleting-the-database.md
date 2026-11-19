---
section: 'Backups'
order: 10
---

### Restore Checks a Backup Before Deleting the Database

`restore_backup` no longer deletes a database before checking that the backup can be read. It first verifies the checksum of every database file in the backup, checks its transaction logs, opens each table file to confirm this version can read its format and compression, and, for a backup that captured blobs, checks that the blob snapshot is present. A backup that fails is refused and the database is left as it was (one an earlier restore left incomplete stays blocked); previously the restore deleted the database first and then failed, so a backup taken by a newer version, or one with a corrupt file, destroyed the database it was meant to restore. The check reads the whole backup once, so a restore takes longer, and an online restore keeps the database unavailable while it runs; it needs no extra disk space. A restore interrupted while it is still checking the backup leaves the destination's files and any preexisting incomplete-restore marker unchanged; a previously healthy database loads normally on the next start. Blob file contents are not checksummed; the restore later checks that every blob a record references is present (see below). See [`restore_backup`](/reference/v5/backups/operations#restore_backup).
