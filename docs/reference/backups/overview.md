---
id: overview
title: Backups
---

<!-- Source: HarperFast/harper#1831 (RocksDB managed backup and restore operations) -->

Harper can back up and restore its databases natively. A backup is a whole-database copy — all tables, the audit/transaction log, and any file-backed blobs — so a restored database is a consistent point-in-time image of everything in it. (`get_backup` on an LMDB database is the exception: it can stream a subset of tables, and includes the audit store only when requested.)

Two complementary mechanisms are available:

- **Managed backups** <VersionBadge version="v5.2.0" /> <EngineBadge engines="RocksDB" /> — incremental, verifiable backups kept in a server-side repository. Harper creates, lists, verifies, deletes, purges, and restores them through the [backup operations](./operations.md).
- **Snapshot download** <EngineBadge engines="RocksDB, LMDB" /> — [`get_backup`](./operations.md#get_backup) streams a full snapshot of a database over HTTP for storage off-host, with no server-side artifact.

Every backup operation is available through the [Operations API](../operations-api/overview.md) and as a [CLI command](./operations.md#running-backup-operations-from-the-cli) under the same operation name.

## How managed backups work

Managed backups use the RocksDB backup engine. Each backup is a directory under the configured backup root ([`storage.backupPath`](../configuration/options.md#storage), default `<rootPath>/backup`), with one subdirectory per database. Because RocksDB data files are immutable once written, backups in the same location share unchanged files: the first backup copies the whole database, and each subsequent backup only copies what changed since the last one. Shared files are reference-counted, so deleting a backup only removes files no remaining backup references.

Every managed backup includes the database's transaction log — so a restored database keeps its `read_audit_log` history as of the backup point — and, for a database with file-backed blobs, a snapshot of those blobs (skip it with `exclude_blobs`).

Only the RocksDB data files are shared and incremental. The transaction log and the blob snapshot are each copied in full on every backup, so with a large audit-retention window or many blobs, frequent backups cost more than the data-only view suggests.

The long-running operations (`create_backup`, `verify_backup`, `restore_backup`) run as background [jobs](../operations-api/operations.md#jobs) when invoked through a running server: the operation returns a `job_id` immediately, and [`get_job`](../operations-api/operations.md#get_job) reports the outcome.

## Online and offline

Backup operations work whether or not Harper is running. Invoked from the CLI while the server is running, the operation is forwarded to the server; while the server is stopped, the command operates directly on the database and backup files. `get_backup` is the exception — it streams from a running server and has no offline form.

The offline path matters for restore. RocksDB is single-writer, so an in-place restore requires the database to be fully closed first. A running Harper server can close its own worker threads' handles, but it cannot close a handle held by a loaded component, nor stop the `system` database it depends on to run — those databases can only be restored with the server stopped. See ["when can a database be restored"](#when-can-a-database-be-restored) below.

## Limitations

- **Managed backups require the RocksDB storage engine.** For LMDB databases, use [`get_backup`](./operations.md#get_backup) or [volume snapshots](../cli/commands.md#backing-up-with-volume-snapshots).
- **Whole-database granularity.** There is no per-table backup or restore. (The one exception: `get_backup` on an LMDB database can stream individual tables, and includes the audit store only with `include_audit`.)
- **One storage root per database.** A database whose tables use per-table `path` storage configs spans multiple root stores and cannot be backed up with these operations.
- **Backups live on the node that created them.** The backup repository is a local directory. RocksDB shares files across backup IDs (a backup ID is not a self-contained folder), so disaster-recovery copies must take the entire per-database repository — `<backupPath>/<database>` — not an individual backup, and must do so while no backup operation is running, or from an atomic filesystem snapshot. A live recursive copy can race `create_backup`/`delete_backup`/`purge_backups` and produce an unrestorable copy. Alternatively, use `get_backup` to pull a snapshot from a running server.
- **`get_backup` always streams the current state.** It cannot download a historical managed backup; to move a retained backup off-host, copy its whole per-database repository as above.
- **A restore is a point-in-time rollback.** In a replicated cluster, coordinate a restore with replication before bringing the node back.
- **An interrupted restore leaves the database unloadable.** If `restore_backup` is interrupted before completing (crash, power loss), Harper marks the database as incompletely restored and skips loading it on the next start, logging an incomplete-restore error. Rerun `restore_backup` for the same database and `backup_id` to recover; do not load or hand-repair the directory.

### When can a database be restored?

An in-place restore purges and rewrites the database's files, which requires the database to be fully closed first. Whether a restore can run online depends on what is holding the database open:

| Database                                           | Online `restore_backup` (server running) | Offline `harper restore_backup` (server stopped) |
| -------------------------------------------------- | ---------------------------------------- | ------------------------------------------------ |
| A user database not opened by any loaded component | Yes — restored in place                  | Yes                                              |
| A user database that a loaded component keeps open | No — the job ends in `ERROR`             | Yes                                              |
| The `system` database                              | No — rejected up front                   | Yes                                              |

- **Online** works only when no loaded component is holding the database open. Because `restore_backup` runs as a background job, the request returns a `job_id` first; if a component is holding the database open, the check fails inside the job, so the job ends in `ERROR` (surfaced by [`get_job`](../operations-api/operations.md#get_job)) with a message telling you to restore offline — Harper cannot force a component's handles closed while the server is running, and restoring under an open instance would corrupt it. (Harper does not track which component uses which database, so it cannot selectively stop one; it can only detect that the database is still open.) The `system` database is rejected up front, before a job is created.
- **Offline** — the same [`restore_backup`](./operations.md#restore_backup) command run from the CLI with the server stopped — works for any database, because no components are loaded and nothing holds it open. This is the required path for the `system` database and for any database a component keeps open.

Online restore always restores in place. To restore into a new database instead of overwriting the source, run `restore_backup` with `target_database` from the CLI with the server stopped.

## Example: incremental backups and restore

Create a managed backup of the `data` database (the default):

```bash
harper create_backup database=data
```

The first backup copies the entire database; each one after that only copies the RocksDB data files that changed, so re-backing-up the data is cheap. (The transaction-log snapshot, and the blob snapshot for databases with file-backed blobs, are copied in full each time — see [how managed backups work](#how-managed-backups-work).) Schedule `create_backup` as often as your recovery point requires, and manage retention with `purge_backups`:

```bash
harper purge_backups database=data keep_count=7
```

List the backups to find the one to restore:

```bash
harper list_backups database=data
```

Restore the latest backup, or pass `backup_id=<id>` for an earlier one:

```bash
harper restore_backup database=data
```

With the server running, this restores the database in place — Harper closes the database across its worker threads, restores it, and reloads it — as long as nothing is holding the database open (see [when can a database be restored?](#when-can-a-database-be-restored)). With the server stopped, the same command restores the files directly and works for any database.

## Example: download a snapshot and restore it manually

`get_backup` streams a full snapshot of a database from a running server — local or remote — which makes it the simplest way to keep backups off-host. Because it can stream from a remote `target`, it also doubles as a way to **clone** a database from another node onto this one: pull the snapshot with `target=<url>`, then restore it locally as shown below. What it streams depends on the storage engine, so the manual restore differs too. The examples below use the `data` database and the default storage path ([`storage.path`](../configuration/options.md#storage), default `<rootPath>/database`).

### RocksDB <EngineBadge engines="RocksDB" />

For a RocksDB database the stream is a `tar` archive, gzipped by default. It contains the database's current state — all tables, the transaction log, and, for a database with file-backed blobs, a `blobs/<rootIndex>/...` tree for each blob root (pass `exclude_blobs=true` to omit them):

```bash
harper get_backup database=data out=./data.tar.gz
# or pull from another node — this clones that node's database onto the current one
harper get_backup database=data target=https://node-2.example.com:9925 out=./data.tar.gz
```

**If the database has no file-backed blobs,** the archive extracts into a directory that opens directly as a RocksDB database. Stop Harper, replace the database's directory under the storage path with the extracted archive, and start Harper again:

```bash
harper stop
mv ~/hdb/database/data ~/hdb/database/data.old # optional: keep a copy of the previous database
mkdir -p ~/hdb/database/data
tar -xzf data.tar.gz -C ~/hdb/database/data
harper start
```

**If the database has file-backed blobs,** the RocksDB files and the `blobs/` tree restore to different locations: the RocksDB files into the database directory, and each `blobs/<rootIndex>/...` tree into its blob root (by default `<rootPath>/blobs/<database>`, or the paths configured in [`storage.blobPaths`](../configuration/options.md#storage); the archive's `blobs/README.md` lists the index-to-path mapping). Extracting the whole archive into the database directory would bury the blobs where the engine can't find them, silently losing blob data. Restore the two parts separately:

```bash
harper stop
# 1. RocksDB files -> database directory (exclude the blobs tree)
mv ~/hdb/database/data ~/hdb/database/data.old # optional: keep a copy of the previous database
mkdir -p ~/hdb/database/data
tar -xzf data.tar.gz -C ~/hdb/database/data --exclude='blobs' --exclude='blobs/*'
# 2. each blobs/<rootIndex>/ -> its blob root (index 0 shown; repeat per root)
mkdir -p ~/hdb/blobs/data
tar -xzf data.tar.gz -C ~/hdb/blobs/data --strip-components=2 blobs/0
harper start
```

The target node must have at least as many blob roots configured as the snapshot captured — blob references store their root index, so a missing root leaves those blobs unresolved. For anything beyond the simplest single-root case, prefer [managed backups](#example-incremental-backups-and-restore): `restore_backup` restores the RocksDB files and every blob root automatically.

### LMDB <EngineBadge engines="LMDB" />

For an LMDB database the stream is the database's single `.mdb` file:

```bash
harper get_backup database=data out=./data.mdb
# or pull from another instance
harper get_backup database=data target=https://node-2.example.com:9925 out=./data.mdb
```

To restore it, stop Harper, replace the database's `.mdb` file under the storage path (`<storage.path>/<database>.mdb`) with the downloaded file, and start Harper again:

```bash
harper stop
mv ~/hdb/database/data.mdb ~/hdb/database/data.mdb.old # optional: keep a copy of the previous database
cp data.mdb ~/hdb/database/data.mdb
harper start
```
