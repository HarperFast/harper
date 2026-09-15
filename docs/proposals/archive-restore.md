# Restoring a `get_backup` archive into a running Harper (incl. Fabric)

Design note. No issue yet — this note is the input to filing them (§9). Supersedes the rationale on
[#995 `import_backup` operation](https://github.com/HarperFast/harper/issues/995), closed
2026-07-31 with "at this time, we don't want to introduce restoring backups while Harper is
running"; [#1831](https://github.com/HarperFast/harper/pull/1831) landed `restore_backup` doing
exactly that the following day.

## Planning-review history

| round           | verdict                 | what it changed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 (`88498550c`) | `chosen-approach-sound` | Framing cleared; seven blockers against under-specification. Adopted: the marker is not a journal (§5.6), blob staging must be per-volume (§5.4), the retained database must be scan-invisible (§5.8), validation must await strict replay because the load path does not (§5.5, §5.7), intake cannot be a standard job operation (§5.6), super-user must be enforced in the handler (§5.1), and archive limits must bound entries/inodes, not only bytes (§5.4). Also adopted: refuse-on-peers does **not** close #2451 (§5.9), engine-only replacement restores must be refused (§5.4), and pre-manifest archives need a decided policy rather than an open question (§7.1). §7.2 was demoted — its one-boot fix was wrong. Two citations overruled: a `DESIGN.md:250-254` reference that does not exist, and #2031 as a hard dependency. |

Every behavior claim below is traced in `origin/main` at `52512e85a`. Claims I could not trace are
marked `verify:` and are not load-bearing for the chosen design.

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
  running (`dataLayer/rocksdbBackup.ts:500`, and again at `:536`), so the non-destructive route is
  unreachable on a live tenant.
- **"Stop the server" is not an operator action.** `verifyDatabaseClosed`
  (`dataLayer/rocksdbBackup.ts:624`) forces the offline CLI path whenever a loaded component holds
  a handle, and always for `system`. On Fabric, stopping Harper is a host-manager action.

## 2. What already exists

Most of this is assembly, not invention. Traced:

| Need                           | Existing primitive                                                                                                                                                                                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Streaming upload               | `multipart/form-data` content-type parser handing the handler a `Readable` for the file part, added for `deploy_component` in 5.1.0 — `server/serverHelpers/multipartParser.ts`, registered at `server/serverHelpers/contentTypes.ts:263`; CLI side `bin/multipartBuilder.ts` |
| Field-before-file ordering     | Documented contract: field parts populate the body, the file part is last and named `payload`, "so all dispatching fields have arrived by the time the route handler runs" (`multipartParser.ts:18-30`)                                                                       |
| Quota-aware free space         | `getStorageSpaceStats(path)` → `{available, free, size, basis: 'quota' \| 'filesystem'}`, preferring host-manager's `quota-status.json` over `statfs` because statfs misreports a quota-limited data directory (#1976) — `server/storageReclamation.ts:160`                   |
| `.tar` / `.tar.gz` extraction  | `pipeline(tarball, gunzip(), extract(dir))` — `components/Application.ts:878`; `gunzip-maybe` + `tar-fs`, both already dependencies                                                                                                                                           |
| Restore lock + marker protocol | Per-database flock, `.restoring` marker, `checkRestoreState()` → `in-progress \| incomplete \| clear`, `scanBlockedRestores()` — `dataLayer/restoreMarker.ts`; the startup scan already consults `databasesBlockedByRestore` at `resources/databases.ts:589` and `:653`       |
| Stage-then-rename              | `MIGRATING_DIR_SUFFIX = '.migrating'` (`utility/hdbTerms.ts:165`), skipped by both startup scan loops (`resources/databases.ts:580`, `:650`), already used by `bin/copyDb.ts:726`                                                                                             |
| Blob root-index mapping        | `blobs/<rootIndex>/<shard1>/<shard2>/<fileId>`, and `assertBlobSnapshotRestorable` refusing a snapshot with more roots than the current config                                                                                                                                |

**The fact that makes archive restore tractable at all:** a database's schema is self-describing.
Table and attribute definitions live in an internal column family inside the database directory and
are read straight off it on load — `initStores` iterates `attributesDbi.getRange({ start: false })`
at `resources/databases.ts:1064`. Laying down a database directory brings its schema with it; there
is no `system`-database state to reconstruct.

## 3. The invariant

> A database directory becomes visible to Harper only after its contents have been opened and
> enumerated successfully, and only while no other copy of that database is loaded.

Both halves are load-bearing. The first is what every prior defect on this surface violated:
`create_backup` reporting a `backup_id` for a purged engine backup (#2031) and `copy-db` exiting 0
on a non-restorable copy (#2048) are the same shape — success reported on an artifact nobody
opened. The second is why the swap happens at startup rather than online.

## 4. Approaches considered

**Different layer — host-manager mounts the archive into the container; Harper restores from a
local path.** Rejected on a concrete cost: it makes every restore a control-plane operation
requiring a CM/host-manager change per restore, and it does not serve self-managed installs at all,
which is where `get_backup` archives are most likely to be produced. It also leaves the actual
problem (nothing consumes the archive format) unsolved — it only changes who carries the file.

**Deeper cause — stop producing an unrestorable artifact.** The real upstream defect is that
`get_backup` emits a format with no consumer. The maximal version of this axis is to delete
`get_backup` and tell operators to use `create_backup`/`restore_backup` only. Rejected: the archive
is the only backup form that leaves the instance, which is precisely what a machine migration or an
off-box retention policy needs — a managed backup repository under `storage.backupPath` dies with
the host. But this axis yields a real prerequisite that is adopted below: the archive carries no
machine-readable identification of what produced it, so a restore cannot refuse an incompatible one.
That is fixed first and independently (§7.1).

**Do less — document the manual laydown properly and ship nothing.** This is the status quo plus a
docs PR. Rejected on a named invariant: the manual route requires the operator to reproduce the
blob root-index mapping by hand, and getting it wrong mis-addresses every file-backed blob in the
database because records persist the root index, not the path (`blobsReadmeContent`,
`dataLayer/blobBackup.ts:228-250`). Handing an operator a destructive multi-step procedure whose
failure mode is silent blob mis-addressing is not a smaller change, it is an unbounded one. The
partial form of this axis _is_ adopted: restore is refused, not designed around, wherever it would
have to reason about cluster state (§5.9).

Two further alternatives were tested during planning review and rejected on facts:

- **A rocksdb-js `import tar into managed repository` primitive.** It would improve engine-level
  validation by reusing the binding's own backup machinery, but it cannot coordinate blob roots,
  which live on volumes outside the engine's knowledge and are addressed by a persisted root index,
  nor component-held handles. It is a component of a solution, not a replacement for one.
- **Provision a new Fabric instance from the archive and cut routing over.** Operationally safer —
  no in-place swap at all — but it changes instance identity and control-plane state, requires a
  CM/host-manager change per restore, and does not serve self-managed installs, which is where
  `get_backup` archives are most likely to be produced.

**Chosen — a streaming upload operation that extracts and validates out-of-process, then hands the
swap to the next startup.** The single fact that beats each rejection: the swap must happen while
no copy of the database is loaded, and startup is the only point where Harper can guarantee that
for `system` and component-held databases alike — which is exactly the set the online path already
refuses (`verifyDatabaseClosed`, `dataLayer/rocksdbBackup.ts:624`).

## 5. Design

### 5.1 Scope

**In:** a `restore_backup`-family operation accepting a `get_backup` archive over a streaming
multipart upload; extraction, validation, the startup swap, rollback, and reclamation of the
displaced database.

Authorization is enforced **inside every handler** — intake, rollback, resume, reclamation — with
`requireSuperUser()`, matching `dataLayer/rocksdbBackup.ts:82` and the existing backup operations.
Declarative `requires_su` metadata is not sufficient on its own: #2175 records that operation
allowlist grants are gate-inert for operations registered without an `api_name`, so a metadata-only
gate can be bypassed. An operation that accepts filesystem content and restarts the node is the
worst place to discover that.

**Out:** engine-only archives as _replacement_ restores (see §5.4); the `system` database (an archive of it carries users, roles, components and deployment
rows — a different and much riskier operation); LMDB archives (`get_backup` on LMDB returns the raw
`.mdb` file, not a tar — `bin/backup.ts:152`, so a `.tar[.gz]` is by definition a v5 RocksDB
artifact); v4 migration, which keeps its existing path; and any restore onto a node with peers
(§5.9).

### 5.2 Transport and the declared size

Multipart streaming upload, reusing the `deploy_component` machinery. The declared uncompressed
size is a **field part**, not an `x-` header: the part-ordering contract already guarantees fields
arrive before the file, so the size is available before the first archive byte reaches disk.

The declared size is **advisory** — an early reject so a 50 GB upload fails in seconds rather than
after transferring. It cannot be a gate, because it is client-supplied; a wrong or hostile value
would otherwise pass the check and fill the disk mid-extract, which is the #2095 false-green pattern
this surface keeps reproducing. Consequences:

- Plain `.tar` — exact size from `stat`, free.
- `.tar.gz` — the CLI may send a conservative estimate (compressed size × factor) or compute the
  exact figure by inflating through a fixed buffer and summing tar entry sizes. That pass is O(1)
  memory but must inflate every byte, since gzip is not seekable; it is a local-disk cost, not a
  network one, and it is optional precisely because the value is advisory.
- A request with **no** declared size is accepted. It fails late instead of early, which keeps the
  operation usable from `curl` rather than only from the Harper CLI.

_Not traced, and not load-bearing:_ `verify:` Fastify's `bodyLimit` (default 1 GB,
`server/operationsServer.ts:41`) is not enforced on the streaming multipart path. The parser's own
comment says the design exists "so `deploy_component` payloads can exceed the 2 GB Buffer cap"
(`contentTypes.ts:260`), which implies it, but confirm before relying on it.

### 5.3 The disk gate

Two checks, both via `getStorageSpaceStats()`:

1. **Pre-flight**, against the declared size, before accepting the body.
2. **Continuous**, during extraction, aborting below a floor. This is the authoritative gate and is
   honest whether the client was accurate, sloppy, or hostile.

The continuous check meters _extracted bytes_ on every chunk but refreshes the statistics only past
a byte/time threshold. `getStorageSpaceStats()` reads quota state, resolves paths, and may call
`statfs` (`server/storageReclamation.ts:160-185`); calling it per chunk or per tar entry would put
filesystem work on the operations worker for the length of a multi-gigabyte upload and degrade
unrelated traffic. Tar, zlib and validator modules are lazily loaded so ordinary startup and request
paths pay nothing for this feature.

Space is gated **per destination volume**, not once: see §5.4.

Treat `basis: 'filesystem'` as lower confidence and add margin — it means either no
`quota-status.json` or a stale one (>5 min, `QUOTA_STATUS_MAX_AGE_MS`), so the number may describe a
shared volume rather than this tenant's quota.

**Required free space is the size of the incoming database, not a multiple of it.** The extracted
tree and the existing database coexist until the swap; the displaced database is then _renamed_
aside, not copied, so it occupies the same bytes it already did. Total occupancy peaks at
`size(restored) + size(existing)` and stays there until the reclamation operation runs (§5.8), but
the _additional_ space the gate must find is `size(restored)` plus margin.

### 5.4 Extraction and staging

Decompress the upload stream directly to disk into staging areas — no intermediate copy.

**Staging is per destination volume, not one directory.** `storage.blobPaths` may name several roots
on several filesystems, and records persist the _root index_, not the path. A single staging
directory beside the database therefore turns each blob "move" into a cross-filesystem copy, and a
crash mid-copy can publish new engine files alongside partially copied blobs. So: the engine tree
stages on the database root's filesystem, and each `blobs/<rootIndex>/` tree stages on the
filesystem of the blob root it is destined for. Space is gated separately on each. Every rename is
journaled (§5.6).

Each staging area must be on the same filesystem as its destination, or the swap degrades from a
rename to a copy and loses its crash properties (`extractTarballInto` documents the same constraint
for its scratch dir, `components/Application.ts:867`).

Placing it outside the database root, rather than using `<name>.migrating` inside it, means the
startup scan cannot see it at all — so the design does not depend on the reserved-name skip
behaving correctly. That matters: #2033 is an open bug about that skip mishandling a directory that
looks like a database.

Entry filtering is explicit, not inherited: reject `..`, absolute paths, symlinks, hardlinks and
device nodes rather than trusting `tar-fs` defaults. Tar extraction of operator-supplied bytes is a
path-traversal sink.

**Byte limits are not sufficient — bound the entry set too.** The multipart parser deliberately
enforces no file-size cap: "Operation handlers stream the file part directly into extraction
(gunzip + tar-fs), so there is no separate filesize cap to enforce here ... bounded by disk space
rather than memory" (`server/serverHelpers/multipartParser.ts:15-17`). Disk _bytes_ are therefore
the only ambient bound, and millions of zero-byte entries exhaust inodes without ever crossing the
free-byte floor. Enforce, per archive: entry count, total actual uncompressed bytes (metered, not
declared), per-entry size, path length, and duplicate entry names.

**Engine-only archives cannot be replacement restores.** An archive created with `exclude_blobs`
carries no blobs, so restoring it over an existing database rolls records back while leaving the
current blob roots in place — a mixed generation, in which a blob id reused since the backup point
resolves to unrelated bytes. Reject `exclude_blobs` archives for replacement; they remain valid for
create-if-absent, where there are no pre-existing blobs to disagree with. A related producer-side
gap stays open (§11).

Intake failure removes its staging areas **eagerly**, not at the next startup: a startup-only sweep
lets repeated disk-floor or malformed-archive failures accumulate quota while Harper keeps running.
The startup sweep remains, for the crash case only.

### 5.5 Validation, out of process

A purpose-built validator entry point — the way `bin/copyDb.ts` is a purpose-built CLI, **not**
`harper` with `rootPath` pointed at the temp directory. A full instance spawn would try to become a
whole Harper (config, components, servers, `system`), and `initStores` stamps
`rootStore.databaseName` from `storeName`, which is what blob-root resolution keys off
(`resources/databases.ts:996-1002`, `:1017`) — so a full spawn would start resolving and creating
blob roots for a temp name.

The validator opens the staged directory read-only, enumerates the internal DBI for table
definitions, opens each table's stores and indices, **awaits a strict transaction-log replay**,
prints JSON, exits.

The strict replay is load-bearing and belongs here rather than in the live load path, because the
live load path cannot report it: `readRocksMetaDb` is synchronous and calls `replayLogs()` without
awaiting it (`resources/databases.ts:982`; `replayLogs` returns `Promise<void>`,
`resources/replayLogs.ts:60`). Boot replay is also deliberately more tolerant of a damaged tail than
strict branch replay is. So an archive with a valid table catalogue and a failing log tail would
otherwise match the expected table set, be reported successful, and serve rewound data. Doing the
strict replay in the validator gets the guarantee without making synchronous `getDatabases()`
globally async for one feature.

The validator is resource-bounded: wall-clock runtime, stdout/stderr size, memory, and file
descriptors, with an explicit kill. Signal death, timeout, and malformed output are all validation
_failure_ — otherwise a crafted archive can hang the validator while holding the instance restore
lock.

Out-of-process rather than in-process, despite `initStores(path, rootStore, name, { destination,
storeName, openedStores })` already supporting exactly this shape — `destination` builds Table
classes privately without publishing to the global map or emitting a schema event, and
`openedStores` exists so a caller can release stores a failure left unreachable
(`resources/databases.ts:992-1008`). Two concrete disqualifiers for reusing it here:

- That machinery is built for _trusted local_ data (branch databases). A malformed RocksDB does not
  reliably throw — it can abort the process. Validating operator-supplied bytes in the live process
  makes a bad upload a tenant-visible outage.
- rocksdb-js's handle registry is process-global by path (per the contract note on
  `verifyDatabaseClosed`, `dataLayer/rocksdbBackup.ts:617-623`), so opening the staged directory in
  the live process registers that path and the swap would have to guarantee release first.

A non-zero exit _or_ a signal death both mean validation failed, and the serving process survives
either. This is also the natural home for the opt-in deep scan below.

**Depth.** Structural validation is O(tables) and catches the realistic failure — a truncated or
over-filtered archive missing a column family. Full index-versus-primary consistency is O(data) and
must be opt-in: #2211 shows index divergence is a real class, but a full scan is not affordable on
every restore of a large database. `verify:` rocksdb-js's own `backups.verify` covers tables and the
transaction log but not Harper's index structures — asserted by the author, not traced (rocksdb-js
is not vendored in this checkout).

