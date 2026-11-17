---
section: 'Backups'
---

### Restoring a `get_backup` Archive

`restore_backup` now restores a `get_backup` archive: `harper restore_backup database=data file=./data.tar.gz`, against a running server (remote ones included), at the next startup with `on_restart=true`, or with Harper stopped. The archive is extracted as it is uploaded, beside the database directory and each blob root, proven while the database keeps serving, and then installed by renaming, so its bytes are written once and the database is closed only for the swap. Archives made with `exclude_blobs` are refused, as are archives with more blob roots than the instance. An interrupted archive restore is finished with `resume=true`. `registration_info` now lists the server's `capabilities`, and the CLI uploads only to a server that lists `restore_backup_archive`: an older server would restore its latest managed backup instead. See [restoring a `get_backup` archive](/reference/v5/backups/operations#restoring-a-get_backup-archive) ([harper#2639](https://github.com/HarperFast/harper/issues/2639)).
