# dataLayer/ — Design notes

Backup and restore, version gating, system-table bootstrap, storage migration and the legacy SQL executor.

**Read this when:** touching `rocksdbBackup.ts`, `restoreMarker.ts`, `blobBackup.ts`, `hdbInfoController.ts`, `bin/copyDb.ts`, `json/systemSchema.json` or `SQLSearch.ts`.

Index of every design note: [DESIGN.md](../DESIGN.md).

---

## Version gate at startup: downgrades prompt, and only the minor direction is confirmable

`getVersionUpdateInfo()` (`dataLayer/hdbInfoController.ts`) compares the store's `data_version_num` (latest `system.hdb_info` record) against the binary's `packageJson.version` on every start. Data newer than binary by a **major** version → hard refusal. Newer by a **minor** version → `forceDowngradePrompt()` asks for confirmation; answering yes records the data version back down to the binary's version and boots (upgrade directives are deliberately additive/downgrade-compatible — see [Struct mode is gated to primary DBIs](../resources/DESIGN.md#struct-mode-is-gated-to-primary-dbis-downgrade-compatibility) and `patchHdbSecretIsHashAttribute` in `upgrade/directives/5-2-0.ts`).

- The prompt's answer can be supplied non-interactively via `CONFIRM_DOWNGRADE` — env var or `--CONFIRM_DOWNGRADE` CLI arg; argv wins (`assignCMDENVVariables`). With no override and no TTY on stdin, the prompt throws instead of blocking on stdin forever (#2046 — services/CI hung with nothing in the log; the mismatch is also logged to hdb.log now).
- Upgrades never prompt (see the rationale comment in `bin/upgrade.js`); only the downgrade direction confirms. `upgradeCertsPrompt()` (4.x upgrade path; currently has no in-core caller) has the same no-TTY guard as `forceDowngradePrompt()` — a `GENERATE_CERTS` override is honored first, and with no TTY and no override it throws instead of blocking.
- Enforced end to end by `integrationTests/upgrade/minor-downgrade.test.ts`: each release in `HARPER_PREVIOUS_MINOR_PATH` (CI: pinned releases of the previous minor and of `package.json`'s own minor) reads and writes what the current build wrote, and the data survives re-upgrading. Known exception (#3102): a table created on 5.3.0+ reads as empty on 5.2.x, because its stores carry a generation 5.2 does not read; rows 5.2.x writes to it land in a separate legacy store and vanish again on re-upgrade.
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

**Adding an attribute to an existing system table** takes only the `systemSchema.json` entry, as long as the directive for the release that ships it runs `registerSystemSchemaAttributes` (`upgrade/systemSchemaAttributes.ts`). A fresh install creates each table from the schema, but an upgraded install keeps the catalog its table was created with, so before 5.4.0 every attribute added to `hdb_deployment` after 5.1.0 (`activated_from`, `install_fingerprint`) was missing there (#2659). The function compares every system table this node has with its schema entry and adds what the catalog lacks, indexed the way a fresh install indexes the legacy `{ "attribute": … }` form. It never removes or changes an attribute, so each release's directive can list it again; 5.4.0's is the first. An attribute whose table declares its own shape on every boot (`hdb_oidc_token_use`, the certificate verification tables) belongs in that declaration instead. `mount_hdb` and the directives hand `table()` a copy of each schema attribute list, because `table()` keeps the array it is given as the table's live attribute list: without the copy, dropping an attribute from a fresh install's table also dropped it from the in-process schema.

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

## RocksDB restore: the restore lock + marker protocol (`dataLayer/restoreMarker.ts`)

`restore_backup` closes the database on every thread, purges its directory and installs the backup.
What keeps that safe:

- **Nothing is purged until the backup verifies (harper#2965, `assertBackupReadable`).** `purgeAllFiles`
  deletes before it copies, so `backups.verify` (checksums, plus `verifyTables`: each table opened one
  at a time, the log snapshot validated strictly) runs first — in the repository, not a staged copy,
  since restores often run short of disk. Selection and every manifest-derived check run under the
  repository lock before the claim, so the backup checked is the one pinned. Verification is phase 0
  of the child's `apply-and-prove` on every route and retry; online it runs after the close and
  `verifyDatabaseClosed`, so no acknowledged write is lost to the purge. A crash before the marker
  leaves an `applying` receipt and no marker, dropped with its pin before startup loads anything
  (`finishCommittedRestoresBeforeStartup`); a failure after it leaves the marker for a rerun.
- **Metadata lives in the reserved `` `restore` `` directory beside the database directory**, keyed by
  `sha256(basename(dbPath)).slice(0,32)`. `<key>.lock` (an OS flock, released on death) serializes
  restores; `<key>.restoring`, fsynced immediately before the first destructive step
  (`markRestoreDestructive`), means destruction began and has not finished — its first line is the
  directory name, so the scan maps it back. Hashing avoids a database named `orders.restoring` and
  `NAME_MAX` at the 250-character name limit; the backtick is the one filesystem-legal character
  `schemaRegex` forbids, and the startup scan skips the entry (warning when it looks like a database,
  harper#2033). `scanBlockedRestores` probes the lock only when a marker exists: marker + held lock is
  in progress, marker + free lock is a crashed restore awaiting a rerun.
- **A recovery never clears a marker it found.** `claimRestore` samples `preexisting` under the lock;
  such a run failing before destruction keeps the marker, or a reload would publish the earlier
  attempt's partial directory.
- **Closure is verified, not assumed.** The restore `close` phase waits for every recipient — job
  workers included — to acknowledge or exit (else a retryable 409 after 30 s); the parent then polls
  the process-global `getRegistryStatus()` until the path has no instance. The close resolves names
  by directory and also closes any root a rescan detached from the catalog.
- **The close fences blob work, not just handles.** Blob roots live outside RocksDB and saves,
  reclamations and `cleanup_orphan_blobs` walks settle on their own, so each worker refuses saves
  under every name it holds the directory by, stops reclamation and orphan walks, awaits dispatched
  saves and unlinks, then closes and acknowledges. The fence records its restore's token: overlapping
  restores must not lift each other's fence, and a set would fence a dead restore's database forever.
  Lifting it discards the database's queued reclamations (they name paths the new generation reuses)
  unless the restore aborted before destruction, and happens before the reload's rescan, whose replay
  saves blobs.
- **A component-held database cannot be restored online; `on_restart` is the route.** rocksdb-js
  counts handles per path with no owner, so Harper cannot identify or close a component's handle.
  `verifyDatabaseClosed` waits `DATABASE_CLOSE_WAIT_MS` for a finished job worker's close, then 409s
  naming `on_restart=true` or the offline CLI; `system` is refused online up front. The CLI falls back
  offline only when the local server is stopped, and a saved loopback `last_target` does not prove this
  install, so destructive operations refuse rather than fall back (harper#2032).
- **Job workers close their handles on exit** (`closeLoadedDatabases` in `jobProcess`): an exiting
  thread otherwise leaks its refcount, and since `create_backup` is a job, every restore would fail its
  closure check.
- **The child stamps a new generation before proving it** (`stampDatabaseDirectory`,
  [database generation](../resources/DESIGN.md#database-generation-and-resumable-positions)).
- **Drop and restore share the lock.** `dropDatabase` takes the restore lock for every root, both
  engines, and publishes a `.dropping` marker beside each before deleting any — recording the root's
  blob identity and pinned blob paths under an integrity digest — removed only once every root and
  blob path is gone. Scans and opens reject a marked root and its whole graph; a retry re-enumerates the
  graph without the catalog, and re-attempts a worker close that failed strictly. A configured
  `databases.<name>.path` is the exclusive root of one graph. Every open runs under
  `withRestoreExclusion`, so the marker check and the open are one critical section;
  `throwIfBlockedByRestore` is only a cheap pre-check.
- **The child probes RocksDB's `LOCK` and fails closed**, since `purgeAllFiles` takes no lock and the
  offline route rests on a PID heuristic. Only a lock conflict (`isRocksDbLockError`, matched by message
  — rocksdb-js has no typed lock error) aborts with 409; any other open failure is what a restore
  recovers. The startup hook skips the probe so a corrupt directory stays replaceable.

Known limitation: the flock is process-owned, so a restore job thread that dies inside a live process
keeps restores at 409 until restart; its child dies with the IPC channel, and the child's own lifetime
lock blocks a claim until it has.

## Backup repository coordination: the management lock, pins, and the restore exclusion (`dataLayer/backupRepository.ts`)

- **The management lock.** rocksdb-js's `.backup.lock` covers only engine files, while blob snapshots
  and manifests are Harper's, so every Harper mutation takes `withBackupRepositoryLock` first and a
  create holds it across `db.backup()` and finalization (harper#2031). It waits 30 s, then 409s;
  maintenance stalling behind a large create is the accepted cost. `assertBackupStillPresent` remains
  for writers outside this protocol.
- **`purge_backups` names its ids first** — sorted by `backupId`, not by listing order — checks them
  against pins, then removes them in one call.
- **A pin lives exactly as long as its restore's lock, marker or receipt (`pinIsLive`).** A killed
  restore leaves both and its rerun clears both; a pin outliving them is ignored. Hence no owner, expiry
  or sweep: each would be a second answer to when a pin ends. A marked `target_database` is proved this
  source's debris by the marker's `source <sha256 of the resolved repository>` line
  (`assertTargetClaimable`), never by a pin, except a marker that predates the line (harper#3106); an
  admitted claim re-publishes the marker with its own source, and an in-place restore is always
  admitted. The lock is taken before the pin; pin ids derive from the target, or for a restart restore
  from its operation (`source_pin_id`), so a supersede can pin before releasing; the existence check
  and the pin are one step under the management lock.
- **The restoring marker is an exclusion, not a check.** `withRestoreExclusion` holds the restore lock
  shared across the marker check and the open; `checkRestoreState` probes shared, so concurrent
  rescans never read each other as `in-progress`. On an unwritable root it degrades to the marker check
  and warns once; any other failure propagates. A root already open is skipped.
- **The marker is published temp → fsync → rename → parent fsync**, and an intact one (first line equal
  to the directory name) is rewritten only to change its source.

## Restore publication: receipts and the publication boundary

Every route — online, offline, the restart route's startup hook — publishes through one protocol,
because copied files are no proof that the restored generation is usable.

- **Process boundary.** The parent (job worker, CLI, or main thread at startup) owns the lock, marker,
  pins, membership lock, every durable decision and publication. The child (`runRestoreChild`) runs
  verify → probe → purge → blobs → stamp → prove and returns bounded evidence, so a native abort on
  untrusted data costs the child. It takes the instance slot (one restore or verification child at a
  time) and the target's `<key>.child.lock`, waits for `authorize`, and re-reads the receipt: a child
  that outlived its parent or names another attempt exits untouched. Before its purge it sends
  `destroying` and waits while the parent publishes the marker, so the marker exists exactly when
  destruction may have begun. `acquireRestoreLock` refuses while the child lock is held.
- **Receipts (`<key>.intent`).** Written under the target's lock before anything destructive;
  `committed` (with the evidence) is written before the marker clears, and the receipt is deleted
  last. Clearing the marker is the publication boundary: before it a failure leaves the target blocked
  and rerunnable; after it the restore is only finished — marker, pins, job row, receipt — by the next
  claim (`finishOutstandingRestore`) or startup, never re-applied. Only the matching `operation_id`
  removes a receipt. One that is not committed, or unreadable, reserves its database as a marker does.
- **The proof.** Required column families come from a root-only open, checked against
  `requiredStoreNames`, the predicate `initStores` opens by (`openRestoredGeneration`). Replay runs
  with `policy: 'restore'` (no aged-log purge; any skipped entry, torn transaction, unreadable log or
  corrupt frame fails). `assessBlobReferences` decodes every record strictly; a reference with neither
  a file nor a capture marker fails unless `accept_unverified_blobs`.
- **Peers.** Every route refuses with replication peers (`hdb_nodes` rows other than this node, or
  `replication.routes`). Peer-adding operations hold `.replication-membership.lock` shared
  (`fenceMembershipChange` in `chooseOperation`, keys matched case-insensitively); a restore holds it
  exclusive from its peer check to the boundary. This relies on harper-pro's `add_node_back` also
  running through `chooseOperation`.
- **Restart route.** `on_restart` writes a `pending` receipt that keeps its source pinned, returns a
  `DeferredJobCompletion` (the row stays `IN_PROGRESS` with `deferred_to`), and restarts after draining
  HTTP workers. `recoverRestoresAtStartup` runs once per process, after `getTables()` and before any
  component, never from a worker-replacing reload. An attempt takes the pre-restore backup through
  `createPreRestoreBackup`, the one backup allowed past the reservation; `pre_restore_for` lets a retry
  adopt it. At `max_attempts` the receipt is `terminal`, which `loadRootComponents` turns into
  `HARPER_SAFE_MODE`. A committed receipt with no job row is finished before `system` loads
  (`bin/run.ts`), which is how a crashed offline `system` restore finishes. Where directory fsync is
  unsupported (Windows) the evidence says `durability: 'no-directory-fsync'`.

## Archive restore: a verified staged tree

- **Invariant.** An archive restore writes nothing into the database's backup repository but its
  rollback copy, and its staged source stays whole until publication. The child extracts to
  `<backupsRoot>/<db>/.staging/<id>/tree`, proves its logs and catalogue, reads every record and index
  entry (RocksDB checks block checksums on read; the tree has no backup checksums) and hashes every
  file into `inventory.ndjson`; `staged.json`, written last, makes the area a source
  (`source_kind: staged_tree`). The receipt's `rollback_dir` is the real repository.
- **Install, not engine restore.** `apply-and-prove` re-hashes the tree and checks each destination
  device's room (copies only; a purge is credited only for single-link files) before destruction, then
  hard-links write-once files (`*.sst`, `*.blob`, Harper blob files) where it can and copies the rest
  — and everything across devices, such as a mounted `.staging` — through a temp name with its hash
  checked, `CURRENT` last, everything fsynced. Because the tree is never consumed, any failure, even
  after the proof mutated the target, reruns by purging and installing again.
- **Sources.** A `server_path` archive is read in place, and only when `server_path_identity` (device,
  inode, size, mtime) matches — a remote caller cannot know those, so a match proves a shared
  filesystem; otherwise 412 before any job exists, and the CLI uploads. An upload is spooled into
  thread-owned staging before the job row exists; `url`/`s3` are fetched by the child (`safeFetch`:
  https only, address-pinned, redirects re-validated). Harper removes only `<id>` entries of `.staging`.
- **Staging lives as long as a live pin in it** (`hasLivePin`). A failed attempt that began destroying
  its target keeps its only source — `cancel` drops the receipt but keeps marker and pins — and a rerun
  takes the target over and releases the earlier area once it publishes. Every sweep skips pinned
  areas, and an area is fsynced before a receipt can name it.
- **The disk ledger (`diskLedger.ts`)** charges each device by `statfs` id, re-basing only on a sample
  newer than both the last sample and the last charge; the writer's `ENOSPC`/`EDQUOT` stays
  authoritative.
- **Credentials.** S3 takes only a `processEnv` secret reference, resolved by a thread with custody; a
  presigned URL reaches the job only as a transient, never the job row, and `url`/`s3`/`payload` never
  reach the operation log.

## RocksDB managed backups: blob snapshots (`dataLayer/blobBackup.ts`)

Restore admission rechecks the source under the management lock, then `claimRestore` takes the
destination lock and durably writes the source claim; the marker follows just before the purge.
`immutable_source` is the one exception: the operator asserts nothing modifies the repository until
the restore finishes, so it takes no management lock and writes nothing there
(`withBackupRepositoryReadAccess`), which lets it read read-only media; the marker's source line proves
the rerun's ownership. rocksdb-js `backups.restore` tolerates its shared `.backup.lock` only on
`EROFS`, so `EACCES` still fails. Delete and purge reconcile Harper's files even after an engine
failure, propagating a cleanup failure only when the engine succeeded.

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
- **`archive_schema_version` is the major; `archive_schema_minor` is informational.** Additive
  fields bump the minor, which no reader gates on. A reader refuses only a newer major.
- **A manifest that predates this is accepted, not refused.** A managed backup written without a
  `producer` block came from this instance's own lineage, so it is reported as unidentified. A
  manifest that is present but malformed is an error — that is a different situation, and only the
  first is eligible for an operator's provenance override.
- **`accept_incompatible_backup` is that override.** A super-user boolean on `restore_backup`
  (online, offline, CLI). It waives only the newer-major refusal, never an unsupported `requires`
  token, which names a format this build cannot read. A waiver is logged at `warn` with the
  producer's `harper_version`/`rocksdb_js_version` and returned as `compatibility_waived`.

## Legacy SQL pre-fetch narrows only by top-level AND conjuncts (`dataLayer/SQLSearch.ts`)

The legacy executor loads each WHERE column into one row pool (a union across columns, null where a
row was not fetched for a column) and lets AlaSQL evaluate the WHERE over that pool.
`_conditionsToFetchAttributeValues` may narrow a column's fetch to the values a predicate names only
when every result row must satisfy that predicate: a leaf of the top-level AND chain, parentheses
transparent. A predicate under `NOT` or inside any other expression must see every row, or the rows
it rejects never reach AlaSQL and the negation runs over the wrong set (`NOT (c = 'alpha')` returned
nothing, #1397 §D). Two blunter guards stay: any `OR` disables narrowing, and so does a self-join,
because the narrowing maps are keyed by physical table, not alias. Under the default `auto` engine
parenthesized predicates are handled by `sqlEngine` v2, so only queries v2 still rejects (such as
`IIF(...)` or standalone unindexed predicates) fall back here. Enforced by
`unitTests/dataLayer/SQLSearch.test.js` and `integrationTests/database/sql-not-predicate.test.ts`.

## SQL preserves sharding recovery refusals (`dataLayer/SQLSearch.ts`)

An incomplete owner may return present bodies, but it must refuse owned misses and collection
reads until its baseline is certified. SQL fetch and result-stage wrappers preserve
`DatabaseShardingHeldError` and permanent `DATABASE_SHARDING_BLOCKED` refusals, including their
503 status, retryable flag, and recovery or restart reason.
Replacing it with a generic search error hides the operator action required to resume reads.
`ResourceBridge.getRecords` also preserves this refusal instead of returning a message row,
settling its transaction before rejecting `next()`. Unexpected SQL failures retain the existing
generic response. Real baseline guards exercise
scan, key, predicate, and aggregate query shapes in `unitTests/resources/shardingBaseline.test.js`;
the Pro bootstrap suite checks the operations HTTP response after a lost origin is diagnosed.

The unclean-exit fixture also checks permanent quarantine through scan, key, and legacy `IIF`
queries before and after a worker starts with repaired configuration.
