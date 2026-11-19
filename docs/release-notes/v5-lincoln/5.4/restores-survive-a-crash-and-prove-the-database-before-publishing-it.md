---
section: 'Backups'
order: 20
---

### Restores Survive a Crash, and Prove the Database Before Publishing It

Every `restore_backup` now records its decision on disk before it changes anything, applies and checks the backup in a separate process, and publishes the restored database only after that process has proven it: the transaction log replays completely, every record decodes, and every file-backed blob a record references is present. A crash at any point leaves the database as it was, restored, or blocked until a rerun finishes it; previously a crash mid-copy could leave a mix of old and new files. Only one restore or verification runs at a time on an instance. See [if a restore is interrupted](/reference/v5/backups/operations#if-a-restore-is-interrupted) ([harper#3920](https://github.com/HarperFast/harper/pull/3920)).
