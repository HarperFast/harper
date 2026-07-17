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

Offline invocation matters most for restore: an in-place `restore_backup` of the `system` database, or of any database a loaded component keeps open, must be run with the server stopped. See [when can a database be restored?](./overview.md#when-can-a-database-be-restored)

## `create_backup`

<VersionBadge version="v5.2.0" /> <EngineBadge engines="RocksDB" />

Creates an incremental directory backup of the database under the configured backup root ([`storage.backupPath`](../configuration/options.md#storage), default `<rootPath>/backup`). Through a running server this runs as a background [job](../operations-api/operations.md#jobs): the operation returns a `job_id` immediately, and [`get_job`](../operations-api/operations.md#get_job) reports the outcome including the new `backup_id`, `size`, and `timestamp`.

Backups of the same database share unchanged files, so the second and subsequent backups only copy what changed. Use [`purge_backups`](#purge_backups) to manage retention.

```json
{ "operation": "create_backup", "database": "data" }
```

```bash
harper create_backup database=data
```

## `list_backups`

<VersionBadge version="v5.2.0" /> <EngineBadge engines="RocksDB" />

Returns the managed backups for a database, each with its `backup_id`, `timestamp`, `size`, and `file_count`. Returns an empty array if no backups have been created yet.

```json
{ "operation": "list_backups", "database": "data" }
```

```bash
harper list_backups database=data
```

## `verify_backup`

<VersionBadge version="v5.2.0" /> <EngineBadge engines="RocksDB" />

Verifies a managed backup's file sizes, and optionally their checksums when `verify_checksum` is `true` (slower). Through a running server this runs as a background [job](../operations-api/operations.md#jobs). `backup_id` is required.

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

Restores a database in place from a managed backup. `backup_id` defaults to the latest backup. The audit/transaction log is restored alongside the data.

Through a running server this runs as a background [job](../operations-api/operations.md#jobs): Harper closes the database across all worker threads, restores it, and reloads it. This works only when no loaded component is holding the database open — restoring the `system` database, or a database a component keeps open, requires running the command from the CLI with the server stopped. See [when can a database be restored?](./overview.md#when-can-a-database-be-restored)

From the CLI with the server stopped, `target_database=<name>` restores into a new database instead of overwriting the source. The target must not already exist; Harper picks the new database up on the next start.

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

- **RocksDB** <VersionBadge type="changed" version="v5.2.0" /> — streams a `tar` archive of the current database state (all tables plus the transaction log), gzipped by default (`gzip` is a RocksDB-only option and compresses the snapshot substantially). Pass `"gzip": false` for a plain `tar`. The snapshot is always the current state; downloading a specific historical `backup_id` is not supported — to move a retained backup off-host, copy its backup directory.
- **LMDB** — streams the `.mdb` file. Specify `"table"` for a single table or `"tables"` for a set, and `"include_audit": true` to include the audit store. These options are LMDB-only.

```json
{ "operation": "get_backup", "database": "data" }
```

From the CLI, pass `out=<path>` to choose the output file (defaults to a name derived from the response):

```bash
harper get_backup database=data out=./data.tar.gz
harper get_backup database=data target=https://node-2.example.com:9925 out=./data.tar.gz
```
