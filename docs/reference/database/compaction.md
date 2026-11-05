---
title: Compaction
---

<!-- Source: versioned_docs/version-4.7/administration/compact.md (primary) -->
<!-- Source: release-notes/v4-tucker/4.3.0.md (compact database functionality added) -->

# Compaction

<VersionBadge version="v4.3.0" />

Database files grow over time as records are inserted, updated, and deleted. Deleted records and updated values leave behind free space (fragmentation) in the database file, which can increase file size and potentially affect performance. Compaction eliminates this free space, creating a smaller, contiguous database file.

> **Note:** Compaction does not compress your data. It removes internal fragmentation to make the file smaller. To enable compression on a database, use compaction to copy the database with updated storage configuration applied.

Compaction is also the mechanism to apply storage configuration changes (such as enabling compression) to existing databases, since some storage settings cannot be changed in-place.

## Copy Compaction

<VersionBadge type="changed" version="v5.3.0" /> <EngineBadge engines="LMDB" />

Creates a compacted copy of a database file. The original database is left unchanged.

> **Recommendation:** Stop Harper before performing copy compaction to prevent any record loss during the copy operation.

Run using the [CLI](../cli/commands.md):

```bash
harper copy-db <source-database> <target-database-path>
```

The `source-database` is the database name (not a file path). The target is the full file path where the compacted copy will be written.

As of v5.3.0 neither the target path nor its `<target-database-path>-blobs` companion directory may already exist — `copy-db` refuses both rather than merging the copy into whatever they hold. A copy that fails tries to remove the target, its lock file, and the companion directory it created before reporting the error, so a retry is usually not blocked by the failed attempt. That cleanup is best effort and a removal that itself fails is not reported, so clear both by hand whenever a retry is refused for an existing target — as it also is after a previous successful copy to the same path, or a run killed outright before cleanup could run. This is stricter than earlier v5 releases, which wrote into an existing target: a script that re-copies to a fixed path on a schedule has to remove the previous copy and its companion directory first, or it now fails.