Validation records into the marker the **expected table set**, which is what post-swap load success
is later compared against (§5.7).

### 5.6 Restore intent and the restart

The operation writes the intent, inserts a job row, returns the job id, and requests a restart.

**The intent lives beside the restore marker, in a new versioned journal — not in config, and not in
the marker itself.**

Config is the easier rejection: writing the intent into `harperdb-config.yaml` adds a
read-modify-write of a shared YAML document to a crash-sensitive path, and a stale flag re-triggers
a restore on every boot.

The marker is the more interesting one, because an earlier draft of this note proposed extending it
"by one field". It cannot be: `beginRestore()` opens the marker with `openSync(markerPath, 'w')` —
which truncates before the name is written — and then writes two lines
(`dataLayer/restoreMarker.ts:193-199`), while `scanBlockedRestores()` skips any marker whose first
line is empty (`:272`). A kill between the truncate and the write therefore yields a marker that
blocks nothing. For the _current_ restore path that is benign on a first attempt, since nothing
destructive has happened yet — but on a recovery attempt over a half-purged directory
`beginRestore()` re-truncates an already-valid marker, and a crash there turns a correctly-blocked
half-purged database into one that loads as healthy. **That is a pre-existing defect in
`restore_backup` today** and is filed separately (§7.4). Building a swap protocol on top of it would
inherit it.

