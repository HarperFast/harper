---
section: 'Backups'
order: 50
---

### Restoring a Component-Held Database at the Next Startup

A database that a loaded component keeps open could only be restored with Harper stopped. `restore_backup` with `on_restart: true` now records the restore and restarts Harper, which applies it at startup, before any component loads. By default the startup first takes a managed backup of the database it replaces and reports its id as `pre_restore_backup_id`, so the restore can be rolled back; `retain_previous: false` skips it. The job stays `IN_PROGRESS`, with `deferred_to: "restore-intent"`, until the startup finishes it. A startup that cannot apply the restore leaves the database unloaded and retries at the next restart, up to 3 attempts. `resume: true` runs a pending or stopped restart restore again, another `on_restart` request replaces it, and `cancel: true` withdraws it, also from the CLI with Harper stopped. While a restart restore that has stopped, or has begun taking its pre-restore backup or replacing the database, has not published, Harper starts without loading any component: it sets `HARPER_SAFE_MODE` to `restore-unpublished` for that boot, logs why in `hdb.log`, and restarts by itself once the restore is finished or withdrawn. See [restoring at the next startup](/reference/v5/backups/operations#restoring-at-the-next-startup) ([harper#3987](https://github.com/HarperFast/harper/pull/3987)).
