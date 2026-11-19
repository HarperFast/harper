---
section: 'Backups'
order: 40
---

### New restore_backup Options, and target_database Online

`accept_incompatible_backup` restores a backup taken by a newer Harper whose archive manifest major is higher than this version understands, logging what it waived. `accept_unverified_blobs` publishes a restore whose records reference blob files the backup lacks. `immutable_source` restores from a read-only repository without locking or pinning it. `target_database` now works with the server running, and `verify_backup` opens and reads every table, so it fails a backup whose tables this version cannot read, as a restore would. See [`restore_backup`](/reference/v5/backups/operations#restore_backup).