So: a separately versioned journal, written temp → `fsync` → `rename` → parent `fsync`, holding the
generation id, the exact source/destination/retained paths for the engine tree and every blob root,
the current phase, the attempt count, the job id, and the archive digest — re-persisted after every
rename. Malformed or torn journal data **fails closed**: the database is blocked, never loaded. The
marker keeps its existing job of blocking the database; the journal carries the intent.

Recording every intended move is what makes the swap **idempotent and resumable** rather than
atomic. Concurrency is not the hazard (nothing is loaded); crash-during-swap is. A power loss
between the engine rename and the Nth blob-root move must re-run to completion on the next boot
rather than leave a restored database pointing at pre-restore blobs.

**Intake cannot be a standard job operation.** `jobs.addJob()` persists the request into the job row
so the job process can read it — `newJob.request = jsonBody` (`server/jobs/jobs.ts:200`) — and a
`Readable` does not survive that. The upload stream must therefore be consumed in the request
process, which persists only scalar staged metadata; the job row is a status surface, and journal
and job state are reconciled after the restart. This is a real divergence from how `create_backup`
and `restore_backup` are structured, so it is a named API decision rather than an inherited
pattern.

**The restart is orchestrator-driven on Fabric, which makes the failure path a crash loop.** Under
`HARPER_EXIT_ON_RESTART`, `restart` is `process.exit(0)` — the comment says "use this to exit the
process so that it will be restarted by the PM/container/orchestrator" (`bin/restart.ts:162-166`).
So "trigger another restart and roll back" is not a call the code makes; it is the orchestrator
restarting Harper, repeatedly, indefinitely. The protocol therefore needs:

- an attempt counter persisted in the marker, and
- a **terminal state that starts Harper successfully with the database blocked and unloaded**,
  logging loudly — not another exit.

The existing protocol already lands there: a failed restore keeps the marker, `databasesBlockedByRestore`
keeps the database out, and the operator reruns. That is the floor of the retry ladder.

**That the terminal state starts Harper successfully is an assumption this design owes a proof.** A
component that requires the blocked database during application load can fail every HTTP worker, and
the Fabric crash loop returns by another route. Either demonstrate that component startup tolerates
a blocked database, or define a management-capable safe mode that serves the operations API with
applications unloaded. Until one of those exists, the retry ladder has no floor.

`verify:` host-manager sets `HARPER_EXIT_ON_RESTART` for Fabric containers. It is set only in
`.github/workflows/docker-smoke.yml` in this repo; the inference is from the code comment.

**Draining.** A restart that is `process.exit(0)` with nothing draining the node first drops
in-flight traffic on every restore. Harper owns the drain (author's call): fail the health check,
wait a configurable interval for GTM to notice, then exit. `verify:` whether any drain happens on
the current restart path.

### 5.7 What counts as loaded

"No exception thrown" is the cheap proxy and it is #2095 group 4 — the same shape as #2031 and
#2048. The honest check, run after load and before anything irreversible:

- the table set enumerated after load matches the set validation recorded in the marker, and
- every one of those tables' stores actually opened.

Transaction-log replay is **not** proved here. The archive carries `transaction_logs/` and
`replayLogs()` does run on open, but it is invoked without `await` from a synchronous
`readRocksMetaDb` (`resources/databases.ts:982`), so the load path cannot observe whether it
succeeded. Replay success is established in the validator, before publication (§5.5); this check
confirms the published generation is the validated one, not that a fresh replay went well.

### 5.8 Rollback and reclamation

The displaced database is **not deleted automatically.** It is renamed under a reserved,
scan-skipped directory — not to an ordinary sibling — and its location is reported in the operation
result; a separate operation reclaims it.

The reserved location is required, not tidiness: the startup scan opens _any_ directory containing
`CURRENT` plus `MANIFEST-*` as a database (`resources/databases.ts:602-609`), so a retained tree
renamed to `<name>.previous` beside the live one would be discovered and loaded as a second
database. `RESTORE_META_DIR` is the existing precedent for a name the scan skips — and #2033 is the
open bug about that skip being silent, which this design should not make load-bearing without
fixing.

The failure this survives is not a corrupt restore — validation catches those — but a _technically
successful, semantically wrong_ one: right database, wrong backup, wrong point in time. In disaster
recovery that is very live, and the displaced tree is the operator's only copy of the pre-restore
state. Auto-deleting it on a passing automated load check makes that the single irreversible step in
the flow, decided by a heuristic.

Keeping it also makes rollback trivial: rollback is a rename-back, not a restore. If the restored
database fails §5.7's check, the swap reverses from the same marker, on the same resumable
protocol.

### 5.9 Replication: refuse rather than reason

**A restore is refused on a node that has peers.** This removes the entire divergence class: restore
node A to yesterday while B and C hold today, and replication either re-pushes today's writes onto A
(the restore is silently undone) or pushes yesterday's onto B and C (the blast radius grows from one
node to the cluster). Neither is what the operator asked for, and choosing between them is not a
decision a restore operation should be making.

