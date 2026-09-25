# dataLayer/ — Design notes

Backup and restore, version gating, system-table bootstrap and storage migration.

**Read this when:** touching `rocksdbBackup.ts`, `restoreMarker.ts`, `blobBackup.ts`, `hdbInfoController.ts`, `bin/copyDb.ts` or `json/systemSchema.json`.

Index of every design note: [DESIGN.md](../DESIGN.md).

---

## Version gate at startup: downgrades prompt, and only the minor direction is confirmable

`getVersionUpdateInfo()` (`dataLayer/hdbInfoController.ts`) compares the store's `data_version_num` (latest `system.hdb_info` record) against the binary's `packageJson.version` on every start. Data newer than binary by a **major** version → hard refusal. Newer by a **minor** version → `forceDowngradePrompt()` asks for confirmation; answering yes records the data version back down to the binary's version and boots (upgrade directives are deliberately additive/downgrade-compatible — see the struct-mode section above and `patchHdbSecretIsHashAttribute` in `upgrade/directives/5-2-0.ts`).

- The prompt's answer can be supplied non-interactively via `CONFIRM_DOWNGRADE` — env var or `--CONFIRM_DOWNGRADE` CLI arg; argv wins (`assignCMDENVVariables`). With no override and no TTY on stdin, the prompt throws instead of blocking on stdin forever (#2046 — services/CI hung with nothing in the log; the mismatch is also logged to hdb.log now).
- Upgrades never prompt (see the rationale comment in `bin/upgrade.js`); only the downgrade direction confirms. `upgradeCertsPrompt()` (4.x upgrade path; currently has no in-core caller) has the same no-TTY guard as `forceDowngradePrompt()` — a `GENERATE_CERTS` override is honored first, and with no TTY and no override it throws instead of blocking.
- Test-suite gotcha: a suite that supplies the override via `process.argv` affects every later test file in the same mocha process — save and restore `process.argv` in `before`/`after` (see `unitTests/dataLayer/hdbInfoController.test.js`).

## Opening a source LMDB DBI for migration must thread through `compression`

When `migrateOnStart` opens a source LMDB primary store to read records out for the RocksDB copy, it constructs an `OpenDBIObject` and calls `sourceRootStore.openDB(key, dbiInit)`. Critically, the per-attribute `compression` setting from the corresponding `__dbis__` entry must be assigned onto `dbiInit` before that call — `dbiInit.compression = attribute.compression`. Without it, lmdb-js doesn't install its decompression layer; every read on the DBI returns raw compressed bytes. msgpackr then misreads bytes in the `0x40–0x7F` range as shared-structure refs, calls `loadStructures` → decodes the (also compressed) structures buffer → finds more bytes in that range → recurses → stack overflow.

Harper's normal `databases.ts` path already does this (search for `dbiInit.compression = primaryKeyAttribute.compression`); the migration path in `bin/copyDb.ts` has to match.

The persisted `compression` value itself is LMDB-era and loosely shaped: `getDefaultCompression()` historically stored whatever falsy value the config resolved to (`''`, `false`, `null`) when `storage.compression` was disabled, and `{ startingOffset, threshold, dictionary? }` when enabled. lmdb-js interprets falsy as "no compression", but rocksdb-js >= 2.6 validates the option strictly (`''`/booleans throw `Unsupported compression algorithm`) and treats UNSET as "use the build default (lz4)" — the inverse default of lmdb. Every RocksDB open must therefore route through `toRocksCompression()` in `resources/databases.ts` (applied inside `openRocksDatabase`, the single chokepoint), which maps defined-falsy → `'none'` and enabled-without-an-algorithm → an explicit lz4 request when available. Don't pass persisted attribute compression to a RocksDB open directly.

`bin/copyDb.ts`'s `openRocksDb` is part of that chokepoint, not an exception to it. This is about the bytes migration writes, not about a later failure: `copyDbToRocks()` closes every target handle before the staging directory is renamed, and rocksdb-js permits an explicit codec change across a close/reopen, so the runtime would open the migrated database fine either way. But a migration that ignores the configured codec writes the entire dataset uncompressed, and those SST/blob files then keep their original codec until write traffic rewrites them — a full LMDB→RocksDB migration is the one moment the whole dataset is written at once, so it is exactly when the deployment's codec should apply.

## System table bootstrap: `systemSchema.json` + upgrade directive

