# dataLayer/ — Design notes

Backup and restore, version gating, system-table bootstrap and storage migration.

**Read this when:** touching `rocksdbBackup.ts`, `restoreMarker.ts`, `blobBackup.ts`, `hdbInfoController.ts`, `bin/copyDb.ts` or `json/systemSchema.json`.

Index of every design note: [DESIGN.md](../DESIGN.md).

---

## Version gate at startup: downgrades prompt, and only the minor direction is confirmable

`getVersionUpdateInfo()` (`dataLayer/hdbInfoController.ts`) compares the store's `data_version_num` (latest `system.hdb_info` record) against the binary's `packageJson.version` on every start. Data newer than binary by a **major** version → hard refusal. Newer by a **minor** version → `forceDowngradePrompt()` asks for confirmation; answering yes records the data version back down to the binary's version and boots (upgrade directives are deliberately additive/downgrade-compatible — see [Struct mode is gated to primary DBIs](../resources/DESIGN.md#struct-mode-is-gated-to-primary-dbis-downgrade-compatibility) and `patchHdbSecretIsHashAttribute` in `upgrade/directives/5-2-0.ts`).

- The prompt's answer can be supplied non-interactively via `CONFIRM_DOWNGRADE` — env var or `--CONFIRM_DOWNGRADE` CLI arg; argv wins (`assignCMDENVVariables`). With no override and no TTY on stdin, the prompt throws instead of blocking on stdin forever (#2046 — services/CI hung with nothing in the log; the mismatch is also logged to hdb.log now).
- Upgrades never prompt (see the rationale comment in `bin/upgrade.js`); only the downgrade direction confirms. `upgradeCertsPrompt()` (4.x upgrade path; currently has no in-core caller) has the same no-TTY guard as `forceDowngradePrompt()` — a `GENERATE_CERTS` override is honored first, and with no TTY and no override it throws instead of blocking.
- Test-suite gotcha: a suite that supplies the override via `process.argv` affects every later test file in the same mocha process — save and restore `process.argv` in `before`/`after` (see `unitTests/dataLayer/hdbInfoController.test.js`).

## Opening a source LMDB DBI for migration must thread through `compression`

When `migrateOnStart` opens a source LMDB primary store to read records out for the RocksDB copy, it constructs an `OpenDBIObject` and calls `sourceRootStore.openDB(key, dbiInit)`. Critically, the per-attribute `compression` setting from the corresponding `__dbis__` entry must be assigned onto `dbiInit` before that call — `dbiInit.compression = attribute.compression`. Without it, lmdb-js doesn't install its decompression layer; every read on the DBI returns raw compressed bytes. msgpackr then misreads bytes in the `0x40–0x7F` range as shared-structure refs, calls `loadStructures` → decodes the (also compressed) structures buffer → finds more bytes in that range → recurses → stack overflow.

Harper's normal `databases.ts` path already does this (search for `dbiInit.compression = primaryKeyAttribute.compression`); the migration path in `bin/copyDb.ts` has to match.

