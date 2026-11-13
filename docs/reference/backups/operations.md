---
id: operations
title: Backup Operations
sidebar_position: 20
sidebar_label: 'Operations'
---

<!-- Source: HarperFast/harper#1831 (RocksDB managed backup and restore operations) -->

Operations for backing up and restoring databases. For how the backup system works, its limitations, and worked examples, see the [Backups Overview](./overview.md).

All backup operations require a `super_user` role when invoked through a running server; run offline (from the CLI with the server stopped), they are governed by filesystem permissions instead. All accept a `database` parameter that defaults to `data`. The engine badge on each operation indicates which storage engines support it: the managed-backup operations require RocksDB, while `get_backup` works with both RocksDB and LMDB.

| Operation                           | Description                                                         | Role Required |
| ----------------------------------- | ------------------------------------------------------------------- | ------------- |
| [`create_backup`](#create_backup)   | Creates a managed, incremental directory backup of a database (job) | super_user    |
| [`list_backups`](#list_backups)     | Lists the managed backups for a database                            | super_user    |
| [`verify_backup`](#verify_backup)   | Verifies a managed backup's integrity (job)                         | super_user    |
| [`delete_backup`](#delete_backup)   | Deletes a single managed backup                                     | super_user    |
| [`purge_backups`](#purge_backups)   | Deletes all but the newest `keep_count` managed backups             | super_user    |
| [`restore_backup`](#restore_backup) | Restores a database from a managed backup (job)                     | super_user    |
| [`get_backup`](#get_backup)         | Streams a full snapshot of a database in the response for download  | super_user    |

## Running backup operations from the CLI

Every operation on this page can be run from the CLI under its operation name, for example `harper create_backup database=data`. When Harper is running, the CLI forwards the operation to the server; when it is stopped, the command operates directly on the database and backup files. `get_backup` is the exception — it streams from a running server and has no offline form.

Like any [CLI operation](../cli/operations-api-commands.md), backup commands also accept a remote `target=<url>` to run against another instance instead of the local one (see [Remote Operations](../cli/overview.md#remote-operations)). With a remote target the operation is always forwarded — there is no offline path.

A target set with `HARPER_CLI_TARGET` or `CLI_TARGET` is always forwarded too, including one that `harper login` added to a `.env` file. `harper logout` does not remove a `.env` entry, so delete that line to run commands offline.

A target saved by `harper login` is also forwarded, with one exception. If the saved target is a loopback address (`localhost`, `127.x` or `::1`) and the local server is stopped:

- `create_backup`, `list_backups` and `verify_backup` run offline against this installation's files.
- `restore_backup`, `delete_backup` and `purge_backups` fail without changing anything, because a loopback address can belong to a different instance, such as an SSH tunnel, a container or another local install.

To run one of the failing commands on this installation's files, first run `harper logout <target>`, which also removes that saved login. To run it on the saved target, pass `target=<url>`.

Offline invocation matters most for restore: an in-place `restore_backup` of the `system` database must be run with the server stopped. A database a loaded component keeps open can be restored with the server stopped, or, as of v5.4.0, with the server running through [`on_restart`](#restoring-at-the-next-startup), which applies it at the next startup. See ["when can a database be restored"](./overview.md#when-can-a-database-be-restored).

## `create_backup`

<VersionBadge version="v5.2.0" /> <EngineBadge engines="RocksDB" />

Creates an incremental directory backup of the database under the configured backup root ([`storage.backupPath`](../configuration/options.md#storage), default `<rootPath>/backup`). Through a running server this runs as a background [job](../operations-api/operations.md#jobs): the operation returns a `job_id` immediately, and [`get_job`](../operations-api/operations.md#get_job) reports the outcome including the new `backup_id`, `size`, and `timestamp`.

Backups of the same database share unchanged RocksDB data files within the repository. Each backup also copies the transaction-log snapshot. Blob snapshots use hard links when the source and destination filesystem support them, and copy the files otherwise. Pass `exclude_blobs: true` to skip the blob snapshot. Measure physical repository growth to plan capacity, and use [`purge_backups`](#purge_backups) to manage retention.

```json
{ "operation": "create_backup", "database": "data" }
```

```bash
harper create_backup database=data
```

## `list_backups`

<VersionBadge version="v5.2.0" /> <EngineBadge engines="RocksDB" />

Returns the managed backups for a database, each with:

- `backup_id` — the monotonic integer identifier.
- `timestamp` — creation time in seconds since the epoch.
- `size` — bytes of the backup's RocksDB file payloads.
- `file_count` — number of RocksDB files (some are shared across backups).

`size` and `file_count` come from the RocksDB backup engine and exclude the transaction-log and blob snapshots, so they undercount the repository's true on-disk footprint. Returns an empty array if no backups have been created yet.

```json
{ "operation": "list_backups", "database": "data" }
```

```bash
harper list_backups database=data
```

## `verify_backup`

<VersionBadge version="v5.2.0" /> <EngineBadge engines="RocksDB" />

Verifies a managed backup. `backup_id` is required.

- **RocksDB files:** checks file sizes and, when `verify_checksum` is `true`, checksums. Checksum verification takes longer.
- **Tables:** <VersionBadge version="v5.4.0" /> opens each table file and reads every table, so a backup this version of Harper cannot read, such as one with a newer table format, fails verification as it would fail a restore.
- **Transaction log:** always checks the snapshot's framing.
- **Blob snapshot:** checks that a snapshot is present if the backup recorded blobs. A missing snapshot fails verification. Individual blob sizes, checksums, and readability are not checked, so damaged blob contents can pass verification.

Through a running server, verification runs as a background [job](../operations-api/operations.md#jobs). Poll `get_job` for its result. As of v5.4.0, verification runs in a separate process, and only one restore or verification runs at a time on an instance; another one fails with status code 409 until it finishes.

```json
{ "operation": "verify_backup", "database": "data", "backup_id": 1, "verify_checksum": true }
```

```bash
harper verify_backup database=data backup_id=1 verify_checksum=true
```

## `delete_backup`

<VersionBadge version="v5.2.0" /> <EngineBadge engines="RocksDB" />

Deletes a single managed backup. Files shared with other backups are reference-counted and removed only when no remaining backup references them. `backup_id` is required.

```json
{ "operation": "delete_backup", "database": "data", "backup_id": 1 }
```

```bash
harper delete_backup database=data backup_id=1
```

## `purge_backups`

<VersionBadge version="v5.2.0" /> <EngineBadge engines="RocksDB" />

Deletes all but the newest `keep_count` managed backups, returning the number `deleted` and the number `remaining`.

```json
{ "operation": "purge_backups", "database": "data", "keep_count": 3 }
```

```bash
harper purge_backups database=data keep_count=3
```

## `restore_backup`

<VersionBadge version="v5.2.0" /> <VersionBadge type="changed" version="v5.4.0" /> <EngineBadge engines="RocksDB" />

Restores a database in place from a managed backup. `backup_id` defaults to the latest backup. The audit/transaction log is restored alongside the data, and — for a database with file-backed blobs — the blob roots are purged and rewritten from the backup's blob snapshot.

Through a running server this runs as a background [job](../operations-api/operations.md#jobs): Harper closes the database across all worker threads, checks the backup, restores it, and reloads it. As of v5.4.0, the check and the restore run in a separate process, and only one restore or [verification](#verify_backup) runs at a time on an instance; another one fails with status code 409 until it finishes. This works only when no loaded component is holding the database open — if one does, the job ends in `ERROR` (surfaced by [`get_job`](../operations-api/operations.md#get_job)) telling you to pass `on_restart: true` or restore offline. As of v5.4.0, [`on_restart: true`](#restoring-at-the-next-startup) restores such a database at the next startup, before any component loads. Restoring the `system` database is rejected up front, before a job is created. It requires running the command from the CLI with the server stopped. See [when can a database be restored?](./overview.md#when-can-a-database-be-restored)

| Parameter                    | Description                                                                                                                                                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backup_id`                  | The backup to restore. Defaults to the latest.                                                                                                                                                                                                                                                                                        |
| `target_database`            | Restore into a separate, new database instead of overwriting the source. The target must not exist, or must be an empty directory. As of v5.4.0 this works with the server running too: the source stays online, and the new database loads on every thread when the restore publishes.                                               |
| `allow_engine_only`          | <VersionBadge version="v5.3.0" /> Default `false`. Permits restoring a backup created with `exclude_blobs: true`; without it that restore is refused, including with `target_database`. Enabling it accepts the risk that restored records reference missing or unrelated blob files; recover and validate those blobs separately.    |
| `accept_incompatible_backup` | <VersionBadge version="v5.4.0" /> Restore a backup taken by a newer version of Harper whose archive manifest major is higher than this version understands. What it waived is logged and returned as `compatibility_waived`. A capability this version lacks is still refused.                                                        |
| `accept_unverified_blobs`    | <VersionBadge version="v5.4.0" /> Publish the restore even if records reference blob files the backup does not contain. The result reports `blob_integrity: unverified`.                                                                                                                                                              |
| `immutable_source`           | <VersionBadge version="v5.4.0" /> Restore from a repository Harper cannot write to, such as a read-only mount, without locking or pinning it. Use it only if nothing can modify the repository until the restore finishes.                                                                                                            |
| `on_restart`                 | <VersionBadge version="v5.4.0" /> Default `false`. Record the restore and restart Harper, which applies it at startup before any component loads. For a database a loaded component keeps open. Cannot be combined with `target_database` or `immutable_source`. See [restoring at the next startup](#restoring-at-the-next-startup). |
| `retain_previous`            | <VersionBadge version="v5.4.0" /> Only with `on_restart`. Default `true`. Before replacing the database, the startup takes a managed backup of it as it is, so the restore can be rolled back. `false` replaces it without one.                                                                                                       |
| `resume`                     | <VersionBadge version="v5.4.0" /> Run a pending or stopped restart restore again, with the options it was requested with and its attempt count reset, and restart Harper. Takes only `database`.                                                                                                                                      |
| `cancel`                     | <VersionBadge version="v5.4.0" /> Withdraw a pending or stopped restart restore. Takes only `database`. Works with Harper stopped too.                                                                                                                                                                                                |

```json
{ "operation": "restore_backup", "database": "data", "backup_id": 1 }
```

```bash
harper restore_backup database=data backup_id=1
# restore into a new database instead of overwriting the source
harper restore_backup database=data backup_id=1 target_database=data_restored
```

As of v5.3.1, subscriptions opened before a restore do not carry over to the restored data. When Harper reloads the database, each one ends, and its last message is a `DatabaseGenerationChangedError` (status code 409, code `DATABASE_GENERATION_CHANGED`). Resubscribe to resynchronize against the restored state. A restore that fails before it changes anything reloads the database as it was; those subscriptions end instead with a retryable `DatabaseClosingError` (status code 503, code `DATABASE_CLOSING`); resubscribe to continue.

### What a restore checks

As of v5.4.0, a restore checks the backup before it deletes anything. It verifies the checksum of every database file in the backup (not blob files), checks the backup's transaction logs, and opens each of its table files to confirm this version of Harper can read their format and compression. For a backup that captured blobs, it also checks that the blob snapshot is present. A backup that fails any of these is refused: the restore fails with an error saying it did not modify the database, followed by the cause, and the database keeps its data and its blobs. A rerun over an earlier restore that did not finish is the exception: that database is already incomplete, so it stays blocked until a restore succeeds, and the error says so.

The pre-copy check reads the whole backup once before the restore copies it, so a restore takes longer than before but needs no extra disk space. Through a running server, the check runs after the database is closed, so the database is unavailable while the backup is checked as well as while it is copied. Writes during that time fail, as they do for the rest of the restore, rather than succeeding and then being lost.

After the files are replaced, and before the restored database is published, the restore also proves it. The transaction log replays completely, with no skipped entry, torn transaction or corrupt frame. Every record decodes. Every file-backed blob a record references is present and the size the record declares, or is a capture marker the backup recorded for a blob that was still being written; the result reports `blob_integrity: unverified` when any marker was accepted. A reference to a blob the backup does not contain fails the proof unless `accept_unverified_blobs` is set. A restore that fails this proof is not published: the database stays blocked until a restore from a sound backup succeeds.

<details>
<summary>Before v5.4.0</summary>

Previously the restore deleted the database first, so a backup this version could not read, such as one taken by a newer version of Harper, destroyed the database it was meant to restore. Blob files were not checked at all, and `target_database` was refused while the server was running.

</details>

### If a restore is interrupted

As of v5.4.0, every restore records its decision on disk before it changes anything, does the work in a separate process, and publishes the restored database only after that process has proven it. A crash at any point leaves one of three states:

- **The database as it was**, if the restore stopped before it replaced anything. The next start discards the unfinished restore and loads the database normally.
- **The restored database**, if the restore was proven before the crash. The next start, or the next `restore_backup` of that database, finishes publishing it without repeating the work.
- **A blocked database**, if the restore stopped while replacing files. Harper refuses to load it and logs an incomplete-restore error. Recover by rerunning `restore_backup` for the same database and backup; do not try to load or hand-repair the directory. A backup the interrupted restore was using stays protected from `delete_backup` and `purge_backups` until a restore succeeds, unless the restore used `immutable_source`, which pins nothing.

### Replication peers

As of v5.4.0, a restore refuses to run on a node that has replication peers, whether from `system.hdb_nodes` or `replication.routes`, because replication would either undo the restore or spread it to the cluster. Through a running server the job ends in `ERROR`, with a message naming the peers; offline the command fails with the same message. Peers count even when replication to them is blocked by the network. Restore on a standalone node, then add fresh peers. While a restore runs, operations that add a peer, such as `add_node` or a `set_configuration` that sets replication routes, fail with status code 409. An offline restore of the `system` database checks only `replication.routes`, since it replaces the node list itself.

### Restoring at the next startup

<VersionBadge version="v5.4.0" />

Harper cannot close a database that a loaded component keeps open, so an ordinary restore of it fails while the server runs. With `on_restart: true`, the restore is recorded and Harper restarts, and the startup applies it before any component loads:

```json
{ "operation": "restore_backup", "database": "data", "backup_id": 3, "on_restart": true }
```

```bash
harper restore_backup database=data backup_id=3 on_restart=true
```

The request selects the backup and checks that it is complete, records the restore, and then restarts Harper, which shuts down as it does on SIGTERM (bounded by [`threads.shutdownTimeout`](../configuration/options.md#shutting-down-on-a-termination-signal)). Until the restart, threads that already have the database open keep serving it. The startup checks, applies and proves the backup as every restore does ([what a restore checks](#what-a-restore-checks)), then loads the database and the components. From the restart until the restore publishes, the database is not loaded, and operations such as `drop_database`, `create_backup` and `get_backup` on it fail with status code 409 naming the restore.

`on_restart` works for any user database, and restarts Harper even when nothing holds the database open, so use an ordinary restore for a database no component opens. It cannot be combined with `target_database`, since a new database is never held by a component and restores online, or with `immutable_source`, since a restart restore keeps its source protected from deletion until it publishes. The `system` database still needs the offline CLI. If another restore, a drop, or a database open holds the database when the request is recorded, the job ends in `ERROR` without restarting Harper; retry once that finishes.

#### The job

`get_job` reports the job as `IN_PROGRESS` with `deferred_to: "restore-intent"` from the moment the restore is recorded until a startup settles it, across the restart; its `result` names the `database`, `backup_id` and the restore's `operation_id`. Once the restore publishes, the job is `COMPLETE` and its `result` is that of an ordinary restore, plus `pre_restore_backup_id` when a pre-restore backup was taken, or `retain_previous: false`. The job ends in `ERROR` when the restore stops after its last attempt, is cancelled, or is replaced by another request. An attempt that fails but will be retried does not change the job; `hdb.log` records it at error level as `Attempt <n> of 3 to restore '<database>' failed (<reason>)`.

If the job's record cannot be updated to show the deferral, the job fails and the restore is withdrawn, so it does not run at some later, unrelated restart. If Harper cannot withdraw it within about 10 seconds, it logs an error naming `restore_backup cancel=true`; run that before the next restart.

#### The pre-restore backup

Unless `retain_previous` is `false`, the startup first takes a managed backup of the database as it is, blob files included, and then replaces it. The result reports its id as `pre_restore_backup_id`. It is protected from `delete_backup` and `purge_backups` until the restore publishes, and is then an ordinary managed backup: restore it to roll back.

- **Space.** When the backup root lacks room for it, the request's job ends in `ERROR` without restarting Harper; free space, or pass `retain_previous: false`.
- **A database that cannot be backed up.** A backup refused because another restore or backup holds what it needs counts as a failed attempt and is retried at the next restart. Any other failure to take the backup, such as a live database that cannot be read, stops the restore at once, without retrying, and its error suggests requesting it again with `retain_previous: false`. A backup that completed before its process failed is kept and used, and the restore carries on. A completed backup that is deleted before Harper protects it, or that Harper then fails to protect, counts as a failed attempt instead: the job stays `IN_PROGRESS` and the restore is retried at the next restart.
- **No backup is taken** when the database does not exist yet or an earlier restore left it incomplete. A request that replaces a pending restore keeps the pre-restore backup that one already took instead of taking another.

#### Failed attempts

A startup that cannot apply the restore records the error, leaves the database unloaded, and tries again at the next restart, up to 3 attempts. After the third, or at once if the node has [replication peers](#replication-peers), the restore stops and its job ends in `ERROR`. The database stays unloaded until one of these finishes or withdraws it:

- `resume: true` runs it again with the options it was requested with and its attempt count reset, and restarts Harper. Its job continues the restore, and the earlier job, if it had not already failed, ends in `ERROR`.
- Another request with `on_restart: true` replaces the pending restore, with the same or another `backup_id`. This is also how to change an option. The replaced restore's job ends in `ERROR`.
- An ordinary restore (without `on_restart`) can replace a restore that has stopped. While a restart restore is still pending, an ordinary restore's job ends in `ERROR` naming `resume=true`, `cancel=true` and another `backup_id` with `on_restart=true`; offline, the command fails telling you to withdraw it with `cancel=true` first.
- `cancel: true` withdraws it ([cancelling](#cancelling-a-restart-restore)).

`resume` and `cancel` take only `database`. Each refuses `backup_id`, `on_restart`, `retain_previous`, `target_database`, `immutable_source`, `allow_engine_only`, `accept_incompatible_backup` and `accept_unverified_blobs` with status code 400. They are checked when submitted, before a job is created: `resume` fails with status code 404 when there is no restart restore to resume, and `cancel` with 404 when there is no restore to cancel and 409 when the restore has already been applied and is being finished.

#### Cancelling a restart restore

`cancel: true` withdraws the pending or stopped restore. A job still waiting on it ends in `ERROR` with the message `Cancelled`. Unless the restore had begun replacing the database, its backup is no longer protected from deletion:

```json
{ "operation": "restore_backup", "database": "data", "cancel": true }
```

| Result field    | Description                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `database`      | The database.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `cancelled`     | The id of the withdrawn restore, or `unreadable restore record`.                                                                                                                                                                                                                                                                                                                                                                 |
| `still_blocked` | `true` when the restore had already begun replacing the database. The database stays unloaded until a restore of it succeeds.                                                                                                                                                                                                                                                                                                    |
| `restarting`    | `true` when Harper restarts to load the database and the components that use it, because this boot started without it or in restore safe mode. `false` when the restore was requested after this boot started, since the database is still loaded, and when `still_blocked` is `true`. Also `false` while another restore would start Harper without components: `message` names it, and the database loads at the next restart. |
| `message`       | What happened, in words.                                                                                                                                                                                                                                                                                                                                                                                                         |

If the restore's record was removed but the disk could not confirm the removal durable, `message`, here and from the CLI below, ends by saying so: a power loss soon after can bring the restore back, and if it does, cancel it again with `restore_backup cancel=true`.

When `still_blocked` is `true`, recover with an ordinary restore or an `on_restart` restore of the database, or with `resume: true`. If the restore's record could not be read, `resume` fails with status code 404, but the other two still recover it.

Starting Harper would run a pending restore, so to withdraw one while Harper is stopped, run the same command from the CLI:

```bash
harper restore_backup database=data cancel=true
```

This changes only the files: it restarts nothing, always reports `restarting: false`, and the restore's job is marked failed when Harper next starts. With Harper stopped, the CLI refuses `on_restart=true`, `resume=true` and `retain_previous=true`, which need the server running; passing them as `false` is the same as omitting them.

#### An unreadable restore record

If a restore's record on disk cannot be read, its database stays unloaded, and a restore of that database fails, telling you to remove the record with `restore_backup cancel=true`. Offline, the error names the file instead.

#### Restore safe mode

A component that opens the database itself would see a database that is only partly replaced, or write to one that is about to be replaced after its pre-restore backup was taken. So Harper starts without loading any component, in restore safe mode, while any of these is true of a restart restore, or of a restore that replaced one:

- it has stopped after its last attempt,
- it has begun replacing its database and has not published, or
- it has taken, or begun taking, its pre-restore backup and has not published.

The same applies while any restore record cannot be read. For that boot Harper sets [`HARPER_SAFE_MODE`](../configuration/overview.md#harper_safe_mode) to `restore-unpublished` and logs at error level in `hdb.log` (with the record's path in place of the database name when it cannot be read):

```
A restore (<database>) has not published, so this boot starts in safe mode and loads no component. Finish it with restore_backup for that database: resume=true or another backup_id with on_restart=true, or, once it has stopped retrying, an ordinary restore; Harper restarts by itself once no restore keeps components off. cancel=true withdraws a restore that had not begun replacing the database.
```

The operations API keeps running, so finish or withdraw the restore as [above](#failed-attempts). Once no restore keeps components off, Harper restarts by itself and loads them. An ordinary restore that does so reports `restarting: true` in its result. If you start Harper with `HARPER_SAFE_MODE` already set, Harper keeps your value, across its own restarts too, and does not log this message.

An incomplete restore that is not a restart restore, including one an earlier version of Harper left, blocks only its own database ([if a restore is interrupted](#if-a-restore-is-interrupted)).

## `get_backup`

<EngineBadge engines="RocksDB, LMDB" />

Streams a full snapshot of the specified database in the HTTP response for download — there is no server-side artifact and nothing to clean up. The server must be running; this is the one backup operation with no offline form. Behavior depends on the storage engine:

- **RocksDB** <VersionBadge type="changed" version="v5.2.0" /> — streams a `tar` archive of the current database state — all tables, the transaction log, and any file-backed blobs — gzipped by default (`gzip` is a RocksDB-only option and compresses the snapshot substantially). Pass `"gzip": false` for a plain `tar`, or `"exclude_blobs": true` to leave blobs out. The snapshot is always the current state; downloading a specific historical `backup_id` is not supported — to move a retained managed backup off-host, copy its whole per-database backup repository (see [Limitations](./overview.md#limitations)). Restoring a RocksDB snapshot by hand takes an extra step when the database has blobs — see [download a snapshot and restore it manually](./overview.md#example-download-a-snapshot-and-restore-it-manually).
- **LMDB** — streams the `.mdb` file, without external blob files. Specify `"table"` for a single table or `"tables"` for a set; a table-filtered download includes the audit store only with `"include_audit": true`. These options are LMDB-only. For databases with file-backed blobs, use a coordinated filesystem or volume backup of the database and all blob roots with Harper stopped; see [LMDB recovery](./overview.md#lmdb-).

```json
{ "operation": "get_backup", "database": "data" }
```

From the CLI, pass `out=<path>` to choose the output file (defaults to a name derived from the response):

```bash
harper get_backup database=data out=./data.tar.gz
harper get_backup database=data target=https://node-2.example.com:9925 out=./data.tar.gz
```