Adding a new system table (e.g. `hdb_deployment` in #641 Slice A) requires three changes:

1. **`json/systemSchema.json`** — the table entry. Fresh installs auto-create it via `utility/mount_hdb.ts:createTables()`, which iterates `Object.keys(systemSchema)` on first boot.
2. **`utility/hdbTerms.ts`** — add the table name to `SYSTEM_TABLE_NAMES`.
3. **`upgrade/directives/<version>.ts`** — provisions the table on existing installs that already have a system schema. Registered in `upgrade/directives/directivesController.ts` (which is otherwise empty — its `versions` Map gets populated by these imports). The directive shape is `{ version, sync_functions, async_functions }`; copy `5-1-0.ts` for the canonical pattern (uses `bridge.createTable` to match what `mount_hdb` does on a fresh install).

   **Version the directive to the first release that ships the dependent code, not a later one.** Directives only run when `current_version < directive_version <= upgrade_version` (`directivesController.getVersionsForUpgrade`). The `hdb_deployment` directive was originally mis-tagged `5.2.0` while the deployment-recorder code shipped in `5.1.0`, so on every `5.0.x -> 5.1.x` upgrade the directive was filtered out (`5.2.0 > 5.1.x`) and the table never got created — breaking replicated `deploy_component` on peer nodes for the entire existing customer base. Caveat: `utility/common_utils.ts:compareVersions` strips trailing `.0` and therefore sorts a pre-release (`5.1.0-beta.1`) _above_ its GA (`5.1.0`), so an install already on a `5.1.0-beta.x` data version will not pick up a `5.1.0` directive when upgrading to GA; those pre-release installs need the table created by other means.

System tables replicate by default. To opt out, add the name to `NON_REPLICATING_SYSTEM_TABLES` in `resources/databases.ts`. The check happens after table init and sets `table.replicate = false` per-node.

If the table needs `audit: true`, set it both in the schema (for fresh installs) **and** on the `CreateTableObject` instance in the directive (for upgrades) — otherwise the two paths diverge.

## RocksDB backup/restore: the restore lock + marker protocol (`dataLayer/restoreMarker.ts`, `dataLayer/rocksdbBackup.ts`)

The `restore_backup` operation restores a user database on a live server by closing it across all
worker threads, purging its directory (`backups.restore` with `purgeAllFiles`), and reloading it.
Three non-obvious mechanics keep that safe:

- **Two files in an isolated `` `restore` `` directory beside (never inside) the database directory**,
  each keyed by `sha256(basename(dbPath)).slice(0,32)`: `<key>.lock`, an OS-level exclusive flock
  (rocksdb-js `tryFileLock`, auto-released on process death), serializes restores; `<key>.restoring`,
  a marker written+fsynced (file _and_ the metadata directory) after the lock and before any
  destructive step, means "a restore started and has not finished" (its first line records the
  database directory name so the scan can map a marker back without decoding the key). The metadata
  is hashed into a sibling directory rather than suffixed onto the database name (`<db>.restoring`)
  for two reasons: a legal database literally named `orders.restoring` would otherwise be mistaken
  for the restore marker of `orders`, and a 250-character name (the legal max) plus a `.restore.lock`
  suffix exceeds `NAME_MAX` (255) on most filesystems. The directory name deliberately contains a
  backtick — `schemaRegex` (the database-name validator) forbids only `/` and a backtick among
  filesystem-legal characters — so it can never collide with a legal database name, including a
  database literally named `.restore` (which _is_ a legal name; a plain `.restore/` directory would
  be exactly that database's directory). Because the startup scan opens any `CURRENT`+`MANIFEST-`
  directory without re-applying `schemaRegex`, it also explicitly skips the reserved `` `restore` ``
  entry so an out-of-band directory at that name is never loaded as a database. Startup/rescan
  detection (`databasesBlockedByRestore` → `scanBlockedRestores` in `dataLayer/restoreMarker.ts`)
  reads the metadata directory and checks the **marker first**, only probing the lock when the marker exists —
  probes take the flock and are mutually exclusive across threads, so probing the (persistent) lock
  file of every long-ago-restored database on every rescan would make concurrent rescans misclassify
  healthy databases as in-progress. Marker-present + lock-held = restore in progress (don't load);
  marker-present + lock-free = crashed mid-restore (don't load; rerun the restore to recover).
- **A recovery restore must not clear a pre-existing marker on a pre-destruction failure.**
  `beginRestore` returns `preexisting: true` when a `.restoring` marker was already present (this run
  is a recovery over a possibly half-purged directory). If such a run fails _before_ any destruction
  (e.g. `verifyDatabaseClosed` finds a leaked handle), it must leave the marker in place — clearing
  it and broadcasting a reload would surface the earlier attempt's partial/corrupt directory as
  healthy. Only a _fresh_ marker on a _previously healthy_ database that failed before destruction is
  safe to clear.
- **The ITC close broadcast is best-effort, so closure is verified before the purge.** The SCHEMA
  broadcast (`signalSchemaChange`) resolves after remote handlers complete but times out at 30s
  "best-effort", swallows errors, and never reaches job-worker threads at all (their ports are
  excluded from broadcasts to avoid re-entrant deadlocks). A destructive purge cannot trust it:
  `restoreBackup` polls rocksdb-js `registryStatus()` (process-global across worker threads) until
  the database path has no open instance, and aborts with a 409 — _cleaning up the marker, since
  nothing was destroyed_ — if handles remain.
- **Online restore is impossible for a database a component holds open — and that failure is
  correct.** rocksdb-js's registry is process-global but records only a per-path refCount, with no
  attribution to a thread or component; Harper keeps no component→database ownership map. So when a
  loaded component (or the `system` database, which Harper itself never stops while running) holds
  its own handle on the target database, `registryStatus()` stays non-zero, Harper can neither
  identify nor force-close that handle, and an in-place purge would corrupt a live instance.
  `verifyDatabaseClosed` therefore waits only a short grace period (`DATABASE_CLOSE_WAIT_MS`, for a
  just-finished job worker's own close to drain) and then fails fast with a 409 that points at
  running the operation offline (`harper restore_backup` with the server stopped, where no
  components are loaded and nothing holds the database open). Offline restore is the supported path
  for component-held and `system` databases; online restore serves databases not actively held by a
  component. The CLI exposes each backup operation under its operation name only (`create_backup`,
  `restore_backup`, …) — no hyphenated alias — and `bin/backup.ts` routes it to a reachable server
  or, when the local server is stopped, to the equivalent offline function.
- **Job workers must release their RocksDB handles on exit, or the closure check can never pass.**
  rocksdb-js's registry is process-global across worker threads, and a thread that exits WITHOUT
  closing leaks its handles (the refCount never drops); the only alternative, `shutdown()`, tears
  down rocksdb for the _entire_ process. A job worker (`server/jobs/jobProcess.ts`) opens the whole
  database graph via `getDatabases()` and exits when the job finishes — and `create_backup` is
  itself a job, so before any `restore_backup` there is always at least one exited job worker that
  touched the database. Without cleanup those leaked handles keep `registryStatus()` non-zero and
  would fail the closure check even when no component holds the database. `jobProcess` therefore
  calls `closeLoadedDatabases()` (`resources/databases.ts`) in its `finally`, closing every loaded
  user database on that thread (the non-enumerable `system` DB is intentionally skipped), so an
  exited job worker leaves no residual handle to be mistaken for a live holder.
- **`dropDatabase` and `restore_backup` serialize on the same lock, not a check-then-act probe.**
  A drop's `destroy()` interleaving with a restore's purge-and-copy on the same directory would gut
  a "successful" restore (or vice versa). `dropDatabase` takes the restore lock for every RocksDB or
  LMDB root and publishes a positional `.dropping` marker beside each root before deleting any of
  them. A restore in progress makes the acquire fail with 409; `beginRestore` likewise refuses a
  surviving drop marker. Each marker also records the root store's blob identity, so a retry can
  remove every physical store's blob directories even when only a configured alias survives; an
  integrity digest makes damaged identity content fail closed instead of redirecting deletion.
  Markers are removed only after every root and blob path has been removed.
  Startup scans and cold opens reject the marked root and the rest of its logical database graph, so
  a crash while publishing or canceling several markers cannot expose a partial database. Retrying
  `drop_database` re-enumerates that graph and completes the deletion even when the in-memory catalog
  is gone.
  `database()`'s on-demand open still uses the read-only `throwIfBlockedByRestore` (a
  `create_table`/`create_schema` must not resurrect a half-purged directory as a fresh empty DB), but
  the destructive drop path now uses the exclusive lock so the race is closed, not merely narrowed.
- **The offline restore probes RocksDB's own `LOCK` file, and fails closed.** The offline path runs
  only when the CLI sees no server (a PID heuristic; the PID file is briefly absent mid-`harper
restart`), and `backups.restore`'s `purgeAllFiles` never takes RocksDB's lock — so before purging,
  `restoreBackupOffline` opens the database to probe. It now takes the restore lock+marker _before_
  probing (so a server that starts afterward sees the marker and refuses to load), and recognizes the
  pinned rocksdb-js 2.5.0 lock error — a plain `Error` with no `code` and message
  `IO error: While lock file: <db>/LOCK: Resource temporarily unavailable` (`isRocksDbLockError`) —
  aborting with a 409 rather than purging a database another process holds open. Any _other_ open
  failure (corrupt/half-restored) is exactly what restore recovers, so only a lock conflict aborts.

Known limitation: the flock is process-owned; if the restore job's worker _thread_ dies without
the process exiting, the lock stays held (restores 409) until Harper restarts. There is no typed
native lock signal in rocksdb-js 2.5.0, so the offline probe relies on message matching; a native
lock primitive is a rocksdb-js follow-on.

## RocksDB managed backups: blob snapshots (`dataLayer/blobBackup.ts`)

A database's file-backed blobs live in one or more roots _outside_ the RocksDB directory
(`getBlobPathsForDatabaseName` in `resources/blob.ts` — one per configured `storage.blobPaths`, else
`<hdb_root>/blobs/<database>`), so the engine's backup does not capture them. `create_backup`,
`restore_backup`, `delete_backup`, `purge_backups`, and the streaming `get_backup` therefore handle
blobs alongside the engine data (the `exclude_blobs` request option — default false — opts out for an
engine-only backup):

- **Managed backups** snapshot the blob roots to `<backupDir>/blobs/<backupId>/<rootIndex>/<relpath>`
  — a full, non-incremental copy per backup, mirroring the binding's `transaction_logs/<id>/` layout.
  Each enumerated entry is classified before capture: complete blobs and existing abort markers are
  hard-linked when possible (copied across filesystems), `.repair` temporaries are omitted, and an
  incomplete blob is replaced by a retryable PENDING (`0xfe`) marker. If a classified blob vanishes
  before capture, a terminal ERROR (`0xff`) marker preserves its file id. A file reclaimed before its
  parent directory is read is outside the snapshot. This keeps a snapshot inode from changing as a
  live write finishes, while complete blobs remain safe to hard-link because published blob paths are
  write-once. The snapshot is built in a `.tmp-<id>` sibling and atomically renamed so a failed create
  leaves no partial snapshot. `restore_backup` purges each blob root and rewrites it from the snapshot;
  `delete_backup` / `purge_backups` remove the corresponding snapshot directories.
- **`get_backup`** appends the blob files to the same tar under `blobs/<rootIndex>/<relpath>`. The
  binding's streaming backup finalizes its tar with exactly a 1024-byte (two-block) end-of-archive
  marker; `createBackupStream` streams the native _plain_ tar while withholding that trailer
  (verifying it is all-zero), appends the blob entries via `tar-stream` (whose `finalize` writes the
  one real trailer), and gzips the combined stream itself when requested — so the binding is always
  asked for a plain tar and compression happens after the append. No scratch disk. The same blob
  classification rule applies: complete blobs are streamed, incomplete or post-enumeration missing
  blobs become PENDING/ERROR marker entries, and repair temporaries are omitted.

**Completion manifest (`dataLayer/backupManifest.ts`).** `create_backup` is two-phase: the engine
backup (`rootStore.backup()`) resolves — and is immediately visible to `list_backups`/`verify_backup`/
`restore_backup` — before the blob snapshot is copied. Without a completion record, a blob-snapshot
failure (or a crash between the phases) would leave an engine backup that lists and verifies as
healthy while silently missing its blobs, and a concurrent restore could pick a backup id whose
snapshot is still being written and treat it as intentionally engine-only. So a manifest at
`<backupDir>/manifests/<backupId>.json` — recording the blob-inclusion policy — is written
(atomically, temp + rename) only after _both_ phases are durable, and a graceful blob-snapshot
failure rolls back the just-created engine backup + partial snapshot. Consumers treat a backup id
with no manifest as incomplete: `list_backups` hides it, `verify_backup`/`restore_backup` reject it
(409 for a specific id, "no complete backups" for `latest`), and restore uses the manifest's `blobs`
flag — not the mere presence of a snapshot dir — to decide whether to restore blobs (so an engine-only
backup leaves live blobs untouched, and a manifest that claims blobs but has no snapshot is flagged
corrupt by verify). This closes the "healthy-looking but incomplete" and concurrent-restore races;
the remaining engine/blob point-in-time skew (a blob unlinked between the engine cut and the blob
walk) is the documented best-effort limitation above.
