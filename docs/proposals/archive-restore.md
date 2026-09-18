# Restoring a `get_backup` archive into a running Harper (incl. Fabric)

Design note. Tracked as [#2632](https://github.com/HarperFast/harper/issues/2632) with one issue per §9 item. Supersedes the rationale on
[#995 `import_backup` operation](https://github.com/HarperFast/harper/issues/995), closed
2026-07-31 with "at this time, we don't want to introduce restoring backups while Harper is
running"; [#1831](https://github.com/HarperFast/harper/pull/1831) landed `restore_backup` doing
exactly that the following day.

## Planning-review history

| round                            | verdict                 | what it changed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 (`88498550c`)                  | `chosen-approach-sound` | Framing cleared; seven blockers against under-specification. Adopted: the marker is not a journal, blob staging must be per-volume, the retained database must be scan-invisible, validation must await strict replay because the load path does not, intake cannot be a standard job operation, super-user must be enforced in the handler (§5.1), and archive limits must bound entries/inodes, not only bytes (§5.4). Also adopted: refuse-on-peers does **not** close #2451 (§5.9), engine-only replacement restores must be refused (§5.4), and pre-manifest archives need a decided policy rather than an open question (§7.1). §7.2 was demoted — its one-boot fix was wrong. Two citations overruled: a `DESIGN.md:250-254` reference that does not exist, and #2031 as a hard dependency.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2 (`ddef36c7f`)                  | `approach-changed`      | The rename-swap protocol is withdrawn (§4): an extracted archive already _is_ a database directory and two existing calls turn one into a managed backup, so the chosen approach is `import_backup` into the managed repository plus a restart route on `restore_backup` — which Fabric needs today for component-held databases regardless of archives (§1). Consequences: no journal, no per-volume rename protocol, no new reclamation operation (§5.6, §5.8); create-if-absent and `target_database` go back online (§6); the validator is split into an engine-level out-of-process pass and an elected strict replay at publication, because a replay writes and needs the resource layer (§5.5, §5.7); the startup hook moves to after `getTables()` because `hdb_nodes` lives in `system` (§5.7); the intake lock moves off the HTTP worker thread (§8); a pull source is added (§5.2). Resolved `verify:` items: no drain on `restart`, `HARPER_SAFE_MODE` exists, the multipart path bypasses `bodyLimit` (likely), `backups.verify` does not cover Harper indexes. One citation overruled: #2046 does not record a one-way upgrade (§7.1). Two pre-existing defects surfaced: no boot-time job reconciliation exists (§7.5), and `restore_backup` applies an engine-only backup over live blobs with only a log warning (§7.6).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 3 (codex `gpt-6-astra`, `xhigh`) | `chosen-approach-sound` | Architecture upheld; eleven findings against the protocol, all adopted. The intent is now a durable state machine whose `committed` record is written **before** the discovery block lifts, so reconciliation can never re-apply a restore (§5.6, §5.7, §10). The recovery source is **pinned**: `delete_backup`/`purge_backups` refuse ids a pending intent names (§5.6, §7.3). Elected replay gets a restore-strict policy — skipped or discarded entries fail publication (§5.7). Blob completeness is decided, not open: replacement restores run the reference scan or record an explicit waiver (§5.7, §11). Online create-if-absent takes the restore marker as a **name reservation** before the first byte and holds it through validation, which is a shared publication protocol both routes use (§6). The old destination is probed and purged **out of process** too, and a failed attempt never exits for a retry — self-managed installs have no supervisor (§5.7). Repository operations must work without a loaded database, and the terminal state gets `resume`/`supersede`/`cancel` (§5.5, §5.6). The peer check reads `hdb_nodes` and `replication.routes` from core, so no pro predicate is needed before plugins load (§5.9). The continuous disk gate debits bytes between quota samples, which refresh only every ~90 s (§5.3). The pre-restore backup moves to the boot hook so it captures the final state after the last acknowledged write (§5.8). Inline pull credentials are rejected in favour of secret references or presigned URLs (§5.2). Corrections: in-place restores keep existing grants (§5.10); the archive carries no role catalogue, so the manifest gains role names (§7.1); the disk table now states total occupancy (§4); §7.6 is a dependency of replacement imports, not adjacent (§9).                                                                                                                                                                                                                                                                                                                                                                  |
| 4 (codex `gpt-6-astra`, `xhigh`) | `chosen-approach-sound` | Architecture upheld again; eleven findings on the protocol's crash windows and exclusion gaps, all adopted. The pre-restore backup is captured only while `pending` and never repeated on an `applying` retry, because `createBackupOffline` refuses a marked database (§5.7). The apply step is split from finalization so the marker survives a failed validation and a `cancel`, and finalization after `committed` is idempotent and owns the marker clear (§5.7, §10). Durability barriers on every volume — restored blobs, manifests, the closed engine — precede the `committed` write, and platform limits are stated (§5.7). The marker becomes a real reservation: openers hold the per-database lock **shared** across check-and-open, restore holds it exclusive, discovery re-checks per open, and the absence check moves after the reservation (§6). Pins are installed inside a per-repository management lock that also covers delete/purge admission and blob/manifest finalization — the minimum of #2031, now a prerequisite (§5.6, §7.3). The disk gate becomes one ledger across staging, conversion, retention and restore, and `getStorageSpaceStats` must expose the sample time (§5.3). The publication check compares the physical column-family inventory against the catalogue before any create-capable open, because `initStores` recreates missing families as empty stores (§5.5, §5.7). The boot hook skips the `LOCK` probe, which is the only way a corrupt old directory can ever be replaced (§5.7). Staging is adopted by the main thread before the job is enqueued (§8). Online restores fence `add_node`/route changes during the reservation and re-check peers before publication (§5.9, §6). Online replay runs in the job worker, never on a serving thread (§6). §7.6 now gates items 5 and 6, not only imports, under one API rule (§9).                                                                                                                                                                                                                                                                                                                   |
| 5 (operator review)              | n/a                     | Where the uploaded bytes land was implicit. Answered and made explicit (§5.4): never `os.tmpdir()` — the multipart part is a `Readable` streamed into gunzip + tar-fs with no temp spool — and staging derives from `storage.backupPath`, whose default `<hdb_root>/backup` is the Harper home directory and the wrong volume for a database large enough to need this. A `storage.importStagingPath` setting was proposed and then **withdrawn**: no config parameter is live-reloadable (#2377 hot-reloads the models block, not storage paths), and the staging path does not need to be — `<backupsRoot>/<db>/.import` is already a stable per-database location an operator can mount attached storage onto while Harper runs. Adopted instead: the mount-point invariants — never create or remove `.import` itself, group the disk ledger by `statfs` device rather than path prefix, accept the `EXDEV` blob copy, and record and re-check the staging device so an unmounted mount point cannot quietly fill the OS volume. Corrected: the old database is not moved anywhere — round 1's retained displaced tree went away with the rename swap, and `purgeAllFiles` destroys it in place against the pre-restore backup as the rollback source, so nothing but staged archives belongs in `.import` (§5.4, §5.7, §5.8). New defect surfaced (§7.7): re-pointing `storage.backupPath` reports an empty repository rather than an abandoned one, and silently abandons item 4's lock and pins with it — now work item 10. Also adopted: the exact extracted size is computable from tar headers and Harper computes it rather than trusting the client — rounded up to the staging device's `statfs` `frsize` (not a hardcoded 4096, since `.import` may be a mount and ZFS `recordsize` reaches 128K), with directories counted and a separate inode budget from `ffree`, because bytes and inodes exhaust independently. Pull fetches to disk and pre-tallies in a second inflate; push stays single-pass and debits the ledger per entry in whole blocks, since gzip is not seekable and a pre-tally there would mean persisting the compressed archive and inflating twice (§5.2, §5.3, §5.4). |

Every behavior claim below is traced in the working tree at `1c312feb4` (`origin/main`), plus
harper-pro's `replication/` for §5.9 and `node_modules/@harperfast/rocksdb-js` (2.9.1) for the
binding's documented contracts. Claims I could not trace are marked `verify:` and are not
load-bearing for the chosen design.

## 1. The problem

`get_backup` streams a full point-in-time snapshot of a database as `.tar` / `.tar.gz`
(`createBackupStream`, `dataLayer/rocksdbBackup.ts:689`). There is no operation that consumes one.
The archive's own embedded README (`streamedBackupReadme`, `dataLayer/rocksdbBackup.ts:928`) tells
the operator to stop Harper and hand-copy files into the database directory and each blob root.

That is the only documented restore route for the artifact, and three properties make it unusable
on Fabric:

- **No filesystem access.** The archive is on a laptop; Harper runs in a managed container. No
  operation accepts an archive, and `harper-pro` adds no backup surface of its own — the whole
  implementation is in `core/`.
- **Restore-into-a-copy is offline-only.** `target_database` is rejected outright while Harper is
  running (`dataLayer/rocksdbBackup.ts:500`, and again at `:537`), so the non-destructive route is
  unreachable on a live tenant.
- **"Stop the server" is not an operator action.** `verifyDatabaseClosed`
  (`dataLayer/rocksdbBackup.ts:624`) forces the offline CLI path whenever a loaded component holds
  a handle, and always for `system`. On Fabric, stopping Harper is a host-manager action.

The third property is not specific to archives. Any database a component declares tables in is
component-held, so on Fabric `restore_backup` itself cannot restore the databases people actually
use; the 409 it returns points at a CLI the operator cannot run. That gap in #1831's Fabric story
is the common core of this work (§5.6), and it is worth closing before any archive is imported.

## 2. What already exists

Nearly all of this is assembly. Traced:

| Need                                   | Existing primitive                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Archive → managed backup               | `RocksDatabase.open(dir)` then `db.backup(repo, { transactionLogs: true })` — exactly what `createBackupOffline` does against a closed database directory (`dataLayer/rocksdbBackup.ts:959-990`). rocksdb-js documents the other half: a stream backup "unpacks with any tar tool into a directory that opens directly as a RocksDB database" (`docs/backups.md`, "Stream backups → Restoring")                                                                                                                                                                                                                                                               |
| Managed restore protocol               | lock + marker, close broadcast, `verifyDatabaseClosed`, `backups.restore(purgeAllFiles)`, index-aware blob restore — `restoreBackup` (`dataLayer/rocksdbBackup.ts:530`); the offline form `restoreBackupOffline` (`:999`) also handles `system` and `target_database`, and is rerunnable after a crash because its source persists                                                                                                                                                                                                                                                                                                                            |
| Backup verification                    | `verify_backup` → `backups.verify` — file sizes, optional checksums, and strict transaction-log framing via `validateTransactionLogStore` (rocksdb-js `README.md:2471`). Does **not** cover Harper's index structures. Like `list`/`delete`/`purge`, the operation form requires a loaded database (`requireRocksRootStore`, `:308-337`, `:473`); only the offline functions work from the directory alone                                                                                                                                                                                                                                                    |
| Pre-publication strict replay          | the branch claim: `initStores(path, root, name, { destination, storeName, openedStores })` builds Table classes privately, then `replayLogs(root, tables, /* elected */ true)` is awaited and rejects on a failing tail before the branch is published (`resources/databases.ts:992-1008`, `resources/replayLogs.ts:47-60`, `resources/branchDatabase.ts`). Elected mode still tolerates undecodable entries (§5.7)                                                                                                                                                                                                                                           |
| Name reservation                       | the restore marker: `beginRestore(dir)` takes the per-database lock and writes the marker; the scan skips the name (`databasesBlockedByRestore`, `resources/databases.ts:577`, `:648`), on-demand opens 409 (`throwIfBlockedByRestore`, `:1955`), and `dropDatabase` serializes on the same lock. It works for a directory that does not exist yet. It is a _check_, not an exclusion: `database()` checks and then opens without holding the lock (`:1932-1937`), and the scan snapshots the blocked set once before opening (`:577-608`) — §6 closes that. `tryFileLock(file, shared)` supports the shared mode the fix needs (rocksdb-js `README.md:1764`) |
| Streaming upload                       | `multipart/form-data` content-type parser handing the handler a `Readable` for the file part, added for `deploy_component` in 5.1.0 — `server/serverHelpers/multipartParser.ts`, registered at `server/serverHelpers/contentTypes.ts:307`; CLI side `bin/multipartBuilder.ts:36-58` always emits fields first                                                                                                                                                                                                                                                                                                                                                 |
| Pull source with credentials           | `import_from_s3` — a standard job that downloads an object with caller-supplied S3 credentials (`dataLayer/bulkLoad.ts`, `validation/fileLoadValidator.ts:114`); `deploy_component` accepts `package` as a URL and resolves registry/git credentials from the secrets store (`CredentialReference`, `components/secretOperations.ts:337`)                                                                                                                                                                                                                                                                                                                     |
| Quota-aware free space                 | `getStorageSpaceStats(path)` → `{available, free, size, basis: 'quota' \| 'filesystem'}`, preferring host-manager's `quota-status.json` over `statfs` because statfs misreports a quota-limited data directory (#1976) — `server/storageReclamation.ts:160`. The quota file is rewritten about every 90 s and accepted up to 5 min old (`:19-22`)                                                                                                                                                                                                                                                                                                             |
| `.tar` / `.tar.gz` extraction          | `pipeline(tarball, gunzip(), extract(dir))` — `components/Application.ts:878`; `gunzip-maybe` + `tar-fs`, both already dependencies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Online publication of a new database   | `create_database` → `database()` opens on demand → `signalSchemaChange` rescans every thread — `dataLayer/harperBridge/ResourceBridge.ts` `createSchema`, `resources/databases.ts:1897-1935`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Cross-thread lease with owner liveness | `components/componentPreparationLock.ts` — lease file with `pid`/`threadId`/process-instance id and an `isOwnerAlive` probe; `restartWorkers` already waits on it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Safe mode                              | `HARPER_SAFE_MODE` — skips applications and `package:` components, keeps the root component (operations API) and built-in trusted plugins (`bin/run.ts:43-44`, `server/loadRootComponents.js:48,61,77-82`, `components/componentLoader.ts:930-932`). Env-only; absent from `config-root.schema.json` and `bin/help.ts`                                                                                                                                                                                                                                                                                                                                        |
| Peer membership, in core               | `system.hdb_nodes` is a core system table (`json/systemSchema.json`), `replication.routes` is core config, and `getThisNodeName()` is core (`server/nodeName.ts:36`); harper-pro's `server.nodes` is built from exactly these (`replication/knownNodes.ts:635-673`)                                                                                                                                                                                                                                                                                                                                                                                           |
| Physical column-family inventory       | RocksDB's `OPTIONS-*` file lists one `[CFOptions "<name>"]` section per column family that exists on disk; the binding exposes only a live count (`README.md:287`). `initStores` recreates a missing family as an empty store when the catalogue still names it (`resources/databases.ts:1091-1096`), so "opened successfully" cannot prove a family existed — §5.5 reads the inventory before any create-capable open                                                                                                                                                                                                                                        |
| Blob layout                            | `<root>/<db>/<shard1>/<shard2>/<fileId>` under **every** configured `storage.blobPaths` entry (`resources/blob.ts:2603`); `assertBlobSnapshotRestorable` refuses a snapshot with more roots than the current config. File ids are a per-database counter re-seeded from a directory scan at process start (`:2685`)                                                                                                                                                                                                                                                                                                                                           |
| Transaction logs                       | inside the database directory at `<dbDir>/transaction_logs/` (rocksdb-js default `transactionLogsPath`; Harper never overrides it), so they travel with the directory                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

**The fact that makes archive restore tractable at all:** a database's schema is self-describing.
Table and attribute definitions live in an internal column family inside the database directory and
are read straight off it on load — `initStores` iterates `attributesDbi.getRange({ start: false })`
at `resources/databases.ts:1067`. Laying down a database directory brings its schema with it; there
is no `system`-database state to reconstruct (`system` carries no `hdb_table`/`hdb_attribute`
catalogue — `json/systemSchema.json`).

**The fact that decides the approach:** a `get_backup` archive and a managed backup differ only in
format. The archive is engine files at the root, `transaction_logs/`, `blobs/<rootIndex>/` and two
READMEs; the repository is BackupEngine's `meta/`/`shared/`/`private/<id>` plus
`transaction_logs/<id>/`, `blobs/<id>/<rootIndex>/` and `manifests/<id>.json`. The conversion is an
open and a `backup()` — no new primitive, in Harper or in the binding.

## 3. The invariant

> An acknowledged restore publishes exactly one complete, recoverable generation — engine data,
> schema, replayed transactions, and index-addressed blobs — and no reader or creator can observe
> or mutate an intermediate generation. The recovery source stays available until a durable
> completion decision is recorded. A restore under a new name holds an exclusive reservation on
> that name from the first byte. A retry preserves the original rollback identity and never
> overwrites a generation that has already been published.

Every clause is load-bearing. "Opened successfully" is what every prior defect on this surface
settled for: `create_backup` reporting a `backup_id` for a purged engine backup (#2031) and
`copy-db` exiting 0 on a non-restorable copy (#2048) are the same shape — success reported on an
artifact nobody proved whole. The reservation clause is why the existing marker, not a directory
absence check, gates online publication (§6). The recovery-source clause is why backup ids a
pending restore names are pinned (§5.6). And "no intermediate generation" is why an in-place
replacement of a held database happens at startup, under a durable state machine, rather than
online. The retry clause is why the pre-restore backup is captured exactly once, before anything
destructive, and why finalization after `committed` only ever finishes bookkeeping (§5.7).

## 4. Approaches considered

**Different layer — host-manager mounts the archive into the container; Harper restores from a
local path.** Rejected on a concrete cost: every restore then requires orchestration support (a
CM/host-manager action per restore), and it does not serve self-managed installs at all, which is
where `get_backup` archives are most likely to be produced. It also leaves the actual problem
(nothing consumes the archive format) unsolved — it only changes who carries the file.

**Deeper cause — stop producing an unrestorable artifact.** The real upstream defect is that
`get_backup` emits a format with no consumer. The maximal version of this axis is to delete
`get_backup` and tell operators to use `create_backup`/`restore_backup` only. Rejected: the archive
is the only backup form that leaves the instance, which is precisely what a machine migration or an
off-box retention policy needs — a managed backup repository under `storage.backupPath` dies with
the host. A gentler form — have `get_backup` export a versioned _managed-repository bundle_ instead
of a raw snapshot — would remove the conversion step for future exports, but it changes the
portable format and still needs a converter for every archive already in the field, so it does
not replace this work. Both forms yield a real prerequisite that is adopted below: the archive
carries no machine-readable identification of what produced it, so a restore cannot refuse an
incompatible one. That is fixed first and independently (§7.1).

**Do less — document the manual laydown properly and ship nothing.** This is the status quo plus a
docs PR. Rejected on a named invariant: the manual route requires the operator to reproduce the
blob root-index mapping by hand, and getting it wrong mis-addresses every file-backed blob in the
database because records persist the root index, not the path (`blobsReadmeContent`,
`dataLayer/blobBackup.ts:228-250`). Handing an operator a destructive multi-step procedure whose
failure mode is silent blob mis-addressing is not a smaller change, it is an unbounded one. Two
partial forms _are_ adopted: restore is refused, not designed around, wherever it would have to
reason about cluster state (§5.9); and restore-into-a-new-name ships first (§12), because it
preserves availability and lets the operator inspect the result — it cannot replace data a
component is bound to, so it is a rollout stage, not the whole answer.

**An offline CLI importer plus online restore into a new name only, refusing replacement
permanently.** It removes the restart state machine entirely and is a sound first release — it is
this note's rollout stage one (§12). Rejected as the whole answer because Fabric's component-held
databases stay unrestorable without application or control-plane changes, which is the gap §1
names.

**Provision a new Fabric instance from the archive and cut routing over.** Operationally safer —
no in-place swap at all — but it changes instance identity and control-plane state, requires
orchestration support per restore, and does not serve self-managed installs.

**A bespoke rename-swap protocol (round 1's chosen approach).** Extract per destination volume,
validate out of process, write a versioned journal of every intended rename, and have the next
startup swap the engine tree and each blob tree into place, retaining the displaced tree under a
reserved name for a separate reclamation operation. Withdrawn in round 2. Every piece of it exists
in another form in the managed-backup path (§2), and round 1 rejected reusing that path on the
wrong grounds: "a rocksdb-js `import tar into managed repository` primitive cannot coordinate blob
roots nor component-held handles" is true of an _engine-level_ importer and irrelevant to a
Harper-level one, which coordinates blob roots with `snapshotBlobs` (already index-preserving) and
leaves component-held handles to the restart route both designs need. What the rename swap buys and
costs, as **total on-disk occupancy** (N = database size; blob bytes hard-link where the two
locations share a filesystem and copy otherwise, and a same-filesystem link can still fall back to
a copy on `EMLINK`/`EPERM`, `dataLayer/blobBackup.ts:59-80`):

| aspect                 | rename swap                                           | import + managed restore                                                                                                                                   |
| ---------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| peak occupancy         | 2N (live + staged), then 2N retained until reclaimed  | 3N during import (live + staging + repository), 2N after; during a restore with the pre-restore backup retained, 3N (two repository copies + the new tree) |
| bytes written          | ~1N                                                   | ~3N (stage, repository, restore)                                                                                                                           |
| retained copy          | free rename; unverifiable; needs a reclamation op     | a real backup: `verify_backup`-able, restored by the standard path, pruned by `purge_backups keep_count`                                                   |
| crash mid-restore      | new journal, resumable renames across several volumes | rerun `restoreBackupOffline`; the source persists and is pinned, and the marker blocks the database meanwhile                                              |
| validation             | new validator plus a new post-load check              | `verify_backup` plus §5.5's engine-level pass, and the publication protocol's elected replay (§5.7)                                                        |
| new on-disk formats    | journal                                               | none; the backup manifest and a small intent file gain fields                                                                                              |
| offline / self-managed | nothing reusable                                      | `harper restore_backup` already works on the imported id                                                                                                   |

One extra N of occupancy and two extra writes of the data. Under a Fabric quota that matters, so
retention is an explicit, recorded operator choice (§5.8) and the gate is honest about quota
staleness (§5.3), rather than the reason to carry a second protocol. Where the peak genuinely does
not fit, the rename swap is the fallback design, and this note is the record of what it must
provide.

**Chosen — `import_backup` converts the archive into a managed backup; `restore_backup` gains a
restart route for held databases; restore into a new name is online.** The single fact that beats
each rejection: everything an archive restore needs except the format conversion is already the
managed restore path, and the one thing that path lacks — a way to run for a held database on
Fabric — it lacks today, for managed backups too. Building that once serves both.

## 5. Design

### 5.1 Scope

**In:** `import_backup` — accepts a `get_backup` archive from a streaming multipart upload or a
pull source (§5.2), stages, validates, and records it as a backup id in the database's managed
repository; a shared publication protocol under which a restored database becomes visible (§6);
a restart route on `restore_backup` for databases the online path cannot close (§5.6, §5.7);
`target_database` online (§6); a retained pre-restore backup with explicit opt-out (§5.8);
repository operations that work for a database that is absent or blocked (§5.5).

Authorization is enforced **inside every handler** — import, restore, and the intent-management
options — with `requireSuperUser()`, matching `dataLayer/rocksdbBackup.ts:82` and the existing
backup operations. Declarative `requires_su` metadata is not sufficient on its own: #2175 records
that operation allowlist grants are gate-inert for operations registered without an `api_name`, so
a metadata-only gate can be bypassed. An operation that accepts filesystem content and restarts the
node is the worst place to discover that.

**Performance envelope.** Every new check sits on administration, discovery, and open paths.
Nothing here adds per-record allocations, locks, or filesystem work to a request path: the intent
file and the safe-mode trigger are read once at boot, and the restore marker is consulted where
the scan and on-demand open already consult it. Unrelated request latency during extraction and
conversion is measured, not assumed (§12).

**Out:** engine-only archives as _replacement_ restores (§5.4, §7.6); the `system` database (an
archive of it carries users, roles, components and deployment rows — a different and much riskier
operation, and `restore_backup` already refuses it online); LMDB archives (`get_backup` on LMDB
returns the raw `.mdb` file, not a tar — `bin/backup.ts:152`, so a `.tar[.gz]` is by definition a
v5 RocksDB artifact); v4 migration, which keeps its existing path; and any restore onto a node with
peers (§5.9).

### 5.2 Sources and the declared size

Two sources, one pipeline after the bytes are on disk:

- **Push** — multipart streaming upload, reusing the `deploy_component` machinery. The declared
  uncompressed size is a **field part**, not an `x-` header: the part-ordering contract guarantees
  fields arrive before the file, so the size is available before the first archive byte reaches
  disk. The upload is consumed in the request process (a `Readable` cannot be persisted into a job
  row — `jobs.addJob()` stores the request, `server/jobs/jobs.ts:200`); once the archive is fully
  staged the handler records the staging area's owner (§8), enqueues the validation/conversion job
  with the staging path as its scalar request, and returns the job id.
- **Pull** — `url` (https) or the same `s3` object `import_from_s3` takes. The whole operation is a
  standard job: the request is scalar, it persists into the row, the download can resume with
  `Range`, and it never crosses the Fabric ingress. This is where off-box backups actually live, so
  it is the primary Fabric form; push stays for `curl` and laptops.

The declared size is **advisory** — an early reject so a 50 GB upload fails in seconds rather than
after transferring. It cannot be a gate, because it is client-supplied; a wrong or hostile value
would otherwise pass the check and fill the disk mid-extract, which is the #2095 false-green pattern
this surface keeps reproducing. For a pull source the plain-tar `Content-Length` plays the same
advisory role. Consequences:

- Plain `.tar` — exact size from `stat`, free.
- `.tar.gz` — the CLI may send a conservative estimate (compressed size × factor) or compute the
  exact figure by inflating through a fixed buffer and summing tar entry sizes. That pass is O(1)
  memory but must inflate every byte, since gzip is not seekable; it is a local-disk cost, not a
  network one, and it is optional precisely because the value is advisory. Harper computes the same
  figure for itself — exactly, with block rounding and an inode budget — on the pull path, and
  incrementally as it extracts on the push path (§5.3); the client's number never becomes the gate.
- A request with **no** declared size is accepted. It fails late instead of early, which keeps the
  operation usable from `curl` rather than only from the Harper CLI.

The multipart parser is registered as a raw-stream parser with no `parseAs`
(`server/serverHelpers/contentTypes.ts:307`), and Fastify enforces `bodyLimit` only when it buffers
the body, so the 1 GB `REQ_MAX_BODY_SIZE` (`server/operationsServer.ts:41`, `:360`) does not apply
to this path — likely rather than proven; one test that posts a body over the limit settles it.
Harper-side timeouts do not bound a long upload either: `requestTimeout` is unset (Fastify default 0) and `connectionTimeout` is socket inactivity. `verify:` what the Fabric ingress does with a
multi-GB request body — the reason the pull source exists.

**Pull-source security.** A server-side fetch adds no network reach a tenant lacks — a
super-user can already deploy a component that fetches anything from inside the container — so
the concerns are what Harper _lends_ to the fetch and where the supplied secrets end up:

- **Never ambient credentials.** `utility/AWS/AWSConnector.js` passes explicit `credentials`, so
  the SDK's default provider chain (env, instance role) is never consulted; the pull keeps that
  invariant and is tested for it. The `url` form uses a bare client: no Harper TLS client
  certificates, no inherited headers, `GET` only, `https` only, `file:` and other schemes rejected.
- **Secrets never persist in the job row.** Job workers read their request from `hdb_job`
  (`server/jobs/jobProcess.ts:47-55`), which is how `import_from_s3` and `export_to_s3` leave AWS
  secrets in the system database today until the job clears the row (`get_job` strips `request`
  from responses and `hdb_job` is in `NON_REPLICATING_SYSTEM_TABLES`, but the row is on disk and
  in any `system` backup taken meanwhile). Redacting an inline key before persistence would lose
  the credential the worker needs, so inline long-lived keys are **rejected** for the pull form
  (`validation/fileLoadValidator.ts:56` requires only that `s3` exists; this validator requires
  more). Two forms are accepted: a secrets-store reference, resolved by the worker the way
  `deploy_component` resolves registry and git credentials, or a presigned URL, which is
  time-bounded, stays in the row only until the job runs, and is redacted to its origin and path in
  every log line, error message, and result (`bulkLoad` today echoes the full URL into errors).
- **One fetch policy.** `csv_url_load` fetches any URI with `needle`, forwards `passthrough_headers`,
  and has no host policy (the tracked SSRF item, CORE-3055). The pull shares one fetch helper with
  `csv_url_load` and `deploy_component package=<url>` so it inherits whatever policy lands there:
  deny loopback, link-local and the metadata address, and RFC1918 unless configured; re-validate
  each redirect hop; resolve DNS once and connect to the validated address. The policy is a
  configurable allow/deny list whose default keeps today's private-endpoint pulls working — a
  stricter default is a separate compatibility change with its own coverage. `verify:` whether
  host-manager restricts tenant egress at all (its compose networking is not in this repo).
- **Integrity.** TLS covers transport, nothing covers a swapped object in the bucket. An optional
  `sha256` pins the content; the computed digest and `imported_from` always land in the manifest.
  The bytes are hostile input regardless of source — the out-of-process validator and entry
  filtering (§5.4, §5.5) already assume that — so a bad archive is a failed import, not a
  compromise.
- **Server-initiated resource use.** Idle and total timeouts on the download, the same disk gates,
  one import at a time (§8), and a cancelable job; a gzip bomb is already caught by metering
  extracted bytes.

### 5.3 The disk gate

Two checks, both via `getStorageSpaceStats()`:

1. **Pre-flight**, against the declared size, before accepting the body.
2. **Continuous**, during extraction, aborting below a floor. This is the authoritative gate and is
   honest whether the client was accurate, sloppy, or hostile.

**The exact extracted size is computable, and where Harper can afford the pass it computes it.**
Tar headers carry each entry's byte count, so summing them gives the real figure rather than an
estimate — with three corrections, because the naive sum is wrong in both directions:

- **Round every entry up to the staging device's allocation unit**, not to a constant. A 1-byte
  file occupies a full block, so a sum of raw sizes under-counts an archive of many small files by
  orders of magnitude. The unit is `fs.statfsSync(stagingDir).frsize` — 4096 on ext4, XFS and APFS,
  but ZFS `recordsize` reaches 128K and both are tunable, and since `.import` may be a mount on
  operator-supplied storage (§5.4) the root filesystem's block size is the wrong device to ask.
- **Count directories, and count inodes separately.** Each directory entry costs an inode and at
  least one block. More importantly, inodes are a second exhaustible resource that no byte tally can
  see: a filesystem with terabytes free and no free inodes fails every create. `statfs` reports
  `files`/`ffree` alongside `bavail`, so the gate carries an entry budget beside the byte budget —
  the same reason §5.4 bounds entry count rather than bytes alone.
- **Accept that it over-estimates on a compressing filesystem.** ZFS or btrfs with compression
  enabled stores less than the tally predicts. Over-estimating is the safe direction; under-
  estimating is the one that fills the disk mid-extract.

**What it costs is a full inflate, and that is why it is not free on every path.** gzip is not
seekable and tar headers are interleaved with payload, so reaching entry _N_ means inflating
everything before it: "walk the archive" is a complete decompression pass with the writes thrown
away, not a cheap index read. So the two sources differ, and the note treats them differently
rather than pretending one rule fits both:

- **Pull (§5.2)** — Harper controls the fetch, so the archive can land on disk and be inflated once
  to tally and once to extract. Two passes of CPU and one copy of _compressed_ bytes buys an exact,
  server-computed gate before a single file is created. This is the path where a pre-gate is worth
  having, and it is also the primary Fabric form.
- **Push (multipart)** — the bytes cross the wire once. A pre-tally would mean persisting the
  compressed archive first and inflating it twice, giving up §5.4's "decompress the upload stream
  directly to disk, no intermediate copy". Not worth it: instead the **continuous** gate becomes
  block-aware, debiting `ceil(size / frsize) * frsize` per entry plus one unit per directory as each
  header is read, and aborting the moment the running projection crosses the budget. That reaches
  the same accuracy as the pre-tally without a second pass; it simply fails at the point of
  exhaustion rather than before transfer, and eager cleanup (§5.4) makes a late failure cost wasted
  I/O rather than a wedged state.

**None of this retires the meter, because headers are supplied by the archive.** A hostile archive
declares whatever it likes; `tar-fs` reads exactly `size` bytes per entry, so a header cannot make
extraction write _more_ than it claims for that entry, but a tally is only ever as trustworthy as
its input. The pre-tally upgrades the admission decision from advisory to exact for well-formed
archives; the metered total during extraction stays the enforcement point, and `EDQUOT`/`ENOSPC`
stays authoritative over both.

**The continuous check cannot simply re-read the statistics.** Under `basis: 'quota'`,
`getStorageSpaceStats()` returns the same host-manager snapshot until the file is rewritten,
about every 90 s, and accepts one up to 5 min old (`server/storageReclamation.ts:19-22`). An
undeclared upload can consume the remaining quota while every re-read still reports the original
headroom. So the gate keeps a **budget**: `available` at the last distinct sample (by `updatedAt`),
minus every byte admitted since that sample, minus a reserve for serving writes; a new sample
resets the budget, and `EDQUOT`/`ENOSPC` from the write path is the authoritative stop regardless
of what the budget says, followed by eager cleanup (§5.4). Re-sampling is throttled by bytes and
time either way: `getStorageSpaceStats()` reads quota state, resolves paths, and may call `statfs`
(`:160-185`), and calling it per chunk or per tar entry would put filesystem work on the operations
worker for the length of a multi-gigabyte upload. Tar, zlib and validator modules are lazily loaded
so ordinary startup and request paths pay nothing for this feature.

Treat `basis: 'filesystem'` as lower confidence and add margin — it means either no
`quota-status.json` or a stale one, so the number may describe a shared volume rather than this
tenant's quota.

**One ledger across every phase and volume.** A per-phase gate against the same stale sample
double-spends it: with 40 GB reported free, extraction admits 25 GB, and conversion then gates its
exact 25 GB against the same 40 GB and fills the quota. A newer sample does not help either — it
cannot see bytes written after it was measured but before it was read. So the operation carries
**one ledger**, grouped by the quota or filesystem each path actually lands on, debited by every
byte staging, conversion, the pre-restore backup and the restore write, and re-based only when a
sample newer than the last debit arrives. `getStorageSpaceStats()` does not currently return the
sample's `updatedAt` (`server/storageReclamation.ts:160-185`); its contract is extended so the
ledger can tell a fresh sample from a re-read. Import needs `size(archive)` on the staging volume
during extraction and again on the repository volume for `db.backup()` — the second figure is
exact by then (metered, not declared), so it is debited once before the copy. Blobs hard-link
from staging into the repository when the two share a filesystem and copy otherwise, which is
`create_backup`'s existing behavior; a same-filesystem link can still fail with `EMLINK`/`EPERM`
and fall back to a copy (`dataLayer/blobBackup.ts:59-80`), so the gate counts blob bytes unless the
link actually succeeded. Staging is removed after the manifest is published, so the import leaves
`size(archive)` in the repository. The restore itself then needs `size(backup)` for the new tree
(`purgeAllFiles` frees the old one first) plus, when the previous state is retained (§5.8), one
more `size(live)` for the pre-restore backup — gated at the hook, before anything destructive.

### 5.4 Extraction and staging

Decompress the upload stream directly to disk — no intermediate copy — into **one** staging area,
by default beside the database's repository directory (`<backupsRoot>/<db>/.import/<importId>/`, on
the repository's filesystem so the blob snapshot can hard-link). Round 1's per-volume staging
existed to make the final step a rename on each destination volume; with the repository as the
destination, that constraint is gone. BackupEngine ignores directories it does not own — Harper
already keeps `blobs/`, `manifests/`, `transaction_logs/` and `README.md` in the same directory.

Staging is outside every databases root, so the startup scan never sees it and the design does not
depend on the reserved-name skip (#2033 is open on that skip being silent).

**The uploaded bytes never touch `os.tmpdir()`.** The multipart file part is handed to the handler
as a `Readable` and streamed straight into gunzip + tar-fs with no temp spool
(`server/serverHelpers/multipartParser.ts:15-17`), so the only disk the archive ever occupies is
the staging area named above. `<backupsRoot>` is `getBackupsRoot()`
(`dataLayer/rocksdbBackup.ts:88-93`), which is the `storage.backupPath` config setting
(`utility/hdbTerms.ts:700`) and falls back to `<hdb_root>/backup`
(`config/configHelpers.ts:9-11`). The default therefore _is_ the Harper home directory, which is
the wrong volume for a database large enough to need this feature.

**Attached storage is a mount at `.import`, not a config setting.** The obvious response to that
default is a second path setting, and it is the wrong one. No config parameter is live-reloadable:
`set_configuration` writes the YAML and deliberately does _not_ refresh the in-memory config — it
calls `updateConfigValue(undefined, undefined, configFields, true)`, leaving the fifth parameter
`update_config_obj` at `false`, so the `flatConfigObj` behind every `env.get()` and
`getConfigPath()` read is never reassigned (`config/configUtils.ts:1105-1108`, `:952-959`,
`:424-439`). No ITC message follows, so not even the thread that served the request sees the new
value, and the operation says so itself: "Configuration successfully set. You must restart Harper
for new config settings to take effect." (`:43-44`). `RootConfigWatcher` hot-reloads logging
(`utility/logging/harper_logger.ts:197-206`) and, since
[#2377](https://github.com/HarperFast/harper/pull/2377), the models block
(`resources/models/bootstrap.ts:508`) — neither feeds `flatConfigObj`, and neither extends to
storage paths.

The staging path does not need to be configurable, because it is already a stable, per-database
location an operator can mount onto: **mount the attached volume at
`<backupsRoot>/<db>/.import`**. Nothing is reconfigured, nothing restarts, and the attachment can
happen while Harper runs — which is the actual requirement. It also puts the volume exactly where
the pressure is: the extracted archive is the largest transient artifact, while the repository it
converts into stays on its existing volume, so the two no longer have to be sized as one ~2N
space. There is no `storage.importStagingPath`, and the design is better for not having it.

**What being a mount point changes, and the invariants that follow.** A mount breaks the usual
implication that a path _under_ `<backupsRoot>/<db>/` is _on_ the same filesystem as it, and every
consequence below is a place where the obvious implementation is wrong in a way nothing reveals
until someone actually mounts:

- **Harper creates `.import` if absent and never removes it.** Only `<importId>` subdirectories are
  created and deleted. §5.4's eager intake cleanup, §8's worker-exit sweep and the startup sweep all
  operate one level down; an `rm -rf` of `.import` itself would fail with `EBUSY` against a live
  mount, and would silently destroy the mount point when the volume happens not to be mounted.
- **The disk ledger groups by device, not by path prefix.** §5.3 already says "grouped by the quota
  or filesystem each path actually lands on", and with a mount here that stops being a pedantic
  distinction: a prefix-based grouping charges staging bytes against the repository's free space
  and vice versa, admitting an import that cannot fit and refusing one that can. Group by the
  `statfs` device id of each resolved path.
- **The blob snapshot becomes a copy.** Linking staged blobs into `blobs/<id>/` crosses the mount
  and fails `EXDEV`, so `linkOrCopy` falls back to a copy (`dataLayer/blobBackup.ts:59-80`). That is
  already the documented behavior and the ledger already counts it — co-location is the default's
  optimization, not a correctness requirement.
- **An unmounted mount point is indistinguishable from an empty one.** If the volume is not mounted
  when an import starts, `.import` is an ordinary directory on the root filesystem and a
  multi-hundred-gigabyte archive quietly fills the OS volume instead. Record the staging directory's
  device id when main adopts the staging area (§8) and re-check it before each phase; a device that
  changed mid-import means the mount moved under a running job and the import fails rather than
  writing to the wrong volume.
- **It is one mount per database**, since `.import` sits under `<backupsRoot>/<db>/`. That suits the
  single-very-large-database case this serves, and an operator with several needs several — worth
  saying in the docs rather than discovering.
- **Pre-creating the mount point makes an empty repository look real** to the `existsSync(backupDir)`
  proxy §7.7 describes: `<backupsRoot>/<db>/` must exist before anything can be mounted beneath it,
  so a database with no backups answers `list_backups` with `[]` rather than a 404. Harmless in
  itself, and another reason §7.7's explicit repository stamp is the right fix for that proxy.

**Nothing from the old database is moved into staging — the displaced tree stopped existing in
round 2.** Round 1's rename-swap protocol retained the old engine and blob trees under a reserved
name so RocksDB would not find them, and left a separate reclamation operation to collect them
(§4). That is precisely the piece round 2 withdrew. The current protocol destroys the old directory
in place — step 3 of §5.7 is "lock, marker, purge, engine restore, blob restore", where the purge is
`backups.restore(backupDir, databaseDir, { mode: 'purgeAllFiles' })`
(`dataLayer/rocksdbBackup.ts:574`, `:1045`), documented as "purge the destination directory and
restore everything"
(`@harperfast/rocksdb-js` 2.9.1, `docs/backups.md:99`).
What makes that safe is not relocation but the **pre-restore backup** of §5.8, captured in step 2
while the intent is still `pending` and pinned into the intent before anything destructive runs.
Invisibility to RocksDB comes from the restore marker and §6's exclusion, not from a path change.

So `.import` holds staged archives and nothing else, and the rollback source stays in the
repository on its own volume — which is where it should stay regardless. Putting it on the attached
volume would make the one artifact needed to undo a failed restore depend on the mount still being
there, and would buy nothing: `db.backup(dir)` is a full copy of the engine files wherever it
writes — "A backup is a real, separate copy in the backup directory; it is not a hard link to the
live database" (same doc, `:116-117`) — so there is no hard-link economy to preserve by moving
it. The blob half of a backup _is_ hard-linked when it can be, which argues for the repository
sharing a filesystem with the live blob roots, the opposite of moving it onto attached storage.

**Resolve the root once per operation, never per call.** `getBackupsRoot()` reads config on every
call, so a value that changes between two calls inside one logical operation would split it across
two roots. The existing operations are already correct — each resolves `backupDirForDatabase()`
once at entry and threads `backupDir` down (`dataLayer/rocksdbBackup.ts:323`, `:344`, `:379`,
`:467`, `:1001`) — and import must hold the same rule across its job boundary, which §8's handoff
already does by recording the absolute staging path rather than re-deriving it in the job.

Entry filtering is explicit, not inherited: reject `..`, absolute paths, symlinks, hardlinks and
device nodes rather than trusting `tar-fs` defaults. Tar extraction of operator-supplied bytes is a
path-traversal sink.

**Byte limits are not sufficient — bound the entry set too.** The multipart parser deliberately
enforces no file-size cap: "Operation handlers stream the file part directly into extraction
(gunzip + tar-fs), so there is no separate filesize cap to enforce here ... bounded by disk space
rather than memory" (`server/serverHelpers/multipartParser.ts:15-17`). Disk _bytes_ are therefore
the only ambient bound, and millions of zero-byte entries exhaust inodes without ever crossing the
free-byte floor. Enforce, per archive: entry count, total actual uncompressed bytes (metered, not
declared, and counted in whole filesystem blocks per §5.3), per-entry size, path length, and
duplicate entry names.

**Engine-only archives cannot be replacement restores.** An archive created with `exclude_blobs`
carries no blobs, so restoring it over an existing database rolls records back while leaving the
current blob roots in place — a mixed generation. The everyday failure is a dangling reference (a
blob deleted since the backup point); the worse one is id reuse, which needs every higher id
deleted and a process restart (file ids re-seed from a directory scan, `resources/blob.ts:2685`) and
then resolves to unrelated bytes. The imported backup's manifest records `blobs: false`, and
`restore_backup` refuses it in place unless the caller opts in explicitly (§7.6 — one rule for
managed and imported backups, and a prerequisite of every route that restores in place); it
remains valid for `target_database`, where there are no pre-existing blobs to disagree with. A related
producer-side gap is decided in §5.7 and §11.

Intake failure removes its staging area **eagerly**, not at the next startup: a startup-only sweep
lets repeated disk-floor or malformed-archive failures accumulate quota while Harper keeps running.
Termination of the HTTP worker mid-upload runs no `finally`, so the main thread also sweeps on
worker exit — but only staging no job owns (§8). The startup sweep remains, for the crash case only.

### 5.5 Validation and conversion, out of process

The validation/conversion job spawns a purpose-built child process — the way `bin/copyDb.ts` is a
purpose-built CLI, **not** `harper` with `rootPath` pointed at the staging directory. A full
instance spawn would try to become a whole Harper (config, components, servers, `system`), and
`initStores` stamps `rootStore.databaseName` from `storeName`, which is what blob-root resolution
keys off (`resources/databases.ts:996-1002`, `:1017`) — so a full spawn would start resolving and
creating blob roots for a temp name.

The child is **engine-level only** and does not load the resource layer:

1. `RocksDatabase.open` on the staged directory (manifest and SST checks; RocksDB refuses a newer
   `format_version` on its own, loudly).
2. `validateTransactionLogStore(<staged>/transaction_logs, { strict })` — the same strict framing
   check `backups.verify` runs; snapshots are copied on committed entry boundaries, so even a torn
   tail is a producer defect and fails here.
3. Walk `__dbis__` for the **expected table set** and read the **physical column-family
   inventory** from the `OPTIONS-*` file, and cross-check them here: a catalogue row whose primary
   or index family is missing fails validation now, structurally and O(tables). Both lists go into
   the import result and the backup manifest; §5.7 compares against them after the restore, before
   any create-capable open. This is also what makes the table inventory available for a database
   that does not exist yet.
4. `db.backup(<backupsRoot>/<db>, { transactionLogs: true })` — the conversion. The binding's
   `.backup.lock` serializes this with `create_backup` on the same repository.
5. Optional, opt-in: the O(data) checksum walk (`backups.verify` with `verifyWithChecksum`), and the
   blob-reference scan (§5.7).

Then the job (back in Harper) snapshots the staged blob trees into `blobs/<id>/<rootIndex>/` with
`snapshotBlobs`, writes the manifest with `blobs`, the expected table set, the archive digest, the
§7.1 producer fields and `imported_from`, verifies the result, and removes staging. Signal death,
timeout, malformed output, and a non-zero exit are all validation _failure_, and the serving
process survives each.

**Repository operations must work without a loaded database.** `verify_backup`, `list_backups`,
`delete_backup` and `purge_backups` all call `requireRocksRootStore`, which needs a loaded database
with at least one table (`dataLayer/rocksdbBackup.ts:308-337`, `:473`). An import into a database
that does not exist yet, and a database blocked in the terminal state (§5.6), both have a
repository and no loaded root. The offline functions already operate on the directory alone
(`listBackupsOffline`, `verifyBackupOffline`, …); the operations take that path whenever the
database is absent or blocked, gated by the same super-user check. Without this, Fabric recovery
from a failed restore still ends in a filesystem intervention.

**Why the strict Harper replay is not here.** Round 1 put "await a strict transaction-log replay"
in the validator. A replay _writes_ — `replayLogs` commits transactions into the primary and index
stores — so the validator could not be read-only; it needs Table classes (`tables[…].primaryStore`,
`getResource`, `_writeUpdate`), so the child would have to load the resource layer and config; and
`replayLogs` calls `purgeAgedLogs()` before replaying (`resources/replayLogs.ts:83`), so §7.2's purge
would fire on the archive at validation time. The strict, awaited replay the design needs happens
instead at publication, in the main thread, through the branch claim's elected-replayer path with a
restore-strict policy (§5.7) — after this pass has proven the files will not abort the process.

**Why out of process, and what else must be.** A malformed RocksDB does not reliably throw — it can
abort the process, and in the live process that is a tenant-visible outage. rocksdb-js's handle
registry is also process-global by path (`dataLayer/rocksdbBackup.ts:617-623`), so opening the
staged directory in the live process registers that path. The same holds for the _existing_
destination: `restoreBackupOffline` opens the old directory to probe RocksDB's own `LOCK` file when
`CURRENT` exists (`:1027-1035`), and the pre-restore backup opens it again; a corrupt or
interrupted destination can abort the main thread at boot before any verified byte is copied. So
the hook's engine steps — pre-restore backup, `backups.restore`, blob restore — run in the same
purpose-built child (§5.7), and the main thread opens only files that child has already proven.
Isolation alone is not recovery, though: if the old `CURRENT` aborts the probe, every `resume`
and every `supersede` would abort the same way and the database could never be replaced. The
probe exists to keep the offline CLI from purging under a running server; the boot hook _is_ the
server, holds the exclusive restore lock, and owns the pid file, so the apply helper takes
`probe: false` from the hook and the CLI keeps the probe. Replacing an unreadable destination
never requires decoding it.

**The apply helper does not finish the restore.** `restoreBackupOffline` clears the marker on its
way out (`:1071`), before any of §5.7's validation. If validation then failed and the operator
cancelled the intent, nothing would block the rejected tree from loading on the next boot. So the
engine steps are extracted into an apply helper that leaves the marker in place; only §5.7's
finalization, after `committed`, clears it. The CLI's `restore_backup` keeps its current shape by
calling apply and then completing, as today. Under a container cgroup a child is not isolated from the memory limit, so it is bounded
explicitly: wall-clock, stdout/stderr size, `--max-old-space-size`, a small block cache, file
descriptors, an explicit kill, and on Linux the child raises its own `oom_score_adj` so a container
OOM takes the child rather than Harper.

**Depth.** Structural validation is O(tables) and catches the realistic failure — a truncated or
over-filtered archive missing a column family. Full index-versus-primary consistency is O(data) and
must be opt-in: #2211 shows index divergence is a real class, but a full scan is not affordable on
every restore of a large database. `backups.verify` covers engine files and transaction-log framing,
not Harper's index structures (rocksdb-js `README.md:2471-2483`), so the opt-in scan is Harper's.

### 5.6 The restart route and the intent state machine

`restore_backup` today closes the database across worker threads and refuses with a 409 when a
handle remains (`verifyDatabaseClosed`, `dataLayer/rocksdbBackup.ts:624`). The new option
`on_restart: true` turns that refusal into a deferred restore: the operation validates as today
(backup exists and is complete, blob roots compatible, §5.9's peer check, and — when the previous
state is to be retained — §5.3's room for the pre-restore backup), writes an **intent file** in
state `pending`, inserts the job row, returns the job id, and restarts. It is explicit, not
automatic on 409: a restart drops availability, and the 409 message names the flag.

**The intent lives beside the restore marker, in its own versioned file — not in config, and not in
the marker.** Config is the easier rejection: writing the intent into `harperdb-config.yaml` adds a
read-modify-write of a shared YAML document to a crash-sensitive path, and a stale flag re-triggers
a restore on every boot. The marker cannot carry it either: `beginRestore()` opens the marker with
`openSync(markerPath, 'w')` — which truncates before the name is written — and then writes two
lines (`dataLayer/restoreMarker.ts:193-199`), while `scanBlockedRestores()` skips any marker whose
first line is empty (`:272`). A kill between the truncate and the write yields a marker that blocks
nothing. **That is a pre-existing defect in `restore_backup` today** and is filed separately (§7.4).

The intent file is written temp → `fsync` → `rename` → parent `fsync`, under the reserved
`` `restore` `` directory keyed like the marker, and holds: an operation id, database, `backup_id`,
job id, `retain_previous` and (once taken) the pre-restore backup id, the expected table set, the
blob-completeness decision (§5.7), the generation (§5.9), who requested it and when, the attempt
count, and the **state**:

| state       | meaning                                                                 | discovery of the name | on the next boot                                                |
| ----------- | ----------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------- |
| `pending`   | requested; nothing destructive has run                                  | blocked               | run the hook (§5.7)                                             |
| `applying`  | the child has started destructive work; the marker also blocks          | blocked               | run the hook; `restoreBackupOffline` is rerunnable              |
| `committed` | validation passed; the result is durable; publication may be incomplete | open                  | finish reconciliation only (§10); **never re-apply**            |
| `terminal`  | attempts exhausted or peers found; database stays blocked               | blocked               | safe mode for this boot; wait for `resume`/`supersede`/`cancel` |

Malformed or torn intent **fails closed**: the name stays blocked, and the file's identity is
recovered from its key (the marker's hashed key scheme) so an operator can `cancel` it by database
name. There is no journal of renames, because there are no renames — the hook reruns
`restoreBackupOffline`, whose source persists and whose marker already encodes "started and not
finished", so a crash at any point before `committed` is recovered by running it again.

**The recovery source is pinned, inside a repository lock.** Between the request and the restart,
`delete_backup` or `purge_backups keep_count` can remove the very backup the intent names, or the
pre-restore backup the rollback depends on; the next attempt would then have no source. A pin
check that is not atomic with deletion is check-then-act too: delete reads "unpinned", pauses, the
intent lands, delete resumes and removes its source. So every repository has a Harper-level
**management lock** (`tryFileLock` on a file in the repository directory, exclusive), held across:
installing a pin (writing an intent, online or `on_restart`); a delete/purge from admission through
its last unlink — the binding's `.backup.lock` covers only the engine files, not Harper's blob and
manifest phases (`dataLayer/rocksdbBackup.ts:318-358`); and the blob/manifest finalization of
`create_backup` and `import_backup`. Delete and purge refuse an id that any
`pending`/`applying`/`terminal` intent names, in the operation form and in the offline CLI; online
restores pin their source the same way for their duration; and the hook re-resolves the manifest
before it purges anything (which `restoreBackupOffline` already does). This is the minimum of
#2031 and is a prerequisite (§7.3, §9).

**The restart is orchestrator-driven on Fabric, which makes the failure path a crash loop.** Under
`HARPER_EXIT_ON_RESTART`, `restart` is `process.exit(0)` — the comment says "use this to exit the
process so that it will be restarted by the PM/container/orchestrator" (`bin/restart.ts:162-166`).
So "trigger another restart and roll back" is not a call the code makes; it is the orchestrator
restarting Harper, repeatedly, indefinitely. **And self-managed installs have no supervisor at
all**: `harper start` forks a detached daemon and exits, and the auto-restart handler lives in the
launcher, which is gone seconds later (`utility/processManagement/processManagement.js:36-78`,
`bin/run.ts:248-268`). Both facts lead to the same rule: **a failed attempt never exits.** The hook
records the failure, leaves the marker and the intent in place, and continues boot with the
database blocked; the next attempt happens on the next restart an operator (or the orchestrator)
causes, or immediately via `restore_backup` with `resume: true`. After the attempt limit the intent
is `terminal`.

**The terminal state does start Harper — traced, and one gap.** Component load failures are
contained per component: a throw during load becomes an `ErrorResource` and a
`componentLifecycle.failed` event, and `loadComponent` never rethrows
(`components/componentLoader.ts:1165-1174`, `:1246-1251`); a component that declares tables in a
blocked database hits `throwIfBlockedByRestore` (409, `resources/databases.ts:1955-1966`) and
degrades rather than killing its worker. And `HARPER_SAFE_MODE` exists (§2): applications and
`package:` components skipped, operations API and built-in plugins up. The gap is that it is
env-only, and a container cannot set its own environment for the next boot, so the terminal state
cannot _request_ it on Fabric. A `terminal` intent therefore triggers safe mode by file for that
boot, checked once at startup wherever `HARPER_SAFE_MODE` is checked, and `HARPER_SAFE_MODE` gets
documented.

**Operating on a pending or terminal intent, entirely through the API.** All super-user, all
working without the database loaded (§5.5): `restore_backup … resume=true` re-arms the same intent
and restarts; `restore_backup … backup_id=<other> on_restart=true` **supersedes** it — this is how
rollback to the pre-restore backup is requested, since a blocked database cannot take a fresh
pre-restore backup and the request records that none will be taken; `restore_backup … cancel=true`
removes the intent — when nothing destructive ran (`pending`) the name is unblocked, otherwise the
marker, which the apply helper never clears (§5.5), keeps it blocked until a restore succeeds, and
the response says which. A `committed` intent cannot be cancelled; it can only be finished (§5.7
step 8). A second
`on_restart` request while an intent is pending, other than these three, is refused naming the
pending job.

`verify:` host-manager sets `HARPER_EXIT_ON_RESTART` for Fabric containers. It is set only in
`.github/workflows/docker-smoke.yml` in this repo; the inference is from the code comment.

**Draining — verified: there is none on `restart`.** `shutdownWorkersNow` posts `SHUTDOWN` without
awaiting and terminates every worker at once (`server/threads/manageThreads.js:983-995`); the
graceful drain (`runShutdownDrains`, `extendTerminateDeadline`) runs only on the rolling
`restart_service` path, and `Connection: close` on the response is the only client-facing courtesy
(`server/operationsServer.ts:339-343`). The restore restart goes through the rolling worker drain
first, then the existing exit path. That is a change to `restart`, and every Fabric restart benefits.

### 5.7 The startup hook: position, sequence, and what counts as loaded

**Position.** In the main thread the order is databases opened (`getTables()` →
`getDatabases()`, `server/loadRootComponents.js:67`) → root components, including built-in plugins
resolved from `TRUSTED_RESOURCE_PLUGINS` (`components/componentLoader.ts:458-460`, `:958-967`) and
replication's `startOnMainThread` (`:70`) → ports bound → HTTP workers spawned
(`server/threads/socketRouter.ts:82-99`); peer connections wait on `whenThreadsStarted`
(`harper-pro/replication/subscriptionManager.ts:550`). Round 1 placed the swap "before database
discovery", which cannot also re-assert peers: `hdb_nodes` is in `system`, and `system` is opened
by the same scan. So the intent file **blocks discovery of the target name** —
`databasesBlockedByRestore` consults it alongside the marker — and the hook runs right after
`getTables()`, before the root component loads. At that point `system` is open, the target is
unpublished, no worker exists, and no plugin — replication included — has loaded. Every worker
thread opens databases independently later, and consults the same block, so nothing observes the
target until the hook clears it.

**Sequence**, per intent that is not `committed` or `terminal`, attempt counter incremented and
fsynced first:

1. **Peers** (§5.9), read by core from `system.hdb_nodes` and `replication.routes`. Peers present →
   `terminal`, not a restore.
2. **Pre-restore backup, exactly once, while still `pending`**, unless `retain_previous: false` or
   the intent is a supersede/rollback: `createBackupOffline` of the old directory, run in the
   engine child (§5.5). Taken here, after the drain and with no writers, it captures the exact
   final state — a backup taken at request time would miss every write acknowledged between it and
   the exit. It must also be taken _only_ here: `createBackupOffline` refuses a database whose
   marker is present (`dataLayer/rocksdbBackup.ts:965-969`), so a retry that reached `applying`
   cannot capture again — and must not try, or it would replace the rollback source with a partial
   generation. The backup is made durable (`db.backup` syncs by default) and its id pinned into the
   intent, fsynced, before step 3; an `applying` retry skips this step and reuses the pinned id.
   Disk for it is charged to the ledger at request time (§5.3); the child re-checks.
3. State → `applying`, fsynced. The apply helper (§5.5) in the same child: lock, marker, purge,
   engine restore, blob restore — no `LOCK` probe at boot, and no marker clear. A crash here
   leaves the marker; the intent keeps the name blocked either way.
4. **Inventory, then private open.** Before any create-capable open, read the physical
   column-family inventory from the restored directory's `OPTIONS-*` file and check that every
   family the catalogue requires is present — `initStores` would otherwise recreate a missing
   family as an empty store and report success (`resources/databases.ts:1091-1096`). Then
   `initStores(path, root, db, { destination, openedStores })`, and check that the **expected table
   set** recorded at import (or, for a managed backup, walked from the repository at request time)
   is a subset of what enumerated, and that every one of those tables' stores opened. "No exception
   thrown" is the cheap proxy and it is #2095 group 4 — the same shape as #2031 and #2048.
5. **Elected replay, restore-strict**: `await replayLogs(root, destination, { elected: true,
policy: 'restore' })`. The boot path cannot report replay success — `readRocksMetaDb` is
   synchronous and calls `replayLogs()` without awaiting it (`resources/databases.ts:982`) — and
   elected mode, while it rejects a failing tail, still **tolerates undecodable entries by design**:
   an entry whose value does not decode increments `skipped` and continues in both modes
   (`resources/replayLogs.ts:183-201`, `:403-422`), so a structurally valid log that passed framing
   verification can still publish without acknowledged writes. The restore policy rejects when
   `skipped > 0` or `discardedWrites > 0`, and leaves ordinary boot semantics untouched. It also
   does not purge first: `purgeAgedLogs` is gated off under this policy (§7.2).
6. **Blob completeness.** A blob reclaimed before its parent directory was enumerated is absent
   from the source with no marker at all (`dataLayer/blobBackup.ts:30-40`), so table enumeration
   and framing checks pass while reads of that record fail. A replacement restore therefore runs
   the O(data) blob-reference scan — every file-backed reference resolves to a complete file or a
   marker — unless the request carried `accept_unverified_blobs: true`, and the intent and the
   result record `blob_integrity: verified | unverified | failed`. A `target_database` restore
   reports it and does not require it.
7. **Durability barriers, then commit.** A `committed` record that survives a power loss its data
   did not is the one outcome the protocol must never produce, and today's copies do not sync:
   `linkOrCopy`/`copyTree` neither fsync payloads nor directories (`dataLayer/blobBackup.ts:59-80`,
   `:192-211`), and the manifest is a `writeFile` plus `rename` (`dataLayer/backupManifest.ts:47-57`).
   Validation in steps 4–6 may have read cached bytes. So, per destination volume, before the
   commit: close the private engine handles and surface any close error; fsync every restored blob
   file and each directory on the path to it; fsync the manifests; fsync the intent's directory.
   Windows and some filesystems reject directory fsync (`fsyncDir` treats that as a no-op,
   `dataLayer/restoreMarker.ts:143-156`), and a kill-injection test cannot prove ordering across a
   real power loss — both limits are stated in the result and the docs rather than papered over.
   Only then state → `committed`, fsynced, **before** the discovery block is lifted.
8. **Finalize, idempotently.** Clear the marker, publish by running the ordinary load for that
   directory (whose boot replay finds nothing left to apply), reconcile the job row (§10), then
   delete the intent — in that order, each step safe to repeat. A crash anywhere after the
   `committed` write leaves a database that is whole and a boot that only re-runs this step;
   nothing re-runs steps 2–6 against data written since, and the marker cannot outlive a
   `committed` intent because clearing it is the first thing finalization does. Publication runs
   before any component's `declareTable`, so component-declared tables cannot skew step 4's
   comparison; a component whose `schema.graphql` is wider than the archive then reconciles the
   catalogue synchronously and starts an unawaited O(data) reindex (`resources/databases.ts:3092-3099`),
   which the result mentions as a post-restore tail. The generic boot sweep (§7.5) treats a job with
   a live intent as owned, not interrupted.

Any failure in 3–7 leaves the marker and the intent (`applying`) in place, records the failure and
the attempt, and continues boot with the database blocked — below the attempt limit the next
restart retries from step 3 with the pinned pre-restore id; at the limit the intent is `terminal`.
Rollback is `restore_backup backup_id=<pre-restore id> on_restart=true`, which supersedes the
intent (§5.6) and, as a supersede, takes no new pre-restore backup.

### 5.8 The retained copy and rollback

The displaced database is **not deleted.** The hook takes an ordinary `create_backup` of the old
directory before purging it (§5.7 step 2) and pins the id into the intent and the job. That copy is
a verifiable managed backup, restored by the standard path, listed by `list_backups`, and pruned by
`delete_backup` or `purge_backups keep_count` once no intent pins it; no reserved location, no new
reclamation operation, and none of the startup-scan exposure a renamed sibling would have (the scan
opens _any_ directory containing `CURRENT` plus `MANIFEST-*`, `resources/databases.ts:602-609`).

Taking it at the hook rather than at request time is what makes it a rollback target at all: the
request-time copy would predate the drain, and every write acknowledged between it and the exit
would vanish from both the restored database and the rollback. Its cutoff is the last write before
the process exited, and the result says so.

The failure this survives is not a corrupt restore — validation catches those — but a _technically
successful, semantically wrong_ one: right database, wrong backup, wrong point in time. In disaster
recovery that is very live, and the pre-restore backup is the operator's only copy of that state.
Auto-deleting it on a passing automated check would make it the single irreversible step in the
flow, decided by a heuristic.

It costs `size(live)` more in the repository until pruned, which under a Fabric quota is real. So
retention is a **recorded operator decision**, not a heuristic: `retain_previous` defaults to true,
declining it is explicit in the request and persisted in the job, the space for it is gated at
request time, and the result names the pre-restore backup id when one exists. Rollback is then
`restore_backup backup_id=<that id>` — through the restart route if the database is held, online
otherwise.

### 5.9 Replication: refuse rather than reason

**A restore is refused on a node that has peers.** This removes the entire divergence class: restore
node A to yesterday while B and C hold today, and replication either re-pushes today's writes onto A
(the restore is silently undone) or pushes yesterday's onto B and C (the blast radius grows from one
node to the cluster). Neither is what the operator asked for, and choosing between them is not a
decision a restore operation should be making.

"Has peers" is computed **in core**, from the two sources harper-pro's own `server.nodes` is built
from: any `system.hdb_nodes` row whose name is not `getThisNodeName()` (core,
`server/nodeName.ts:36`; pro excludes self the same way at `replication/knownNodes.ts:664`), **or**
any `replication.routes` entry, which pro injects as a tentative node
(`subscriptionManager.ts:606-619`). Not "has previously connected" — connection history is exactly
the check-then-act state this is trying to avoid. Reading the data directly, rather than asking
replication, matters for ordering: the hook runs before any plugin loads (§5.7), so a predicate
registered by the pro component would not exist yet, and a hook that could not tell "OSS has no
replication" from "the pro predicate is not registered" would have to fail closed on every OSS
boot. With the data in core, an OSS build with an empty `hdb_nodes` and no routes is simply a node
with no peers.

This is compatible with the two real workflows, with one condition each:

- **Machine migration** (move a node to bigger hardware) — back up on the old machine, restore on the
  new one _while it is standalone_, then join. The restore happens before the node has peers.
- **True disaster recovery** — a single node is restored, and the admin adds the second node
  afterwards, at which point ordinary replication seeds it. **The added peer must be fresh or
  wiped.** A peer that still holds pre-restore data pushes its newer versions back under
  last-writer-wins and quietly undoes the restore. On Fabric, removing and re-adding peers is
  CM-driven, so the runbook is part of this feature, not an afterthought.

The check is **re-asserted at the hook** (§5.7 step 1), not only at request time: a peer can be
added between the request and the restart, so a request-time check alone is check-then-act. Finding
peers at boot lands in the terminal state, not in a restore. The online route (§6) has the same
window and no restart to close it — a long online restore can pass admission standalone and gain a
peer or a route before it publishes — so it is **fenced**: core exposes "a restore reservation is
held for database X", `add_node`/`set_node`/`add_node_back` and the routes-config path refuse
while it is, and the publication protocol re-checks peers after replay and before `completeRestore`,
aborting into the blocked state if any appeared. The fence is primary; the re-check is the belt.

**This restriction does not close #2451, and an earlier draft of this note implied it did.**
[#2451](https://github.com/HarperFast/harper/issues/2451) is that a restore rolls a database back in
time with no generation marker, so audit retention floors, record versions, and per-node replication
sequence records all come back at the backup's values and read as valid. Two of those three bite on
a _single_ node: a local MQTT durable subscriber holding a cursor from after the backup point
compares it against the restored (older) audit floor, reads it as safe, resumes, and waits for
entries that no longer exist. Refusing peers removes the cross-node divergence; it leaves every
local resumable consumer intact and wrong.

So both routes — the restart route and the online publication protocol (§6) — must either land
after #2451, or mint a database generation themselves at the same single point (between §5.7 steps
3 and 7) and force local consumers to resync. Neither can be silent about it. (A planning-review
citation of `DESIGN.md:250-254` for this does not check out — those lines describe record-lock
upgrades, and DESIGN.md carries no generation note. The substance is #2451 itself, read directly.)

### 5.10 Roles

Schema is self-describing but the roles granting access to a database live in `system`, keyed by
database name (`role.permission[database].tables[table]`, `utility/operation_authorization.ts:860-875`).
So an **in-place** restore keeps every existing grant — the name did not change — while a database
restored under a **new** name arrives with no role granting anything on it, and nobody but a
super-user can reach it until the admin grants access.

**Do not auto-create the archive's roles.** Materializing roles from an uploaded file means the file
mints permissions on the target instance. The operator is already a super-user, so this is not a
privilege boundary crossing, but silently creating roles carrying another instance's permission set
is the wrong default. A user-database archive carries no role catalogue at all today; the producer
manifest (§7.1) records the **names** of the roles that held grants on the database, nothing more,
and the import result lists which of those names do not exist locally. The restore proceeds; the
operator grants.

## 6. Online publication: create-if-absent and `target_database`

An earlier draft withdrew online create-if-absent on two grounds: one code path, and "blob roots
are outside the database directory, so an online create would reintroduce partial-state
visibility". The second is a real hazard — but ordering the copies does not close it, and a
restart is not what does either.

- `backups.restore` copies engine files straight into the final directory, and the startup scan
  opens _any_ directory containing `CURRENT` plus `MANIFEST-*` (`resources/databases.ts:602-609`);
  an unrelated schema-change rescan on any thread can discover a half-copied tree. Another worker
  can create or open the "absent" name through `database()` (`create_database`, `create_table`)
  while the blobs are landing. A prior absence check is check-then-act.
- The current online `restoreBackup` clears its marker and then lets the ordinary reload publish
  the directory (`dataLayer/rocksdbBackup.ts:605-611`) — no private open, no awaited replay. Lifting
  the `target_database` refusal alone would inherit exactly that weaker guarantee.

So the online route uses the **same publication protocol** as the hook, with the restore marker
made into the exclusive reservation it is not quite today. The marker is a _check_: `database()`
calls `throwIfBlockedByRestore` and then opens without holding the lock
(`resources/databases.ts:1932-1937`), so an opener that passes the check, pauses, and resumes after
the marker lands opens the tree being restored; the scan snapshots its blocked set once and then
opens each directory (`:577-608`); and `restoreBackupOffline` checks the target is absent _before_
it reserves (`dataLayer/rocksdbBackup.ts:1008-1020`), so a concurrent `create_database` can lose the
database it just made. Three changes close that, all on cold open paths (§5.1): on-demand opens
and the scan's per-directory open take the per-database restore lock in **shared** mode
(`tryFileLock(file, true)`, rocksdb-js `README.md:1764`) across check-and-open and release it once
the handle is registered, so a restore — which holds it exclusive — cannot begin under an opener,
and an opener cannot begin under a restore; the reservation is taken **first**, and only then is
the target re-checked for absence (or, in place, for closure) inside it; and `dropDatabase` keeps
serializing on the same lock. Then engine restore, blob restore, inventory and private open,
expected-table check, restore-strict elected replay, blob completeness, the peer re-check (§5.9),
durability barriers (§5.7 steps 3–7), and only then `completeRestore` and the rescan that publishes
it. The in-place online restore of an unheld database goes through the same steps, which upgrades
`restore_backup` itself. Harper publishes new databases online today (`create_database`, §2), so
the runtime already supports the last step; what §6 adds is holding the reservation through
validation.

The private open and the elected replay run **in the job worker**, where `restore_backup` already
executes — never on a serving thread. `replayLogs` runs its loop synchronously, commits included,
behind a Promise it settles at the end (`resources/replayLogs.ts:60-136`), and on a `threads: 0`
install the main thread is the serving thread (`server/threads/socketRouter.ts:82-90`); a large
replay there would block every request until it finished. Elected mode already permits a worker
to replay (`:47-60`). The boot hook keeps main-thread replay because nothing is serving yet.

The split is therefore by **what is held**, not by new-versus-existing: in-place replacement of a
database a component holds → the restart route (§5.6); a new name, or an existing database nothing
holds → online, through this protocol, with the `target_database` refusal lifted when the target
directory is absent (the offline form's "never purge an existing database of that name",
`dataLayer/rocksdbBackup.ts:1008-1013`, applies unchanged). Restore-into-a-copy is the safest DR
move — inspect the copy, then swap or copy across — and on Fabric it is now reachable without
dropping traffic. It is also the first thing to ship (§12).

## 7. Prerequisites and adjacent defects, independently shippable

### 7.1 The archive carries no version stamp

`get_backup` archives contain only human-readable READMEs — nothing machine-readable identifies the
producing Harper version or storage format. A restore cannot refuse an incompatible archive it
cannot identify.

**Every archive produced today is unidentifiable, and those are the archives people will try to
restore.** So this ships first and separately. A version/format manifest as the **first** tar entry
is cheaply readable after inflating a few KB; it cannot be the last entry, because reaching the end
of a `.tar.gz` requires inflating the whole stream.

**The rule is capability flags, not a scalar version.** An earlier draft cited #2046 as recording
that "the 5.2.0 upgrade is one-way"; the issue's own resolution says the migration is additive and
the older binary was blocked on a hidden interactive downgrade prompt, and it concerns
`system.hdb_info`'s data version, which says nothing about a user database directory's format. The
real hazards for an archive are: RocksDB `format_version`/OPTIONS (the engine refuses to open —
fails closed by itself); record encoding (structon struct mode, `DESIGN.md:17-25`); the
transaction-log format version (rocksdb-js validates headers); and blob file format —
deflate-compressed bodies from #2443 are unreadable by a Harper without that support, and no engine
check catches them.

The manifest therefore carries: archive-schema version, producing Harper version (for logging),
rocksdb-js major, transaction-log format version, blob-format features present in the archive
(compression, marker types), source database name, whether blobs are included, the blob root
count, and the names of the roles that held grants on the database (§5.10). The reader refuses when
the target lacks any capability the archive declares. The same fields go into the managed backup
manifest (`dataLayer/backupManifest.ts` holds only `{ backupId, blobs, completedAt }` today), so an
imported backup records its provenance. A **managed** backup whose manifest predates these fields
was written by this instance's own lineage: it is accepted, and the result reports its format as
unidentified — only archives, which cross instances, need the override below.

**Pre-manifest archives need an explicit decision, or the reader rejects every archive that
motivated the feature.** A manifest-less archive is accepted only under an explicit super-user
override that records the operator's assertion of provenance, and the result reports the archive as
unidentified. The alternative — refusing them outright — makes the feature useless for exactly the
backups already sitting on operators' disks.

Implementation note: this unifies `createBackupStream`'s two branches. The `excludeBlobs` path hands
the whole archive to the binding, which gzips it directly (`dataLayer/rocksdbBackup.ts:704-709`), so
there is no tar-stream pack to prepend an entry to. Adding a manifest means routing both paths
through the plain-tar-then-gzip-here assembly `streamBackupWithBlobs` already uses.

### 7.2 A freshly restored transaction log is purged on startup

`purgeAgedLogs()` deletes every transaction-log file entirely before
`retentionCutoff() = Date.now() - auditRetention`, default **24 hours**
(`resources/auditStore.ts:112`, `:848`, `:861`). It is called from `replayLogs.ts:83`, reached from
`readRocksMetaDb` at `resources/databases.ts:982` — so it runs **on database open, during startup,
before replay**, not later by the steady-state cleanup loop. It also runs in elected mode, which is
why the restore policy in §5.7 step 5 gates it off.

Restore a backup older than the retention window and its transaction log is gone before the database
finishes loading. The logic is correct for a continuously-live log — its comment cites harper#1115, a
crash-looping node whose backlog grows because it never reaches steady state — and wrong for a
restored one, because retention keys on entry wall-clock time and a restored database's entries are
legitimately old.

Scope of the consequence, traced in both directions: a restored node **catching up** draws on its
_peers'_ logs, so this does not by itself break the migration workflow. What it breaks is the
restored node's ability to serve incremental history _to_ peers — a later join sources a full base
copy instead. `purgeLogs` also removes only files entirely before the last-flushed position, so
replay-required entries are never among them; this is lost _history_, not lost data.

**Demoted from prerequisite, and the fix an earlier draft proposed was wrong.** Exempting a freshly
restored database on first open does not hold: the steady-state cleanup loop purges against the same
`retentionCutoff()` (`resources/auditStore.ts:267-269`) and erases the exemption minutes later. A
correct fix is either retention measured from the restore generation rather than entry wall-clock
time — which is #2451's generation by another name — or an operator action: raise
`logging.auditRetention` to cover the backup gap before first open. So this is a real defect worth
filing, related to the archive work but not gating it, and its fix belongs with the generation
rather than in the startup path.

### 7.3 Backup management operations do not serialize (#2031)

Open, verified unfixed: no management lock exists. `createBackup` drops the engine writer lock when
`rootStore.backup()` resolves and then snapshots blobs and writes the manifest
(`dataLayer/rocksdbBackup.ts:374-392`), while `deleteBackup` and `purgeBackups` take no lock at all.

What this design needs from that surface is the **minimum** of #2031, and it is a prerequisite
(§9 item 4): a per-repository management lock held across pin installation, delete/purge from
admission through the last unlink, and the blob/manifest finalization of `create_backup` and
`import_backup` (§5.6). The binding's `.backup.lock` covers only the engine files, so without the
Harper-level lock a purge can still remove a blob snapshot or manifest out from under a pin check,
a running restore, or a finalizing backup. #2031's broader fix (serializing every management
operation end to end) can ship separately; this note only takes the part the restore routes cannot
do without.

### 7.4 `beginRestore()` can truncate a valid marker and unblock a half-purged database

`beginRestore()` opens the restoring marker with `openSync(markerPath, 'w')`, truncating it before
the database name is written (`dataLayer/restoreMarker.ts:193-199`), and `scanBlockedRestores()`
skips any marker whose first line is empty (`:272`). On a first attempt this is benign — nothing
destructive has run. On a **recovery** attempt, where `lock.preexisting` is true and the database
directory may already be half-purged from a failed restore, `beginRestore()` re-truncates the marker
that was correctly blocking it; a crash in that window leaves a half-purged database that loads as
healthy on the next boot.

Pre-existing, affects `restore_backup` today, and independent of the archive work — but the restart
route reruns `restoreBackupOffline` over exactly that marker (§5.7 step 3), so it must not be built
on the marker as-is. Fix by writing the marker temp → `fsync` → `rename`, so a torn write can never
replace a valid one; test the crash window on the replacement, and durability on Windows, where the
directory `fsync` is a no-op (`fsyncDir`, `:143-156`).

### 7.5 No boot-time job reconciliation exists

`server/jobs/` has no startup sweep: status transitions happen only in `jobRunner` (`IN_PROGRESS`,
`ERROR` on throw — `server/jobs/jobRunner.ts:108-131`) and in the job worker's own `finally`
(`server/jobs/jobProcess.ts:71-88`). A job whose worker dies with the process stays `IN_PROGRESS`
forever. `restore_backup` and `create_backup` already leave such rows under
`HARPER_EXIT_ON_RESTART`. §10's reconciliation is therefore new infrastructure, not a special case:
a generic boot sweep ships on its own. It needs **process-instance ownership** on the row (the
`componentPreparationLock` pattern: pid plus a per-boot instance id, so pid reuse cannot claim a
stale row), marks `IN_PROGRESS` rows whose owner is gone as `ERROR` (or an `INTERRUPTED` status),
handles the rows that exist today with no owner recorded, and **defers to a live restore intent**:
a job an intent names is owned by the hook, not interrupted.

### 7.6 `restore_backup` applies an engine-only backup over live blobs with only a log warning

`restoreBlobSnapshot` leaves the live blob roots untouched and logs a warning when a backup has no
blob snapshot (`dataLayer/blobBackup.ts:349-357`). That was deliberate — purging would strip blobs
the restored records reference — but it produces exactly the mixed generation §5.4 refuses for
archives: rolled-back records against current blobs, with dangling references as the common case.
Fix, as **one rule** for managed and imported backups alike (§5.4 states the same rule): an
in-place restore of a `blobs: false` backup over a database whose blob roots are non-empty is
refused unless the caller opts in explicitly (`allow_engine_only: true`, recorded in the job);
`target_database` is always allowed. Since §9 item 5's publication protocol includes in-place
restores of unheld databases, this gates items 5 and 6 as well as replacement imports (item 7) —
a prerequisite, not an adjacent fix.

### 7.7 Re-pointing `storage.backupPath` silently presents an empty repository

Every repository path is derived from `getBackupsRoot()` at call time
(`dataLayer/rocksdbBackup.ts:88-93, 120-123`), and nothing records which root a database's backups
were actually written under. Point `storage.backupPath` at a newly attached volume and restart —
the exact sequence §5.4 asks an operator to perform — and the old repository is not migrated, not
referenced, and not reported: `list_backups` returns `[]` from the `!existsSync(backupDir)` early
return (`:190-191`), and `restore_backup` fails to find ids that still exist on the old volume.
The failure is silent in the way §5.3 and §6 care about — an operator reads "no backups" as "there
were none", and a retention policy that counts what `list_backups` returns will happily conclude
the database has never been backed up.

This predates the design, but the design leans on the repository far harder than `create_backup`
alone did: #2636's management lock (`.management.lock`) and the restore pins that keep a recovery
source alive both live _inside_ `backupDir`, so a re-point also silently abandons the pins
protecting an in-flight restore's only rollback source. Fix: record the resolved root in the
repository (a small `.repository.json` written when the directory is created), and on mismatch
refuse the operation with a message naming both paths rather than reporting an empty repository.
The same record makes a deliberate migration checkable instead of a hope.

## 8. Concurrency

**Import.** One import per database at a time, and one instance-wide, so the disk arithmetic in
§5.3 compares one incoming budget against available space; tracking every in-flight import's
declared size and subtracting the set from available space is more code and less trustworthy,
since the declared sizes are advisory. The engine phase additionally holds the binding's
`.backup.lock`.

The lock cannot be a process-owned flock taken on the HTTP worker thread. `restoreMarker.ts` says
why: "if the restore job's worker _thread_ dies without the process exiting, the lock stays held
(restores 409) until Harper restarts" (`:41-46`). HTTP workers are restarted routinely —
`deploy_component` with restart and `restart_service` both do it (`bin/restart.ts:330`) — and
`worker.terminate()` runs no `finally`. So the import lock is **owned by the main thread**: the
worker asks over ITC, main takes `tryFileLock`, and main releases it on the worker's `exit` event.
`restartWorkers` treats an in-flight import the way it already treats a component preparation and
waits on it (`withComponentPreparationLock` is the precedent, and its lease-with-owner-liveness
file is the alternative implementation if ITC ownership proves awkward).

**Staging changes hands once, before the job exists.** The HTTP worker creates
`<repo>/.import/<importId>/` and writes an owner record beside it (worker thread id, process
instance id). When the upload completes, the handler asks the main thread — over the same ITC
channel as the lock — to **adopt** the staging area: main rewrites the owner record to the import
id, fsyncs it, and only then does the handler insert the job row, whose request carries that import
id. Job insertion and job launch are separate steps (`server/jobs/jobs.ts:200-210`,
`server/jobs/jobRunner.ts:151-155`), so a worker that dies after enqueueing but before a
post-enqueue rewrite would otherwise leave staging still marked as its own — and the exit sweep
would delete a running job's input. With adoption first, the worker-exit sweep removes staging only
when the owner record still names that worker; the job removes it on completion or failure; the
boot sweep removes any staging whose import id matches no job the boot sweep (§7.5) left alive. A
crash between "upload complete" and "adopted" leaves worker-owned staging, which the exit sweep
removes — the operator re-uploads, and nothing half-owned lingers.

A second import for the same database while one is running is **refused**, naming the running one.

**Restart route.** The per-database restore lock is taken by `restore_backup` as today for
validation and released before the restart; the intent file, not a lock, is what survives the
process, and it is what pins backup ids (§5.6). At boot the hook takes the lock again through
`restoreBackupOffline`. `resume`, `supersede` and `cancel` are the only operations accepted on a
pending or terminal intent (§5.6).

## 9. Work breakdown

| #   | Work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Depends on    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 1   | [#2633](https://github.com/HarperFast/harper/issues/2633) — §7.1 — capability manifest as the archive's first entry, the same fields (plus role names) in the managed backup manifest, the compatibility rule, and the pre-manifest override policy. Ships first: every archive already in the field is unidentifiable, and that set only grows.                                                                                                                                                                                                                                                                                                                                                                                                                                                           | —             |
| 2   | [#2634](https://github.com/HarperFast/harper/issues/2634) — §7.4 — `beginRestore()` writes the restoring marker temp → `fsync` → `rename` so a torn write cannot replace a valid one. Fixes `restore_backup` today; both routes rerun over that marker.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | —             |
| 3   | [#2635](https://github.com/HarperFast/harper/issues/2635) — §7.5 — generic boot-time job sweep with process-instance ownership, existing-row handling, and deference to a live restore intent. Fixes `create_backup`/`restore_backup` rows under `HARPER_EXIT_ON_RESTART` today.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | —             |
| 4   | [#2636](https://github.com/HarperFast/harper/issues/2636) — **Repository operations without a loaded database, the repository management lock, and pins** (§5.5, §5.6, §7.3) — `list`/`verify`/`delete`/`purge` take the directory-only path when the database is absent or blocked; a per-repository lock covers pin installation, delete/purge through cleanup, and blob/manifest finalization; `delete_backup`/`purge_backups` refuse pinned ids. The minimum of #2031. Both later routes depend on it.                                                                                                                                                                                                                                                                                                 | —             |
| 5   | [#2637](https://github.com/HarperFast/harper/issues/2637) — **Publication protocol and online create-if-absent** (§6) — the restore lock as a real exclusion (shared on open paths, exclusive for restore, absence re-checked after reservation), the apply helper that leaves the marker, engine restore, blob restore, inventory check and private open, expected-table check, restore-strict elected replay in the job worker (with `purgeAgedLogs` gated off), blob-completeness decision, peer fence and re-check, durability barriers, idempotent finalization; `restore_backup` in place for an unheld database and `target_database` online both go through it. The generation (item 8) is minted here or lands first.                                                                             | 2, 4, 8, 9    |
| 6   | [#2638](https://github.com/HarperFast/harper/issues/2638) — **Restart route** (§5.6, §5.7, §5.8) — `on_restart`, the intent state machine with `committed`-before-publication and idempotent finalization, pins, the boot hook after `getTables()` with discovery blocked by the intent, core-side peer check, engine steps in the child without the `LOCK` probe, pre-restore backup captured once while `pending`, no-exit retries, `terminal` with file-triggered safe mode and `HARPER_SAFE_MODE` docs, `resume`/`supersede`/`cancel`, rolling drain before exit, job reconciliation. Independently useful for managed backups on Fabric.                                                                                                                                                              | 3, 4, 5, 8, 9 |
| 7   | [#2639](https://github.com/HarperFast/harper/issues/2639) — **`import_backup`** (§5.2–§5.5, §8) — multipart and pull sources with the credential rules, staging at `<backupsRoot>/<db>/.import/<importId>/` with the mount-point invariants (never remove `.import`, device-id ledger grouping and re-check), adopted by main before the job exists, entry/inode/path limits, the single disk ledger with block-rounded per-entry debits and an inode budget, the out-of-process engine-level validator with the column-family inventory, `db.backup()` into the repository, blob snapshot from staging, manifest with expected table set and provenance, directory-only verify, eager cleanup, main-thread lock ownership. Ends at "a verified backup id"; independently testable without ever restoring. | 1, 4, 9       |
| 8   | #2451 — the database generation. Either this lands first, or items 5 and 6 mint one at the same point (§5.9).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | —             |
| 9   | [#2640](https://github.com/HarperFast/harper/issues/2640) — §7.6 — one rule: refuse an in-place restore of an engine-only backup over non-empty blob roots without an explicit opt-in. Fixes `restore_backup` today; every in-place route (items 5, 6, 7) relies on it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | —             |
| 10  | §7.7 — stamp the resolved root into the repository and refuse on mismatch, so re-pointing `storage.backupPath` at an attached volume reports the abandoned repository instead of an empty one. Fixes `list_backups`/`restore_backup` on `main` today; item 4's lock and pins live inside that directory, so a silent re-point also abandons them.                                                                                                                                                                                                                                                                                                                                                                                                                                                          | —             |

Items 1–4, 9 and 10 each fix something on `main` today, before any archive is ever imported. #2033
(§5.4) is adjacent and not a dependency; #2031 is a dependency only in the minimum form item 4
carries (§7.3). The two PRs
that carry the user-visible feature are item 5 (create-if-absent / restore into a new name) and
item 6 (replace an existing, held database).

## 10. Outcome reporting

`import_backup` returns a job id (push: once the archive is fully on disk; pull: immediately) and
the job's result carries the backup id, the expected table set, the role names from the manifest
that do not exist locally, whether the archive was identified or accepted under the pre-manifest
override, the computed digest and `imported_from`, and any capture substitutions the producer
recorded (§11).

`restore_backup on_restart=true` returns a job id before the restart, and the restart closes the
connection — the operations server already sets `Connection: close` for restart operations
(`server/operationsServer.ts:341`). So the job row cannot be updated by the process that created it,
and the CLI must reconnect and poll.

The outcome is written in a fixed order: the intent reaches `committed` (or records a failed
attempt, or `terminal`) **first**, fsynced, and the job row is updated from it **second**, once
`system` is up. The intent is authoritative because it is readable before `system` loads and
survives a crash between the two writes; reconciliation copies from it and never re-applies a
`committed` restore. A `committed` intent whose job row never got written is finished by the next
boot's hook, which runs finalization alone — marker clear, publish, job row, intent delete, each
idempotent (§5.7 step 8) — so success cannot stay blocked behind a marker and the job cannot read
failed; the generic sweep (§7.5) treats a job an intent names as owned, so it cannot mark the job
failed underneath a successful restore. Without the intent copy
the operation's observable result is "Harper is restarting" followed by silence, and the operator is
left polling `get_status` and guessing.

## 11. Open questions

1. **Producer-side blob capture.** `create_backup` and `get_backup` substitute PENDING/ERROR
   markers for blobs that were not capturable whole, and a blob reclaimed before its parent
   directory is enumerated is absent from the archive with no marker at all
   (`dataLayer/blobBackup.ts:30-40`). The restore side is decided (§5.7 step 6: scan or an explicit
   waiver, recorded); what stays open is whether the producer should close the enumeration race
   itself, which is a `create_backup` defect the restore surfaces rather than causes.
2. **Fetch-policy default.** The shared fetch helper's deny list (§5.2) cannot ship strict by
   default without breaking private-endpoint pulls that work today; the compatibility path is a
   separate decision with its own coverage.
3. **Durability on non-POSIX platforms.** §5.7 step 7's barriers rely on file and directory
   `fsync`; where directory fsync is a no-op (Windows) the `committed` record can in principle
   outlive an un-synced blob after a power loss. The note states the limit; whether to refuse the
   restart route there, or accept and document, is open.
4. `verify:` items still open: `HARPER_EXIT_ON_RESTART` on Fabric (§5.6); what the Fabric ingress
   does with a multi-GB multipart body (§5.2); the `bodyLimit` non-enforcement, likely but untested
   (§5.2); whether host-manager restricts tenant egress (§5.2). None changes the shape.

Resolved since round 1: the retention policy for the retained copy (§5.8 — `purge_backups
keep_count`, once unpinned), whether a management-capable safe mode exists (§5.6 — it does,
env-only), whether `backups.verify` covers Harper's indexes (§5.5 — it does not), and whether blob
completeness is a claim or a report (§5.7 — a scan, or a recorded waiver).

## 12. Verification route

- **Unit** — entry-filter rejection table (`..`, absolute, symlink, hardlink, device, duplicate
  name, over-long path, entry-count and inode limits); advisory-size handling for exact, estimated,
  absent and hostile values; the disk budget against a frozen quota sample (stale headroom, sample
  refresh, `EDQUOT` mid-write); capability-flag refusal matrix including the pre-manifest override
  and a managed manifest without the fields; intent state machine round-trips including a torn and a
  malformed intent failing closed, `committed` surviving a crash before the job-row write, and
  `resume`/`supersede`/`cancel` from each state, including `cancel` after destructive work leaving
  the marker; attempt counter reaching `terminal` without an exit; the ledger across phases against
  a delayed sample refresh; pins refusing `delete`/`purge` and a delete paused across a pin install;
  the column-family inventory check on a catalogue naming a dropped family; the boot job sweep with and without ownership metadata and with a
  live intent; the peer predicate over `hdb_nodes` rows and `routes` entries; the restore-strict
  replay policy on a log with valid framing and an undecodable value.
- **Integration** — a real CLI `get_backup` → `import_backup` (push and pull, including into a
  database that does not exist) → directory-only `verify_backup` → `restore_backup` online into a
  new name with blobs, then `on_restart=true` in place → supervised process exit and restart →
  record _and blob_ reads, which is the only shape that proves the feature; an opener paused between `throwIfBlockedByRestore` and its open while a restore reserves the
  name, and a rescan and a `create_table` racing an online restore into a new name (the shared lock
  holds them off); a kill between the pre-restore backup's completion and its id being pinned, and
  between the pin and the first destructive write (the retry reuses the pinned id and never
  recaptures); sparse blob root
  indices across separate volumes; kill injection during import (staging swept, ownership handoff
  honoured) and at every step of the hook (marker and intent keep the database blocked; a rerun
  completes); kill between `committed` and the job-row write, then write new data and restart again
  — nothing re-applies, and the marker is gone; a rollback whose content is asserted equal to the
  last acknowledged pre-restart write; a writable restart after every recovery path; strict replay failure and an undecodable value both rejected before
  publication; a blob missing from the source without a marker caught by the scan and reported
  under the waiver; engine-only restore refused in place and allowed as a copy; concurrent
  `purge_backups` against a pinned id; malformed, legacy and pre-manifest archives; inode exhaustion;
  a peer appearing between the request and boot; a corrupt _old_ destination at boot that is nonetheless replaced on the next attempt (no probe at
  the hook); a peer or route added after online admission while the name is reserved (fenced, and
  caught by the pre-publication re-check); a worker killed between enqueue and adoption (staging
  survives for the job) and between adoption and enqueue (staging is swept); an HTTP worker restart mid-upload releasing the import lock and sweeping staging; the
  rolling drain on the restore restart; a terminal boot serving the operations API in safe mode and
  recovering entirely through the API (`supersede` to the pre-restore backup); unsupervised startup
  (no orchestrator) after a failed attempt; `retain_previous=false` recorded in the job; a pull
  from a private endpoint under the default fetch policy; Windows marker durability; unrelated
  request latency measured during extraction, conversion, and online publication/replay,
  including a `threads: 0` install.
- **Live smoke on Fabric**, with recorded evidence: a real `get_backup` archive from one instance
  pulled from object storage into another, restored first into a new name and then in place,
  including GTM behavior across the drained restart.
- §7.4 needs a fails-on-base check: a torn marker write must leave the database blocked.

Rollout order: producer manifest first; then repository operations and pins; then the publication
protocol with restore into a new name (it stands alone and is the safest mode); then the restart
route; then a feature-gated `import_backup`; then Fabric canary evidence.