This is compatible with the two real workflows:

- **Machine migration** (move a node to bigger hardware) — back up on the old machine, restore on the
  new one _while it is standalone_, then join. The restore happens before the node has peers.
- **True disaster recovery** — a single node is restored, and the admin adds the second node
  afterwards, at which point ordinary replication seeds it.

The check must be **re-asserted at swap time**, during startup before the swap, not only at upload
time _and before replication starts_: a peer can be added between staging and the restart, so an
upload-time check alone is check-then-act. Finding peers at boot lands in §5.6's terminal blocked
state, not in a swap. Admission refuses on **any configured peer other than self**, not on "has
previously connected" — connection history is exactly the check-then-act state this is trying to
avoid.

**This restriction does not close #2451, and an earlier draft of this note implied it did.**
[#2451](https://github.com/HarperFast/harper/issues/2451) is that a restore rolls a database back in
time with no generation marker, so audit retention floors, record versions, and per-node replication
sequence records all come back at the backup's values and read as valid. Two of those three bite on
a _single_ node: a local MQTT durable subscriber holding a cursor from after the backup point
compares it against the restored (older) audit floor, reads it as safe, resumes, and waits for
entries that no longer exist. Refusing peers removes the cross-node divergence; it leaves every
local resumable consumer intact and wrong.

So archive restore must either land after #2451, or mint a database generation itself at the same
single point in the swap sequence and force local consumers to resync. It cannot be silent about it.
(A planning-review citation of `DESIGN.md:250-254` for this does not check out — those lines
describe record-lock upgrades, and DESIGN.md carries no generation note. The substance is #2451
itself, read directly.)

### 5.10 Roles

Schema is self-describing but the roles granting access to a database live in `system`. A restored
or newly created database therefore arrives with no role granting anything on it, so nobody but a
super-user can reach it until the admin grants access.

**Do not auto-create the archive's roles.** Materializing roles from an uploaded file means the file
mints permissions on the target instance. The operator is already a super-user, so this is not a
privilege boundary crossing, but silently creating roles carrying another instance's permission set
is the wrong default. Validation _reports_ which roles the archive references that do not exist
locally; the restore proceeds; the operator grants. `verify:` role permissions are stored per
database/table such that a newly created database is simply absent from existing roles — inferred
from `utility/operation_authorization.ts:871`, not traced end to end.

## 6. Why create-if-absent also restarts

An earlier draft of this note claimed creating a database that does not exist needs no restart,
since nothing holds it open. That is withdrawn. Two reasons it restarts anyway:

- One code path. The swap logic lives in the startup sequence; a second online variant means two
  ways for a database to appear and two recovery paths.
- Blob roots are outside the database directory and are not covered by the database rename, so an
  online create would reintroduce exactly the partial-state visibility the startup swap exists to
  avoid.

The consequence is that create-if-absent is no longer a shortcut past the swap protocol, which
changes the work breakdown (§9): the split is intake-versus-swap, not new-versus-existing.

## 7. Prerequisites, independently shippable

### 7.1 The archive carries no version stamp

`get_backup` archives contain only human-readable READMEs — nothing machine-readable identifies the
producing Harper version or storage format. A restore cannot refuse an incompatible archive it
cannot identify, and #2046 records that the 5.2.0 upgrade is one-way, so a newer archive into an
older instance must be refused rather than attempted.

**Every archive produced today is unidentifiable, and those are the archives people will try to
restore.** So this ships first and separately. A version/format manifest as the **first** tar entry
is cheaply readable after inflating a few KB; it cannot be the last entry, because reaching the end
of a `.tar.gz` requires inflating the whole stream.

The manifest carries: archive-schema version, engine/storage-format identifier, producing Harper
version, source database name, whether blobs are included, and the blob root count. The
compatibility rule is decided here rather than left open: an archive is restorable when its
archive-schema version is understood and its storage format is not _newer_ than the target's —
#2046 records that the 5.2.0 upgrade is one-way, so a newer archive into an older instance is
refused.

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
before replay**, not later by the steady-state cleanup loop.

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

**Not a hard dependency**, on review: archive intake does not read or write the managed backup
repository at all, so it needs its own exclusion (§8) rather than #2031's. It becomes a dependency
only if the two protocols end up sharing one per-database lock, which is worth doing but is not
forced. #2031 stands on its own defect regardless.

### 7.4 `beginRestore()` can truncate a valid marker and unblock a half-purged database

`beginRestore()` opens the restoring marker with `openSync(markerPath, 'w')`, truncating it before
the database name is written (`dataLayer/restoreMarker.ts:193-199`), and `scanBlockedRestores()`
skips any marker whose first line is empty (`:272`). On a first attempt this is benign — nothing
destructive has run. On a **recovery** attempt, where `lock.preexisting` is true and the database
directory may already be half-purged from a failed restore, `beginRestore()` re-truncates the marker
that was correctly blocking it; a crash in that window leaves a half-purged database that loads as
healthy on the next boot.

Pre-existing, affects `restore_backup` today, and independent of the archive work — but the archive
swap protocol must not be built on the marker as-is (§5.6). Fix by writing the marker temp →
`fsync` → `rename`, so a torn write can never replace a valid one.

## 8. Concurrency

A per-database flock, held across the whole intake, plus a **single instance-wide restore lock**.
The instance-wide lock is what keeps the disk arithmetic in §5.3 honest: with one restore at a time,
the gate compares one incoming size against available space. Tracking every in-flight restore's
declared size and subtracting the set from available space is the alternative, and it is both more
code and less trustworthy, since the declared sizes are advisory.

A flock is preferred to a pid file: the OS releases it when the holder dies, so a crashed upload does
not strand the lock. The marker records the pid and a timestamp for operator legibility, not for
mutual exclusion.

A second upload arriving while one is staged awaiting restart is **refused**, naming the staged
restore. Replacing a staged tree silently would discard work the operator may be waiting on.

## 9. Work breakdown

| #   | Work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Depends on |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | §7.1 — version/format manifest as the archive's first entry, plus the pre-manifest override policy. Ships first: every archive already in the field is unidentifiable, and that set only grows.                                                                                                                                                                                                                                                                                                                                                                         | —          |
| 2   | §7.4 — `beginRestore()` writes the restoring marker temp → `fsync` → `rename` so a torn write cannot replace a valid one. Fixes `restore_backup` today; the swap protocol depends on marker integrity.                                                                                                                                                                                                                                                                                                                                                                  | —          |
| 3   | #2451 — the database generation. Either this lands first, or item 5 mints a generation itself (§5.9).                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | —          |
| 4   | **Intake** — multipart streaming operation with handler-enforced super-user, advisory size field, throttled per-volume disk gate, stream-to-disk extraction per destination volume, entry/inode/path limits, engine-only replacement refusal, resource-bounded out-of-process validation including strict replay, versioned journal written with the generation id / all rename targets / expected table set / attempt count / archive digest, eager staging cleanup. Ends at "staged and validated, awaiting restart"; independently testable without ever restarting. | 1          |
| 5   | **Startup swap** — consume the journal before database discovery and before replication starts, idempotent resumable swap across the engine tree and every blob volume, create-if-absent and replace, peer re-assertion, bounded attempts, terminal blocked state (with §5.6's safe-mode proof), publication check per §5.7, rollback by rename-back, reclamation operation, outcome reconciled into the job row.                                                                                                                                                       | 3, 4       |

Items 1–3 are separately shippable and each stands on its own defect. #2031 (§7.3) and #2033 (§5.8)
are adjacent and independently valid but are not dependencies.

## 10. Outcome reporting

The operation returns a job id before the restart, and the restart closes the connection — the
operations server already sets `Connection: close` for restart operations
(`server/operationsServer.ts:341`). So the job row cannot be updated by the process that created it,
and the CLI must reconnect and poll.

The swap's outcome is therefore written twice: into the journal (authoritative, readable before the
database loads) and into the job row once `system` is up. Without the journal copy the operation's
observable result is "Harper is restarting" followed by silence, and the operator is left polling
`get_status` and guessing. Journal and job state are reconciled at startup, including the case where
the job-row write itself failed.

## 11. Open questions

1. **Does the reclamation operation get a retention policy**, or stay purely manual? Manual is
   safer and leaves `size(restored) + size(existing)` on disk until someone acts, which under a
   Fabric quota is a real operational trap.
2. **Is the producer-side blob capture coherent enough for a strict restore claim?** `create_backup`
   and `get_backup` substitute PENDING/ERROR markers for blobs that were not capturable whole, and a
   blob reclaimed before its parent directory is enumerated is absent from the archive with no
   marker at all (`dataLayer/blobBackup.ts:30-40`). An optional O(data) blob-reference scan cannot
   support an unqualified integrity claim, so either the scan is mandatory for replacement restores
   or the result must report captured-with-substitutions explicitly. This is a producer defect the
   restore surfaces rather than causes.
3. **Does a management-capable safe mode already exist, or must it be built?** §5.6's terminal
   blocked state depends on it.
4. `verify:` items in §5.2, §5.5, §5.6 and §5.10 — each needs confirming, none changes the shape.

## 12. Verification route

- **Unit** — entry-filter rejection table (`..`, absolute, symlink, hardlink, device, duplicate
  name, over-long path, entry-count and inode limits); advisory-size handling for exact, estimated,
  absent and hostile values; journal write/read round-trip including a torn and a malformed journal
  failing closed; attempt counter reaching the terminal state; swap resumption from each
  intermediate phase.
- **Integration** — a real CLI `get_backup` → multipart upload → supervised process exit and
  restart → record _and blob_ reads, which is the only shape that proves the feature; cross-filesystem
  blob roots; kill injection after every journal write, rename and `fsync` phase; strict replay
  failure rejected before publication; engine-only replacement refused; malformed, legacy and
  pre-manifest archives; inode exhaustion; a peer appearing between intake and boot; a failed job-row
  update reconciled at startup; rollback under Windows rename semantics; terminal safe-mode health.
  Unit transition tests alone do not prove restart integration.
- **Live smoke on Fabric**, with recorded evidence: a real `get_backup` archive from one instance
  restored into another, including the GTM drain behavior §5.6 flags as unverified.
- §7.4 needs a fails-on-base check: a torn marker write must leave the database blocked.

Rollout order: producer manifest first, then a feature-gated reader, then Fabric canary evidence.