The persisted `compression` value itself is LMDB-era and loosely shaped: `getDefaultCompression()` historically stored whatever falsy value the config resolved to (`''`, `false`, `null`) when `storage.compression` was disabled, and `{ startingOffset, threshold, dictionary? }` when enabled. lmdb-js interprets falsy as "no compression", but rocksdb-js >= 2.6 validates the option strictly (`''`/booleans throw `Unsupported compression algorithm`) and treats UNSET as "keep the family's persisted codec, or the build default (lz4) for a new family" — the inverse default of lmdb. Every RocksDB open therefore takes one per-process deployment codec, `getRocksCompression()` (applied inside `openRocksDatabase`; see [The RocksDB codec is a deployment setting, resolved once per process](../resources/DESIGN.md#the-rocksdb-codec-is-a-deployment-setting-resolved-once-per-process)), derived through `toRocksCompression()` in `resources/databases.ts`, which maps defined-falsy → `'none'` and enabled-without-an-algorithm → an explicit lz4 request when available. Don't pass persisted attribute compression to a RocksDB open directly.

`bin/copyDb.ts`'s `openRocksDb` applies the same codec (`getRocksCompression() ?? toRocksCompression(...)`), not an exception to it. This is about the bytes migration writes, not about a later failure: `copyDbToRocks()` closes every target handle before the staging directory is renamed, and rocksdb-js permits an explicit codec change across a close/reopen, so the runtime would open the migrated database fine either way. But a migration that ignores the configured codec writes the entire dataset uncompressed, and those SST/blob files then keep their original codec until write traffic rewrites them — a full LMDB→RocksDB migration is the one moment the whole dataset is written at once, so it is exactly when the deployment's codec should apply.

## System table bootstrap: `systemSchema.json` + upgrade directive

Adding a new system table (e.g. `hdb_deployment` in #641 Slice A) requires three changes:

1. **`json/systemSchema.json`** — the table entry. Fresh installs auto-create it via `utility/mount_hdb.ts:createTables()`, which iterates `Object.keys(systemSchema)` on first boot.
2. **`utility/hdbTerms.ts`** — add the table name to `SYSTEM_TABLE_NAMES`.
3. **`upgrade/directives/<version>.ts`** — provisions the table on existing installs that already have a system schema. Registered in `upgrade/directives/directivesController.ts` (which is otherwise empty — its `versions` Map gets populated by these imports). Each directive module default-exports an array of `{ version, sync_functions, async_functions }`; copy `5-1-0.ts` for the canonical pattern (uses `bridge.createTable` to match what `mount_hdb` does on a fresh install).

   **Version the directive to the first release that ships the dependent code, not a later one.** Directives only run when `current_version < directive_version <= upgrade_version` (`directivesController.getVersionsForUpgrade`). The `hdb_deployment` directive was originally mis-tagged `5.2.0` while the deployment-recorder code shipped in `5.1.0`, so on every `5.0.x -> 5.1.x` upgrade the directive was filtered out (`5.2.0 > 5.1.x`) and the table never got created — breaking replicated `deploy_component` on peer nodes for the entire existing customer base. Caveat: `utility/common_utils.ts:compareVersions` strips trailing `.0` and therefore sorts a pre-release (`5.1.0-beta.1`) _above_ its GA (`5.1.0`), so an install already on a `5.1.0-beta.x` data version will not pick up a `5.1.0` directive when upgrading to GA; those pre-release installs need the table created by other means.

System tables replicate by default. To opt out, add the name to `NON_REPLICATING_SYSTEM_TABLES` in `resources/databases.ts`. The check happens after table init and sets `table.replicate = false` per-node.

Set `audit = true` on the directive's `CreateTableObject` (for upgrades): a fresh install audits every system table — `utility/mount_hdb.ts:createTables()` sets `createTable.audit = true` regardless of the schema entry — so a directive that leaves it off makes upgraded nodes diverge from fresh ones.

**A replicated system table whose owner declares more than a name list** — a table-level `expiration`, an index — needs that declaration on every node, every boot. `hdb_oidc_token_use` is the case: `security/authn/oidc/tokenUseTable.ts` holds its one definition, and `bin/run.ts initialize()` applies it after the upgrade step and before worker threads start (skipped in read-only mode; a failure is logged and retried on the next start), as do the 5.3.0 directive and the exchange path. Each replay row carries its own expiry as record metadata, which replication applies on the receiving node; the table's stored `expiration` is what arms the cleanup scan that removes those rows once a node loads the table. Metadata rather than an `@expiresAt` attribute, because the attribute needs an index and a sweep of its own on every node, while reads and the cleanup scan already honor the metadata. `systemSchema.json` keeps only its primary key; the declaration completes the table on the first boot after install. Every other route to a copy leaves it partial, which is why the declaration cannot live only on the exchange path or in the directive:

- A node that has not upgraded yet gets any system table it lacks from a peer's replication handshake (`DB_SCHEMA`), created from a snapshot that carries each attribute's name, type and primary-key bit — never `indexed`, `expiresAt` or the table's `expiration` — and schema-defined like the peer's copy. From then on the handshake keeps that local definition and logs `Schema for '<db>.<table>' is defined locally, but attribute '<name>: <type>' from '<node>' does not match local attribute which does not exist` for every attribute a peer has and it lacks, so no peer repairs it; the directive that runs when that node upgrades finds the table already there.
- A node that never exercises the owner's code path (a passive cluster member for the OIDC exchange) never declares the rest, and the rows replicated to it are never removed.
- An install already on a pre-release of the directive's version never runs the directive again (the `compareVersions` caveat above): from `5.3.0-beta.2`, `getVersionsForUpgrade` selects nothing for `5.3.0`, `5.3.0-beta.3` or `5.3.1`.

A local `table()` declaration is authoritative, so repeating it repairs any of those shapes in place, keeping every row and its expiry, and is a no-op once the shape matches (measured 2026-09-25: under 1 ms; repairing a copy holding 100,000 replay rows, under 10 ms on either engine, since no row is rewritten and no index is built). Limits that come from the storage layer rather than this table:

- A thread that only loads the table scans daily (the load path keeps the default interval; only a declaring thread uses a quarter of the `expiration`), so a spent row can stay on disk up to a day past its expiry. Reads skip it meanwhile.
- Under `threads: 0` the main thread loads and declares the table before `startHTTPThreads` makes it worker 0. `scheduleCleanup` records an interval only once its thread has a worker index, so the first expiring write or declaration after that arms the scan; a single-threaded node that writes nothing after a restart does not scan until it does.
- An attribute a declaration drops keeps its index store on disk: `table()` looks that store up by table name rather than attribute name, so it never drops it. A node that served exchanges on 5.3.0-beta.2 keeps its old `expiresAt` index; after a restart nothing opens it.

The certificate verification tables (`hdb_certificate_cache`, `hdb_crl_cache`, `hdb_revoked_certificates`) follow the same pattern through `security/certificateVerification/verificationTables.ts`, applied in `initialize()` right after the OIDC table and by the verification path's getters. `ensureCertificateVerificationTables` also waits for the revoked table's index backfill and reads its outcome back from the catalog, since a failed backfill still settles. What their rows hold is in security/DESIGN.md.

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
  detection (`databasesBlockedByRestore` in `resources/databases.ts` → `scanBlockedRestores` in `dataLayer/restoreMarker.ts`)
  reads the metadata directory and checks the **marker first**, only probing the lock when the marker
  exists — the probe is shared, so it coexists with other readers, but it is still skipped without a
  marker so a rescan does no lock work for the (persistent) lock file of every long-ago-restored
  database. Marker-present + lock-held = restore in progress (don't load);
  marker-present + lock-free = crashed mid-restore (don't load; rerun the restore to recover).
- **A recovery restore must not clear a pre-existing marker on a pre-destruction failure.**
  `beginRestore` returns `preexisting: true` when a `.restoring` marker was already present (this run
  is a recovery over a possibly half-purged directory). If such a run fails _before_ any destruction
  (e.g. `verifyDatabaseClosed` finds a leaked handle), it must leave the marker in place — clearing
  it and broadcasting a reload would surface the earlier attempt's partial/corrupt directory as
  healthy. Only a _fresh_ marker on a _previously healthy_ database that failed before destruction is
  safe to clear.
- **The ITC close broadcast is normally best-effort, so closure is verified before the purge.** A
  SCHEMA broadcast (`signalSchemaChange`) usually resolves after remote handlers complete but times
  out at 30s "best-effort" and swallows errors. The restore `close` phase is stricter: it waits until
  every eligible recipient acknowledges or its port closes, and aborts the restore with a retryable
  409 if that does not happen within 30s, because proceeding past an unconfirmed blob-save barrier
  would re-open the race the barrier exists to close. A destructive purge still
  verifies closure independently: `restoreBackup` polls rocksdb-js `registryStatus()` (process-global
  across worker threads) until the database path has no open instance, and aborts with a 409 —
  _cleaning up the marker, since nothing was destroyed_ — if handles remain.
- **The close acknowledgement fences blob saves, deferred reclamation and orphan cleanup, not just
  database handles.** A store
  handle can close while a `saveBlob` file pipeline it started is still pending, because blob roots
  live outside RocksDB and streamed saves settle independently of the record write; a queued
  reclamation is worse still, being a timer that never consults the database at all. The restore
  signal therefore has explicit `close` and `reload` phases: every worker refuses new saves for that
  database, stops draining reclamations for it, stops any `cleanup_orphan_blobs` walk in progress
  (its "nothing references this path" verdict was reached against the generation being replaced),
  awaits the saves and unlinks already dispatched -- including a save-failure cleanup's -- then
  closes the store and acknowledges. Restore signals are the one schema broadcast that includes job
  workers; ordinary gossip still excludes them to avoid re-entrant broadcast deadlocks.

  The fence records the token of the restore that currently owns it, not a flag and not a set. Two
  restores of the same database can overlap — a restore releases its lock before awaiting its `reload`
  broadcast — so a database-wide boolean lets the first restore's late reload lift the second one's
  fence, admitting saves during the second one's post-close check. A later close takes ownership
  without the database ever unfencing in between, and a release whose token is not the current owner
  does nothing. A _set_ of tokens fails the opposite way: a restore that dies after destruction never
  reloads, so its token would keep the database fenced for the life of the process, defeating the
  rerun the failure tells the operator to perform.

  Releasing the fence discards that database's queued reclamations rather than resuming them: they
  condemn file paths belonging to the generation the restore just replaced, so draining them would
  unlink the bytes the restore wrote at those same paths. A restore that aborted before destroying
  anything says so, and its queue is kept and rewoken instead.

- **Online restore is impossible for a database a component holds open — and that failure is
  correct.** rocksdb-js's registry is process-global but records only a per-path refCount, with no
  attribution to a thread or component; Harper keeps no component→database ownership map. So when a
  loaded component holds its own handle on the target database, `registryStatus()` stays non-zero,
  Harper can neither identify nor force-close that handle, and an in-place purge would corrupt a live
  instance.
  `verifyDatabaseClosed` therefore waits only a short grace period (`DATABASE_CLOSE_WAIT_MS`, for a
  just-finished job worker's own close to drain) and then fails fast with a 409 that points at
  running the operation offline (`harper restore_backup` with the server stopped, where no
  components are loaded and nothing holds the database open). Offline restore is the supported path
  for component-held and `system` databases; online restore serves databases not actively held by a
  component. `system`, which Harper itself never stops while running, never reaches this check:
  `validateRestoreBackup` refuses it up front with a 400 naming the offline command. The CLI exposes each backup operation under its operation name only (`create_backup`,
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
- **A restore stamps a new database generation before `completeRestore`.** The restored files carry
  the backup's generation, so both paths open the restored directory privately, stamp it and flush
  (`stampDatabaseDirectory`, [database generation](../resources/DESIGN.md#database-generation-and-resumable-positions))
  inside the destructive section: a failed stamp leaves the marker, and the rerun re-purges and
  re-stamps. The stamp is as durable as the marker protocol it runs inside.
- **`dropDatabase` and `restore_backup` serialize on the same lock, not a check-then-act probe.**
  A drop's `destroy()` interleaving with a restore's purge-and-copy on the same directory would gut
  a "successful" restore (or vice versa). `dropDatabase` takes the restore lock for every RocksDB or
  LMDB root and publishes a positional `.dropping` marker beside each root before deleting any of
  them. A restore in progress makes the acquire fail with 409; `beginRestore` likewise refuses a
  surviving drop marker. Each marker records the root store's blob identity and exact pinned blob
  paths, so a retry removes what an already-marked handle owned even if `storage.blobPaths` changes.
  An integrity digest makes damaged identity content fail closed instead of redirecting deletion.
  Markers are removed only after every root and blob path has been removed.
  Startup scans and cold opens reject the marked root and the rest of its logical database graph, so
  a crash while publishing or canceling several markers cannot expose a partial database. Retrying
  `drop_database` re-enumerates that graph and completes marker publication and deletion even when
  the in-memory catalog is gone. A configured `databases.<name>.path` is the exclusive root of that
  logical graph, not a container for independent databases: every physical database directly beneath
  it is an alias-owned member, and dropping any alias drops the graph. A strict worker-close failure
  similarly keeps that worker's physical roots fenced and remembered; a same-name drop retry
  re-attempts those closes before marker publication or deletion.
  Every open now runs under `withRestoreExclusion` — the startup scan and `database()`'s on-demand
  open, both engines — so the marker check and the open are one critical section (a
  `create_table`/`create_schema` must not resurrect a half-purged directory as a fresh empty DB).
  A restore never targets LMDB, but a drop locks and marks LMDB roots exactly as it does RocksDB
  ones, so LMDB needs the same exclusion against drop. `throwIfBlockedByRestore` survives as the
  cheap pre-check that answers a plainly blocked caller without taking a lock.
- **The offline restore probes RocksDB's own `LOCK` file, and fails closed.** The offline path runs
  only when the CLI sees no server (a PID heuristic; the PID file is briefly absent
  mid-`harper restart`), and `backups.restore`'s `purgeAllFiles` never takes RocksDB's lock — so
  before purging, `restoreBackupOffline` opens the database to probe. It now takes the restore
  lock+marker _before_ probing (so a server that starts afterward sees the marker and refuses to
  load), and recognizes the rocksdb-js lock error by message (`isRocksDbLockError`; at 2.5.0, when
  this was written, a plain `Error` with no `code`) —
  `IO error: While lock file: <db>/LOCK: Resource temporarily unavailable` — aborting with a 409
  rather than purging a database another process holds open. Any _other_ open failure
  (corrupt/half-restored) is exactly what restore recovers, so only a lock conflict aborts.

Known limitation: the flock is process-owned; if the restore job's worker _thread_ dies without
the process exiting, the lock stays held (restores 409) until Harper restarts. rocksdb-js had no typed
native lock signal at 2.5.0 (the pin is now 2.10.0), so the offline probe relies on message matching; a native
lock primitive is a rocksdb-js follow-on.

## Backup repository coordination: the management lock, pins, and the restore exclusion (`dataLayer/backupRepository.ts`, `dataLayer/restoreMarker.ts`)

Four coupled mechanisms guard the backup/restore surface. They are easy to break individually, and each exists because of a specific way the previous arrangement failed.

- **rocksdb-js's `.backup.lock` covers only the engine files.** Harper's blob snapshots (`blobs/<id>/`) and completion manifests (`manifests/<id>.json`) live beside them and are written and removed by Harper code the binding knows nothing about, so a `purge_backups` could remove a blob snapshot out from under a `create_backup` that was still finalizing (harper#2031). Every Harper-managed mutation of a repository therefore takes a **Harper-level management lock** (`withBackupRepositoryLock`) before any engine call that takes `.backup.lock`, and a create holds it across `db.backup()` _and_ finalization: the whole create is one critical section, so no purge can land inside it. It waits rather than failing (30s, then 409), and a holder that dies releases it with its process. The cost is that maintenance stalls behind a multi-gigabyte create — the earlier arrangement left `db.backup()` outside the lock to avoid exactly that, and paid for it by making `finalizeBackup`'s existence check load-bearing rather than defence in depth. That check (`assertBackupStillPresent`) stays, now guarding only writers outside this protocol — an older binary, or a direct binding call — because a manifest and blob snapshot published for engine files that are gone is a backup that lists and verifies with nothing to restore.
- **`purge_backups` names the ids it will remove before the binding removes them.** The management lock excludes every Harper writer, so the listing it takes is exactly what the binding will see, and `backups.purge` keeps the newest `keepCount` by id — so the departing ids can be named, checked against the pins, and then removed by one bulk call. That set is sorted by `backupId` rather than sliced off the listing as returned: it gates pin protection, so it must not rest on the documented list order holding.
- **A pin's lifetime is the restoring marker's lifetime.** A pin names the database directory it protects and counts only while that database still carries a marker (`pinIsLive`). The marker is present exactly when a restore is running or waiting to be rerun, which is exactly when its source must survive, so the two live and die together: a process killed mid-restore leaves both and the rerun clears both, while one killed between clearing the marker and releasing the pin leaves a pin that is ignored and swept the next time anything looks. This is why pins carry no owner id, no expiry and no boot sweep: each is a second answer to when a pin ends, and a pin that outlives the marker it belongs to 409s every later delete forever. The converse is the known gap: a pin that outlives its marker is also taken as proof that a _later_ marker on that target is this source's own, which `target_database` admission relies on (harper#2632). A restore takes the restore lock _before_ pinning, so only the attempt that will actually run touches the pin, and the pin id is derived from the target directory so two attempts cannot collide. The existence check and the pin installation are one step under the management lock: checking after pinning let a failed rerun replace a good claim with one naming nothing.
- **The restoring marker is an exclusion, not a check.** `withRestoreExclusion` holds the per-database restore lock in **shared** mode across the marker check _and_ the open, so a restore's exclusive acquire cannot succeed while any opener holds it and no opener can begin under a restore, while readers never exclude each other. `checkRestoreState` probes shared for the same reason: an exclusive probe answers "is a restore holding this?" by conflicting with every other reader, so a marked database being rescanned on several threads could read as `in-progress` on all of them. The guard runs for every directory the startup scan considers, so on a root Harper cannot write to (`EACCES`/`EPERM`/`EROFS`, or the binding's untyped equivalent) it degrades to the marker check alone and warns once per root — one unwritable root must not take down the rest of the scan. Every other failure propagates: a transient `EMFILE` is not a reason to open a database with no exclusion at all, and failing loudly is recoverable where a silent unguarded open is not. The exclusion is taken only around an engine open; a root already in the engine map is skipped, because a restore must close the live handle first regardless and holding the lock through every rescan would make routine scans collide with drop and restore.
- **The marker itself is published temp → fsync → rename → parent fsync, and an intact one is never rewritten.** `beginRestore` used to open it with `'w'`, truncating before the name was written, and `scanBlockedRestores` skips a marker whose first line is empty — so a crash during a _recovery_ attempt could unblock a half-purged database. "Intact" means the first line equals the database directory name: a torn name leaves a prefix that resolves to a different metadata key and blocks nothing. `preexisting` is sampled while holding the lock, or a restore that waited out an earlier one inherits the earlier run's reading and can clear a marker that run needed.

The work items are tracked under harper#2632.

## RocksDB managed backups: blob snapshots (`dataLayer/blobBackup.ts`)

Repository mutations hold the management lock before entering the engine. Restore admission
rechecks the source under that lock, then `beginRestore` takes the destination lock and runs a
synchronous callback that durably writes the source claim before publishing the restoring marker.
A crash after publication therefore leaves both marker and claim; a crash before publication leaves
only a claim that lapses when no marker exists. Failed claims preserve any preexisting marker.
Delete and purge reconcile Harper-managed files even after engine failure: a cleanup failure must
propagate when the engine succeeded, but remains secondary when the engine already failed.

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
  write-once. The snapshot is built in a `<backupId>.tmp` sibling and atomically renamed so a failed create
  leaves no partial snapshot. `restore_backup` purges each blob root and rewrites it from the snapshot;
  `delete_backup` / `purge_backups` remove the corresponding snapshot directories.
- **`get_backup`** appends the blob files to the same tar under `blobs/<rootIndex>/<relpath>`. Both
  variants — engine-only and with blobs — go through one assembly (`streamBackupArchive`), because
  only a plain tar can have an entry placed ahead of it and `harper-backup.json` must be first (see
  below); the binding's own ability to emit a complete, natively gzipped archive is unusable for that
  reason, and engine-only archives gave it up. The binding's streaming backup finalizes its tar with
  exactly a 1024-byte (two-block) end-of-archive marker; `createBackupStream` writes the manifest
  entry, streams the native _plain_ tar while withholding that trailer (verifying it is all-zero),
  appends the blob entries and READMEs via `tar-stream` (whose `finalize` writes the one real
  trailer), and gzips the combined stream itself when requested — so the binding is always asked for
  a plain tar and compression happens after the append. No scratch disk. The same blob
  classification rule applies: complete blobs are streamed, incomplete or post-enumeration missing
  blobs become PENDING/ERROR marker entries, and repair temporaries are omitted.
- **A consumer that aborts must tear the native producer down.** Destroying the response rejects the
  gzip/passthrough pipeline from anywhere, including while `streamBackupArchive` is awaiting
  something that never touches the combined stream. Nothing would then drain the native tar and the
  binding would wait on it forever, holding the snapshot — and its deferred file deletions — open.
  The rejection handler destroys the native stream itself rather than relying on control reaching the
  `catch`.
- **A native producer rejection must terminate the archive streams.** The producer can reject
  without closing its writable. Its rejection handler destroys both the native tar and the combined
  stream with the original error, releasing an assembler waiting for EOF or downstream backpressure.

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
walk) is best-effort: Harper does not freeze blob writes for a backup.

**Archive manifest (`dataLayer/backupArchiveManifest.ts`).** Every `get_backup` archive carries
`harper-backup.json` as its **first** tar entry, and a managed backup's completion manifest carries
the same document in an optional `producer` block. First is load-bearing, not tidy: a `.tar.gz` must
be inflated from the start to reach a later entry, so a trailing manifest would cost a full pass over
a multi-gigabyte archive just to decide whether to reject it.

- **Compatibility is a capability list, not a version comparison.** The producer declares the tokens
  a reader needs in `requires` (`rocksdb-stream-backup`, `blob-root-index`, `blob-deflate`) and a
  reader refuses any token not in its own `SUPPORTED_ARCHIVE_CAPABILITIES`. Most releases change
  nothing about the formats an archive carries, and the engine-level ones already fail closed on
  their own, so a version table would be wrong in both directions. New tokens are additive, and an
  older reader refusing an unknown one is the intended answer. `harper_version`,
  `rocksdb_js_version` and the whole `source` block are provenance and are **never** gated on —
  keeping them separate is what stops a description from becoming a compatibility check.
  Restore submission and execution share `resolveCompleteBackup`, so an incompatible producer
  returns a 4xx before a job is queued and is checked again when the restore runs.
- **`roles: null` means "not enumerated", which is not "no roles".** Enumeration reads the
  already-loaded `system` database rather than calling `getDatabases()`: the offline CLI runs with
  nothing loaded, and a scan there would open — and lock — every database on the instance. Names
  only; the archive carries no role definitions and a restore never creates a role.
- **A manifest that predates this is accepted, not refused.** A managed backup written without a
  `producer` block came from this instance's own lineage, so it is reported as unidentified. A
  manifest that is present but malformed is an error — that is a different situation, and only the
  first is eligible for an operator's provenance override.
