# dataLayer/ — Design notes

Backup and restore, version gating, system-table bootstrap, storage migration and the legacy SQL executor.

**Read this when:** touching `rocksdbBackup.ts`, `restoreMarker.ts`, `blobBackup.ts`, `hdbInfoController.ts`, `bin/copyDb.ts`, `json/systemSchema.json` or `SQLSearch.ts`.

Index of every design note: [DESIGN.md](../DESIGN.md).

---

## Version gate at startup: downgrades prompt, and only the minor direction is confirmable

`getVersionUpdateInfo()` (`dataLayer/hdbInfoController.ts`) compares the store's `data_version_num` (latest `system.hdb_info` record) with the binary's version on every start. Data newer by a **major** is refused; newer by a **minor**, `forceDowngradePrompt()` asks, and yes records the data version down and boots (upgrade directives are additive and downgrade-compatible — see [Struct mode is gated to primary DBIs](../resources/DESIGN.md#struct-mode-is-gated-to-primary-dbis-downgrade-compatibility) and `patchHdbSecretIsHashAttribute` in `upgrade/directives/5-2-0.ts`).

- `CONFIRM_DOWNGRADE` (env var or `--CONFIRM_DOWNGRADE`; argv wins, `assignCMDENVVariables`) answers non-interactively. With no override and no TTY the prompt throws rather than blocking (#2046). `upgradeCertsPrompt()` has the same guard, honoring `GENERATE_CERTS` first. Upgrades never prompt (`bin/upgrade.ts`).
- Enforced by `integrationTests/upgrade/minor-downgrade.test.ts` against each release in `HARPER_PREVIOUS_MINOR_PATH`. Known exception (#3102): a table created on 5.3.0+ reads as empty on 5.2.x, and rows 5.2.x writes to it vanish on re-upgrade.
- A suite that sets the override through `process.argv` leaks it to later files in the same mocha process; save and restore it (`unitTests/dataLayer/hdbInfoController.test.js`).

## Opening a source LMDB DBI for migration must thread through `compression`

When `migrateOnStart` opens a source LMDB primary store for the RocksDB copy, it must set `dbiInit.compression = attribute.compression` from the `__dbis__` entry before `sourceRootStore.openDB(key, dbiInit)`, as `databases.ts` does. Without it lmdb-js installs no decompression layer, msgpackr misreads compressed bytes in `0x40–0x7F` as shared-structure refs, and `loadStructures` recurses into a stack overflow.

The persisted `compression` is LMDB-shaped: falsy (`''`, `false`, `null`) when disabled, `{ startingOffset, threshold, dictionary? }` when enabled. rocksdb-js >= 2.6 rejects `''` and booleans and treats unset as "keep the family's codec, or lz4". So every RocksDB open takes the one per-process codec, `getRocksCompression()` (inside `openRocksDatabase`; see [The RocksDB codec is a deployment setting, resolved once per process](../resources/DESIGN.md#the-rocksdb-codec-is-a-deployment-setting-resolved-once-per-process)), derived by `toRocksCompression()`; never pass persisted attribute compression to a RocksDB open. `bin/copyDb.ts`'s `openRocksDb` applies the same codec, because a full migration is the one moment the whole dataset is written, and files written uncompressed stay so until rewritten.

## System table bootstrap: `systemSchema.json` + upgrade directive

A new system table needs three changes:

1. **`json/systemSchema.json`** — the entry; fresh installs create it in `utility/mount_hdb.ts:createTables()`.
2. **`utility/hdbTerms.ts`** — the name in `SYSTEM_TABLE_NAMES`.
3. **`upgrade/directives/<version>.ts`** — provisions it on existing installs; registered in `directivesController.ts`, each module default-exporting `{ version, sync_functions, async_functions }` (copy `5-1-0.ts`, which uses `bridge.createTable` as `mount_hdb` does).

   **Version the directive to the first release that ships the dependent code.** Directives run only when `current_version < directive_version <= upgrade_version` (`getVersionsForUpgrade`); `hdb_deployment`'s, mis-tagged `5.2.0` for code shipped in `5.1.0`, never ran on `5.0.x -> 5.1.x`, breaking replicated `deploy_component`. `compareVersions` sorts a pre-release above its GA, so an install on `5.1.0-beta.x` never runs a `5.1.0` directive.

Set `audit = true` on the directive's `CreateTableObject`: `createTables()` audits every system table on a fresh install, so a directive without it makes upgraded nodes diverge. System tables replicate unless named in `NON_REPLICATING_SYSTEM_TABLES` (`resources/databases.ts`).

**Adding an attribute to an existing system table** needs only the schema entry, provided the shipping release's directive runs `registerSystemSchemaAttributes` (`upgrade/systemSchemaAttributes.ts`): an upgraded install keeps the catalog its table was created with (#2659). It adds what each catalog lacks, never removes or changes, so every directive can list it again. `mount_hdb` and the directives pass `table()` a copy of each attribute list, since `table()` keeps the array as the live attribute list.

**A replicated system table whose owner declares more than a name list** (a table-level `expiration`, an index) needs that declaration on every node, every boot. `hdb_oidc_token_use` is the case: `security/authn/oidc/tokenUseTable.ts` holds its one definition, which `bin/run.ts initialize()` applies after the upgrade step and before workers start, as do the 5.3.0 directive and the exchange path. Rows carry their expiry as record metadata, which replication applies; the table's `expiration` arms the cleanup scan. Every other route to a copy leaves it partial:

- A node not yet upgraded gets the table from a peer's `DB_SCHEMA` handshake, which carries names, types and the primary key but never `indexed`, `expiresAt` or `expiration`, and no peer repairs it afterwards; the directive then finds the table present.
- A node that never runs the owner's code path never declares the rest, and its replicated rows are never removed.
- An install on a pre-release of the directive's version never runs it (the `compareVersions` caveat).

Repeating a local `table()` declaration repairs any of these in place, keeping every row, and is a no-op once the shape matches. Storage-layer limit: a dropped attribute's index store stays on disk, since `table()` looks it up by table name. The certificate verification tables follow the same pattern through `security/certificateVerification/verificationTables.ts`; their rows are covered in security/DESIGN.md.

## RocksDB restore: the restore lock + marker protocol (`dataLayer/restoreMarker.ts`)

`restore_backup` closes the database on every thread, purges its directory and installs the backup.
What keeps that safe:

- **Nothing is purged until the backup verifies (harper#2965).** `purgeAllFiles` deletes before it
  copies, so `backups.verify` (checksums, plus `verifyTables`) runs first, in the repository, as phase
  0 of the child's `apply-and-prove` on every route and retry. Selection and manifest checks run under
  the repository lock before the claim, so the backup checked is the one pinned. Online it runs after
  the close and `verifyDatabaseClosed`, so no acknowledged write is lost to the purge.
- **Metadata lives in the reserved `` `restore` `` directory beside the database directory**, keyed by
  `sha256(basename(dbPath)).slice(0,32)` (avoiding name clashes and `NAME_MAX`). `<key>.lock`, an OS
  flock, serializes restores; `<key>.restoring`, fsynced just before the first destructive step
  (`markRestoreDestructive`), means destruction began and has not finished, and its first line maps it
  back to the directory. The backtick is the one filesystem-legal character `schemaRegex` forbids; the
  startup scan skips the entry (harper#2033). Marker + held lock is in progress; marker + free lock is
  a crashed restore awaiting a rerun (`scanBlockedRestores`).
- **A recovery never clears a marker it found.** `claimRestore` samples `preexisting` under the lock;
  such a run failing before destruction keeps it, or a reload would publish the partial directory.
- **Closure is verified, not assumed.** The `close` phase waits for every recipient, job workers
  included, to acknowledge or exit (else a retryable 409 after 30 s); the parent then polls
  `getRegistryStatus()` until the path has no instance.
- **The close fences blob work, not just handles.** Each worker refuses saves under every name it
  holds the directory by, stops reclamation and orphan walks, awaits dispatched saves and unlinks, then
  acknowledges. The fence records its restore's token, so overlapping restores cannot lift each
  other's. Lifting it discards queued reclamations (their paths are reused) unless the restore aborted
  before destruction, and precedes the reload's rescan, whose replay saves blobs.
- **A component-held database cannot be restored online.** rocksdb-js counts handles per path with no
  owner, so `verifyDatabaseClosed` waits `DATABASE_CLOSE_WAIT_MS`, then 409s naming `on_restart=true`
  and the offline CLI; `system` is refused online up front. The CLI falls back offline only when the
  local server is stopped, and a saved loopback `last_target` does not prove this install, so
  destructive operations refuse rather than fall back (harper#2032).
- **Job workers close their handles on exit** (`closeLoadedDatabases` in `jobProcess`), or every
  restore after a `create_backup` job would fail its closure check.
- **The child stamps a new generation before proving it** (`stampDatabaseDirectory`,
  [database generation](../resources/DESIGN.md#database-generation-and-resumable-positions)).
- **Drop and restore share the lock.** `dropDatabase` takes the restore lock for every root and
  publishes a `.dropping` marker (blob identity and pinned blob paths under a digest) before deleting
  any, removed once every root and blob path is gone. Scans and opens reject a marked root's whole
  graph, and a retry re-enumerates the graph without the catalog. A configured `databases.<name>.path`
  is the exclusive root of one graph. Every open runs under `withRestoreExclusion`, so the marker check
  and the open are one critical section; `throwIfBlockedByRestore` is only a cheap pre-check.
- **The child probes RocksDB's `LOCK` and fails closed**, since `purgeAllFiles` takes no lock and the
  offline route rests on a PID heuristic. Only `isRocksDbLockError` (matched by message) aborts with
  409; any other open failure is what a restore recovers.

Known limitation: the flock is process-owned, so a restore job thread that dies inside a live process
keeps restores at 409 until restart; its child dies with the IPC channel, and the child's own lifetime
lock blocks a claim until it has.

## Backup repository coordination: the management lock, pins, and the restore exclusion (`dataLayer/backupRepository.ts`)

- **The management lock.** rocksdb-js's `.backup.lock` covers only engine files, so every Harper
  mutation takes `withBackupRepositoryLock`, and a create holds it across `db.backup()` and
  finalization (harper#2031). It waits 30 s, then 409s.
- **`purge_backups` names its ids first**, sorted by `backupId`, checks them against pins, then
  removes them in one call.
- **A pin lives exactly as long as its restore's lock, marker or receipt (`pinIsLive`)**, so it needs
  no owner, expiry or sweep. A marked `target_database` is proved this source's debris by the marker's
  `source` line (`assertTargetClaimable`), never by a pin, except a marker that predates the line
  (harper#3106); an in-place restore is always admitted. The existence check and the
  pin are one step under the management lock. A rerun over an interrupted attempt retires the
  inherited pins (`superseded_pin_ids`) only once its own source has proved: until then the earlier
  backup may be the blocked database's only recovery source.
- **The restoring marker is an exclusion, not a check.** `withRestoreExclusion` holds the restore lock
  shared across the marker check and the open; `checkRestoreState` probes shared. On an unwritable root
  it degrades to the marker check and warns once.
- **The marker is published temp → fsync → rename → parent fsync**, and an intact one is rewritten
  only to change its source.

## Restore publication: receipts and the publication boundary

Online and offline restores publish through one protocol, because copied files are no proof that the
restored generation is usable.

- **Process boundary.** The parent (job worker or CLI) owns the lock, marker, pins, membership lock
  and every durable decision. The child (`runRestoreChild`) runs verify → probe → purge → blobs → stamp
  → prove, so a native abort on untrusted data costs only the child. It takes the instance slot and the
  target's `<key>.child.lock`, waits for `authorize`, and exits untouched if its receipt names another
  attempt. It sends `destroying` and waits for the marker before its purge, so the marker exists
  exactly when destruction may have begun.
- **Receipts (`<key>.intent`).** Written under the lock before anything destructive; `committed`, with
  the evidence, before the marker clears; deleted last, only by its `operation_id`. Clearing the marker
  is the publication boundary: before it a failure leaves the target blocked and rerunnable; after it
  the restore is only finished, by the next claim (`finishOutstandingRestore`) or startup, never
  re-applied. Online, the job reads `COMPLETE` only after the reload broadcast returns. A receipt not
  committed, or unreadable, reserves its database as a marker does.
- **The proof.** Required column families are checked against `requiredStoreNames`
  (`openRestoredGeneration`); replay runs with `policy: 'restore'`, failing on any skipped entry, torn
  transaction or corrupt frame; `assessBlobReferences` decodes every record strictly, and a reference
  with neither a file nor a capture marker fails unless `accept_unverified_blobs`.
- **Derived indexes are rebuilt, not restored.** A backup never holds a native index file (an HNSW
  plane, a full-text directory). The proof's generation starts no derived index
  (`openRestoredGeneration`): one would write into the generation being proven and still run after its
  close. An HNSW index's node mappings and cursor live in RocksDB, so they come back without the plane
  they name; once published, the index rebuilds at its first ownership (`derivedStorageLost`).
- **Peers.** Every route refuses with replication peers (`hdb_nodes` rows other than this node, or
  `replication.routes` as this process started with them); an offline `system` restore checks routes
  only. While `system` is restore-blocked the census refuses rather than read it. Peer-adding
  operations hold `.replication-membership.lock` shared (`fenceMembershipChange`); a restore holds it
  exclusive from its peer check to the boundary. Startup finalizers publish without it (#4043). This
  relies on harper-pro's `add_node_back` also running through `chooseOperation`.
- **Startup.** `finishCommittedRestoresBeforeStartup` (`bin/run.ts`) finishes committed receipts with
  no job row before `system` loads, and drops `applying` receipts with no marker (never a restart
  receipt, which is its request). `recoverRestoresAtStartup` runs once, first on the main thread in
  `loadRootComponents` (before secret custody, application install or any component, never from a
  worker-replacing reload), settling the rest and running restart restores. Without directory fsync
  (Windows) the evidence says `durability: 'no-directory-fsync'`.

### Restart restores (`dataLayer/restoreIntent.ts`)

A database a component holds cannot be closed while the server runs, so `on_restart=true` records the
restore and the next startup applies it, before anything can open the target.

- **Request.** Under the membership fence and the target's lock: a `pending` receipt with its source
  pinned under its own operation id (`restore-intent-<id>`). The job returns a `DeferredJobCompletion`:
  the row stays `IN_PROGRESS` with `deferred_to`, and the drained restart is requested only after that
  row is written. A supersede (another `backup_id` with `on_restart`) inherits the displaced receipt's
  pins as `superseded_pin_ids`, retired only when the successor commits, and its rollback copy.
- **Job ownership.** The receipt, not the row, decides the outcome. The boot sweep skips the job ids
  `recoverRestoresAtStartup` returns, and `settleAbandonedJob` skips a `deferred_to` row only while
  `restoreReceiptOwnsJob` finds an uncommitted receipt naming it, so a crash between receipt and row
  cannot strand a job.
- **Drain.** `bin/restart.ts` with `drain` runs `shutdownProcess(deadline)`, the path a SIGTERM takes,
  so main-thread components flush too (`threads.count=0`); the exit watchdog adds
  `threads.shutdownTimeout`.
- **Attempt.** Counted before any native work. Peers are re-checked under the fence (`terminal` if
  any). A `pending` receipt with `retain_previous` takes the pre-restore backup in the restore child
  (`createPreRestoreBackup`, the one backup allowed past the reservation; `pre_restore_for` lets a
  retry adopt it) and pins it. Then `applyProveAndCommit`, the step online and offline restores share,
  with the engine-lock probe on: it aborts only on a lock conflict, so a corrupt old directory stays
  replaceable.
- **Failure never exits.** The receipt keeps its error and the target stays blocked; the next restart
  or `resume` retries, and at `max_attempts` it is `terminal`. A `terminal` restart receipt, one whose
  marker shows destruction began, or one whose rollback copy has started but is not applied starts that boot in safe
  mode (`unpublishedRestoreBlocksComponents`): a component that opens RocksDB itself ignores the
  marker, and a write it makes after the copy would be replaced uncaptured by the next attempt.
  `cancel` removes a receipt, keeping marker and pins once destruction began; if a boot already held the
  database, it then restarts (`JobCompletion`) so the components that loaded without it load.

## RocksDB managed backups: blob snapshots (`dataLayer/blobBackup.ts`)

`immutable_source` takes no management lock and writes nothing in the repository
(`withBackupRepositoryReadAccess`): the operator asserts nothing modifies it until the restore
finishes, and the marker's source line proves a rerun's ownership. rocksdb-js `backups.restore`
tolerates its shared `.backup.lock` only on `EROFS`. Delete and purge reconcile Harper's files even
after an engine failure.

File-backed blobs live in roots outside the RocksDB directory (`getBlobPathsForDatabaseName`), so the
engine's backup misses them; every backup operation handles them alongside (`exclude_blobs` opts out):

- **Managed backups** snapshot each root to `<backupDir>/blobs/<backupId>/<rootIndex>/<relpath>`, a
  full copy per backup, built in a `<backupId>.tmp` sibling and renamed. Complete blobs and abort
  markers are hard-linked (published blob paths are write-once), `.repair` temporaries are omitted,
  an incomplete blob becomes a PENDING (`0xfe`) marker, and one that vanished after classification an
  ERROR (`0xff`) marker, so a snapshot inode never changes as a live write finishes.
- **`get_backup`** appends the blobs under `blobs/<rootIndex>/<relpath>` through one assembly
  (`streamBackupArchive`), since `harper-backup.json` must be the first entry. It asks the binding for
  a plain tar, withholds its 1024-byte trailer (verified all-zero), appends with `tar-stream`, and
  gzips the result itself.
- **A consumer that aborts must tear the native producer down**, or the binding waits on an undrained
  tar forever, holding the snapshot open; the rejection handler destroys the native stream itself.
  **A native producer rejection must terminate both streams** with the original error.

**Completion manifest (`dataLayer/backupManifest.ts`).** The engine backup is visible before the blob
snapshot is copied, so `<backupDir>/manifests/<backupId>.json`, recording the blob policy, is written
atomically only after both phases are durable; a failed snapshot rolls the engine backup back. A
backup with no manifest is incomplete: `list_backups` hides it and `verify_backup`/`restore_backup`
reject it. Restore uses the manifest's `blobs` flag, not a snapshot directory's presence. Engine/blob
point-in-time skew remains best-effort: blob writes are not frozen.

**Archive manifest (`dataLayer/backupArchiveManifest.ts`).** `harper-backup.json` is every
`get_backup` archive's **first** entry (a trailing one would cost inflating the whole `.tar.gz`), and
a completion manifest's optional `producer` block.

- **Compatibility is a capability list, not a version comparison.** A reader refuses any `requires`
  token outside `SUPPORTED_ARCHIVE_CAPABILITIES`; versions and the `source` block are provenance,
  **never** gated on. Submission and execution share `resolveCompleteBackup`, so an incompatible
  producer gets a 4xx before a job is queued.
- **`roles: null` means "not enumerated".** Enumeration reads the loaded `system` rather than calling
  `getDatabases()`, which offline would open and lock every database.
- **`archive_schema_version` is the major** a reader refuses when newer; `archive_schema_minor` is
  informational. A manifest with no `producer` block is accepted as unidentified; a malformed one is an
  error.
- **`accept_incompatible_backup`** waives only the newer-major refusal, never an unsupported token; the
  waiver is logged at `warn` and returned as `compatibility_waived`.

## Legacy SQL pre-fetch narrows only by top-level AND conjuncts (`dataLayer/SQLSearch.ts`)

The legacy executor loads each WHERE column into one row pool and lets AlaSQL evaluate the WHERE over
it. `_conditionsToFetchAttributeValues` may narrow a column's fetch only by a leaf of the top-level AND
chain, which every result row must satisfy; a predicate under `NOT` or inside another expression must
see every row (`NOT (c = 'alpha')` returned nothing, #1397 §D). Any `OR` or self-join disables
narrowing, since the maps are keyed by physical table. Under the default `auto` engine only queries
`sqlEngine` v2 rejects fall back here. Enforced by `unitTests/dataLayer/SQLSearch.test.js` and
`integrationTests/database/sql-not-predicate.test.ts`.

## SQL preserves sharding recovery refusals (`dataLayer/SQLSearch.ts`)

An incomplete owner must refuse owned misses and collection reads until its baseline is certified. SQL
fetch and result-stage wrappers, and `ResourceBridge.getRecords`, preserve `DatabaseShardingHeldError`
and `DATABASE_SHARDING_BLOCKED` with their 503 status, retryable flag and reason; a generic search
error would hide the operator action required. Exercised in `unitTests/resources/shardingBaseline.test.js`
and the Pro bootstrap suite.
