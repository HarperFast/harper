---
id: operations
title: Backup Operations
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

Offline invocation matters most for restore: an in-place `restore_backup` of the `system` database, or of any database a loaded component keeps open, must be run with the server stopped. See ["when can a database be restored"](./overview.md#when-can-a-database-be-restored).

## `create_backup`

<VersionBadge version="v5.2.0" /> <EngineBadge engines="RocksDB" />

Creates an incremental directory backup of the database under the configured backup root ([`storage.backupPath`](../configuration/options.md#storage), default `<rootPath>/backup`). Through a running server this runs as a background [job](../operations-api/operations.md#jobs): the operation returns a `job_id` immediately, and [`get_job`](../operations-api/operations.md#get_job) reports the outcome including the new `backup_id`, `size`, and `timestamp`.

Backups of the same database share unchanged RocksDB data files, so the second and subsequent backups only copy the data that changed. The transaction-log snapshot — and the blob snapshot, if the database has file-backed blobs — is copied in full on every backup, so those portions are not incremental; with a large audit-retention window, frequent backups are not free for them. Pass `exclude_blobs: true` to skip the blob snapshot. Use [`purge_backups`](#purge_backups) to manage retention.

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

Verifies a managed backup's RocksDB file sizes — and their checksums when `verify_checksum` is `true` (slower) — together with the framing of its transaction-log snapshot (always checked). The blob snapshot is not verified. Through a running server this runs as a background [job](../operations-api/operations.md#jobs). `backup_id` is required.

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

<VersionBadge version="v5.2.0" /> <EngineBadge engines="RocksDB" />

Restores a database in place from a managed backup. `backup_id` defaults to the latest backup. The audit/transaction log is restored alongside the data, and — for a database with file-backed blobs — the blob roots are purged and rewritten from the backup's blob snapshot.

Through a running server this runs as a background [job](../operations-api/operations.md#jobs): Harper closes the database across all worker threads, restores it, and reloads it. This works only when no loaded component is holding the database open — if one does, the job ends in `ERROR` (surfaced by [`get_job`](../operations-api/operations.md#get_job)) telling you to restore offline. Restoring the `system` database is rejected up front, before a job is created, as is `target_database` while the server is running. These cases require running the command from the CLI with the server stopped. See [when can a database be restored?](./overview.md#when-can-a-database-be-restored)

As of v5.3.2, a restore checks that this version of Harper can read the backup's database files before it replaces them. Harper first restores the backup into a staging directory beside the database, checks its transaction logs, and opens it. Only then does it swap the staged copy in for the database. A backup whose database files are corrupt, or written in a format this version cannot read, is refused: the job fails with an error saying the database `was not modified`, followed by the cause, and the database keeps its data and its blobs. The check covers the database files and transaction logs only. File-backed blobs are not staged or checked; as before, they are rewritten from the backup's blob snapshot after the swap, so a failure there leaves the database marked incompletely restored until a rerun succeeds.

Staging needs free space beside the database directory for the backup's restored database files, including its transaction logs, which `list_backups`'s `size` leaves out. A rerun after a restore interrupted during the swap can need room for one more copy, because the previous database is kept until the rerun completes. The database directory must be a real directory on the same filesystem as its parent: a database whose directory is a symbolic link or a mount point is refused before anything is staged. Point the configured database path at the link's target, or mount the volume at the parent directory instead.

As of v5.3.1, subscriptions opened before a restore do not carry over to the restored data. When Harper reloads the database, each one ends, and its last message is a `DatabaseGenerationChangedError` (status code 409, code `DATABASE_GENERATION_CHANGED`). Resubscribe to resynchronize against the restored state. A restore that fails before it changes anything reloads the database as it was; those subscriptions end instead with a retryable `DatabaseClosingError` (status code 503, code `DATABASE_CLOSING`); resubscribe to continue.

From the CLI with the server stopped, `target_database=<name>` restores into a separate database instead of overwriting the source. The target must not already exist, or must be an empty directory; Harper picks the new database up on the next start.

If a restore is interrupted before it completes (crash, power loss), Harper marks the database as incompletely restored and refuses to load it on the next start, logging an incomplete-restore error. Recover by rerunning `restore_backup` for the same database and `backup_id` — do not try to load or hand-repair the directory. From the moment the swap begins until the restore finishes, Harper keeps the previous database's files (not its blobs) aside, and removes them only once a rerun completes.

```json
{ "operation": "restore_backup", "database": "data", "backup_id": 1 }
```

```bash
harper restore_backup database=data backup_id=1
# restore into a new database instead of overwriting the source (server stopped)
harper restore_backup database=data backup_id=1 target_database=data_restored
```

## `get_backup`

<EngineBadge engines="RocksDB, LMDB" />

Streams a full snapshot of the specified database in the HTTP response for download — there is no server-side artifact and nothing to clean up. The server must be running; this is the one backup operation with no offline form. Behavior depends on the storage engine:

- **RocksDB** <VersionBadge type="changed" version="v5.2.0" /> — streams a `tar` archive of the current database state — all tables, the transaction log, and any file-backed blobs — gzipped by default (`gzip` is a RocksDB-only option and compresses the snapshot substantially). Pass `"gzip": false` for a plain `tar`, or `"exclude_blobs": true` to leave blobs out. The snapshot is always the current state; downloading a specific historical `backup_id` is not supported — to move a retained managed backup off-host, copy its whole per-database backup repository (see [Limitations](./overview.md#limitations)). Restoring a RocksDB snapshot by hand takes an extra step when the database has blobs — see [download a snapshot and restore it manually](./overview.md#example-download-a-snapshot-and-restore-it-manually).
- **LMDB** — streams the `.mdb` file. Specify `"table"` for a single table or `"tables"` for a set, and `"include_audit": true` to include the audit store. These options are LMDB-only.

```json
{ "operation": "get_backup", "database": "data" }
```

From the CLI, pass `out=<path>` to choose the output file (defaults to a name derived from the response):

```bash
harper get_backup database=data out=./data.tar.gz
harper get_backup database=data target=https://node-2.example.com:9925 out=./data.tar.gz
```