To replace the original database with the compacted copy, move or rename the output file to the original database path after Harper is stopped. That is the one case where the database file travels alone; if the database has `Blob` values, any other destination also needs the blob companion directory described in [File-backed blobs copied separately](#file-backed-blobs-copied-separately).

**Example — compact the default `data` database:**

```bash
harper copy-db data /home/user/hdb/database/copy.mdb
```

`copy-db` fails if the source database is stored in RocksDB, and [compact on start](#compact-on-start) skips RocksDB databases — RocksDB compacts itself.

`copy-db` also fails if the source database's tables span more than one storage environment. Per-table `path` settings put a database's tables in separate root stores — the same configuration that puts a database out of scope for [managed backups](../backups/overview.md#limitations) — and the target is a single environment file, so `copy-db` errors out rather than copying one environment and exiting successfully. [Compact on start](#compact-on-start) skips such a database for the same reason.

### File-backed blobs copied separately

<VersionBadge type="changed" version="v5.3.0" />

`copy-db` copies the database's blob files alongside the copy. Earlier v5 releases copied only the database file, leaving the blobs behind.

`Blob` values are stored outside the database file (unlike `Bytes` values, which are stored inside the record). These blob files live in the configured blob roots — `<storage.blobPaths[n]>/<database>`, or `<rootPath>/blobs/<database>` when `blobPaths` is not configured — and are addressed by **database name**, not by the path of the database file.

`copy-db` therefore writes them alongside the copy:

```
<target-database-path>-blobs/<rootIndex>/...
```

`<rootIndex>` is the position of the source root in the database's blob-root list, preserved so a multi-root database restores each root to its original slot. A `README.md` in that directory records the mapping.

**If the database holds `Blob` values, the copy is not restorable without this directory** — moving the database file on its own silently loses every blob it references. A database with no live blob references does not need the companion directory, though one may still be written (possibly empty) whenever a blob root directory exists.

> **Important:** the companion directory holds only the blob roots that existed on disk when the copy ran, and is not written at all when every root is missing — an unmounted `blobPaths` volume, for instance, yields a database-file-only copy and still exits successfully. `copy-db` says so as it runs: it warns naming each missing root and stating that the copy is missing those blobs if the database ever wrote to them, and on a successful blob copy logs how many roots it copied and where. The exit status carries none of it, so a scheduled copy that checks only the exit code will keep rotating incomplete copies — check the warning, or that every expected `<rootIndex>` tree is present, before treating a copy as a restorable backup. A root that was unmounted at copy time leaves no `<rootIndex>` tree behind, while the mapping in the companion directory's `README.md` still lists it.

To restore the copy under a database name, put each `<rootIndex>` tree into that name's matching blob root — for example, restoring the copy above as a database named `archive` with no `storage.blobPaths` configured:

```bash
cp /home/user/hdb/database/copy.mdb /home/user/hdb/database/archive.mdb
mkdir -p /home/user/hdb/blobs/archive
cp -r /home/user/hdb/database/copy.mdb-blobs/0/. /home/user/hdb/blobs/archive/
```

A database with several `storage.blobPaths` entries has one `<rootIndex>` tree per root: restore every one of them into the slot of the same index. Leaving a tree behind loses exactly the blobs that lived on that root, and neither the copy nor Harper reports it.

One narrow exception: if the copy immediately replaces its own source in place — same installation, same database name, before anything writes to the source — the database file alone is enough, since the blob roots it references are still exactly as the copy left them. A copy kept as a backup does not qualify: once the source is written to, Harper can reclaim the blob files an older copy still references, so restore the companion directory along with the database file.

## Compact on Start

<VersionBadge type="changed" version="v5.3.0" /> <EngineBadge engines="LMDB" />

Automatically compacts all non-system databases when Harper starts. Harper will not start until compaction is complete. Under the hood, it loops through all user databases, creates a backup of each, compacts it, replaces the original with the compacted copy, and removes the backup.

Compact on start replaces each database in place under its own name, so the blob roots keep resolving and no blob companion directory is involved. It skips RocksDB databases, and skips a database whose tables span more than one storage environment (table-specific paths), which compaction cannot replace as a single file. Both skips are logged and the remaining databases still compact.

> **Note:** the backup `compactOnStartKeepBackup` retains is the pre-compaction database file only. It carries no blobs, and blob files are shared by database name, so blobs deleted or superseded after the compaction are gone from that backup's point of view. Treat it as a rollback for the compaction itself, not as a point-in-time backup. For that, an LMDB database needs a volume snapshot covering the database file and its blob roots together, or a `copy-db` copy kept with its blob companion directory — [`get_backup`](../backups/operations.md#get_backup) on an LMDB database streams the `.mdb` file only.

Configure in `harper-config.yaml`:

```yaml
storage:
  compactOnStart: true
  compactOnStartKeepBackup: false
```

Using CLI environment variables:

```bash
STORAGE_COMPACTONSTART=true STORAGE_COMPACTONSTARTKEEPBACKUP=true harper
```

### Options

| Option                     | Type    | Default | Description                                                                     |
| -------------------------- | ------- | ------- | ------------------------------------------------------------------------------- |
| `compactOnStart`           | Boolean | `false` | Compact all databases at startup. Automatically reset to `false` after running. |
| `compactOnStartKeepBackup` | Boolean | `false` | Retain the backup copy created during compact on start                          |

> **Note:** `compactOnStart` is automatically set back to `false` after it runs, so compaction only happens on the next start if you explicitly re-enable it.

## Related Documentation

- [Storage Algorithm](./storage-algorithm.md) — How Harper stores data using LMDB
- [CLI Commands](../cli/commands.md) — `copy-db` CLI command reference
- [Configuration](../configuration/options.md) — Full storage configuration options including compression settings
