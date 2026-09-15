# Restoring a `get_backup` archive into a running Harper (incl. Fabric)

Design note. No issue yet — this note is the input to filing them (§9). Supersedes the rationale on
[#995 `import_backup` operation](https://github.com/HarperFast/harper/issues/995), closed
2026-07-31 with "at this time, we don't want to introduce restoring backups while Harper is
running"; [#1831](https://github.com/HarperFast/harper/pull/1831) landed `restore_backup` doing
exactly that the following day.

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

**Out:** the `system` database (an archive of it carries users, roles, components and deployment
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

Treat `basis: 'filesystem'` as lower confidence and add margin — it means either no
`quota-status.json` or a stale one (>5 min, `QUOTA_STATUS_MAX_AGE_MS`), so the number may describe a
shared volume rather than this tenant's quota.

**Required free space is the size of the incoming database, not a multiple of it.** The extracted
tree and the existing database coexist until the swap; the displaced database is then _renamed_
aside, not copied, so it occupies the same bytes it already did. Total occupancy peaks at
`size(restored) + size(existing)` and stays there until the reclamation operation runs (§5.8), but
the _additional_ space the gate must find is `size(restored)` plus margin.

### 5.4 Extraction and staging

Decompress the upload stream directly to disk into a temp directory — no intermediate copy. The temp
directory must be on the same filesystem as the database root, or the swap degrades from a rename to
a copy and loses its crash properties (`extractTarballInto` documents the same constraint for its
scratch dir, `components/Application.ts:867`).

Placing it outside the database root, rather than using `<name>.migrating` inside it, means the
startup scan cannot see it at all — so the design does not depend on the reserved-name skip
behaving correctly. That matters: #2033 is an open bug about that skip mishandling a directory that
looks like a database.

Entry filtering is explicit, not inherited: reject `..`, absolute paths, symlinks, hardlinks and
device nodes rather than trusting `tar-fs` defaults. Tar extraction of operator-supplied bytes is a
path-traversal sink.

An aborted upload or a crash mid-extract leaves an orphan temp tree; startup sweeps them.

### 5.5 Validation, out of process

A purpose-built validator entry point — the way `bin/copyDb.ts` is a purpose-built CLI, **not**
`harper` with `rootPath` pointed at the temp directory. A full instance spawn would try to become a
whole Harper (config, components, servers, `system`), and `initStores` stamps
`rootStore.databaseName` from `storeName`, which is what blob-root resolution keys off
(`resources/databases.ts:996-1002`, `:1017`) — so a full spawn would start resolving and creating
blob roots for a temp name.

The validator opens the staged directory read-only, enumerates the internal DBI for table
definitions, opens each table's stores and indices, prints JSON, exits.

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

**The intent lives in the restore marker, not in config.** `dataLayer/restoreMarker.ts` already has
the per-database flock, the three-state `checkRestoreState()`, and integration with the startup scan
via `databasesBlockedByRestore`. Extending it costs one field (the staged path) plus the intended
blob moves. Putting the same intent in `harperdb-config.yaml` would add a read-modify-write of a
shared YAML document to a crash-sensitive path, and would need its own clear-on-consume story where
the marker protocol already has one. A stale config flag re-triggers a restore on every boot; a
marker is a single atomic rename.

The marker records the intended moves — database directory rename plus each blob-root move — so the
swap is **idempotent and resumable**, not atomic. Concurrency is not the hazard (nothing is loaded);
crash-during-swap is. A power loss between the database rename and the Nth blob-root move must
re-run to completion on the next boot rather than leave a restored database pointing at pre-restore
blobs.

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

Transaction-log replay is inside this boundary, not after it: the archive carries
`transaction_logs/`, and `replayLogs()` runs on open (`resources/databases.ts:982`). The replay is
wanted — it is what makes the restored state consistent — but it is a post-swap failure point and
must be part of the success definition rather than a step that follows it.

### 5.8 Rollback and reclamation

The displaced database is **not deleted automatically.** It is renamed to a predictable path and its
location is reported in the operation result; a separate operation reclaims it.

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
time: a peer can be added between staging and the restart, so an upload-time check alone is
check-then-act. Finding peers at boot lands in §5.6's terminal blocked state, not in a swap.

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
copy instead. So an incremental migration needs both the peers' retention to cover the gap (an
operator action: raise `logging.auditRetention` before migrating) _and_ the restored log to survive
first open (this bug).

Independent of the archive work; affects `restore_backup` today.

### 7.3 Backup management operations do not serialize (#2031)

Open, verified unfixed: no management lock exists. `createBackup` drops the engine writer lock when
`rootStore.backup()` resolves and then snapshots blobs and writes the manifest
(`dataLayer/rocksdbBackup.ts:374-392`), while `deleteBackup` and `purgeBackups` take no lock at all.
The per-database lock #2031 asks for is also what the archive path needs to exclude a concurrent
`create_backup` during staging.

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

| #   | Work                                                                                                                                                                                                                                                                                                                                                                                | Depends on |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | §7.3 — per-database backup-management lock (#2031, already open, v5.2)                                                                                                                                                                                                                                                                                                              | —          |
| 2   | §7.1 — version/format manifest as the archive's first entry                                                                                                                                                                                                                                                                                                                         | —          |
| 3   | §7.2 — do not purge a freshly restored transaction log on first open                                                                                                                                                                                                                                                                                                                | —          |
| 4   | **Intake** — multipart streaming operation, advisory size field, pre-flight + continuous disk gate, stream-to-disk extraction with explicit entry filtering, out-of-process validation, marker written with staged path / expected table set / intended blob moves, orphan sweep. Ends at "staged and validated, awaiting restart"; independently testable without ever restarting. | 1, 2       |
| 5   | **Startup swap** — consume the marker, idempotent resumable swap, create-if-absent and replace, peer re-assertion, bounded attempts, terminal blocked state, load verification per §5.7, rollback by rename-back, reclamation operation, outcome written back to the job row.                                                                                                       | 4          |

Items 1–3 are separately shippable and each stands on its own defect.

## 10. Outcome reporting

The operation returns a job id before the restart, and the restart closes the connection — the
operations server already sets `Connection: close` for restart operations
(`server/operationsServer.ts:341`). So the job row cannot be updated by the process that created it,
and the CLI must reconnect and poll.

The swap's outcome is therefore written twice: into the marker (authoritative, readable before the
database loads) and into the job row once `system` is up. Without the marker copy the operation's
observable result is "Harper is restarting" followed by silence, and the operator is left polling
`get_status` and guessing.

## 11. Open questions

1. **Does the peer check refuse on configured peers, or on a non-empty `hdb_nodes`?** A node
   configured for replication that has never connected is arguably safe to restore; one that has is
   not. The cheap, conservative reading — any peer configuration at all — may refuse cases operators
   legitimately need during a migration.
2. **What identifies "compatible" in §7.1's manifest?** Harper version, storage format version, or
   both — and is the rule "equal", "not newer", or a declared compatibility range?
3. **Does the reclamation operation get a retention policy**, or stay purely manual? Manual is
   safer and leaves `size(restored) + size(existing)` on disk until someone acts, which under a
   Fabric quota is a real operational trap.
4. `verify:` items in §5.2, §5.5, §5.6 and §5.10 — each needs confirming, none changes the shape.

## 12. Verification route

- **Unit** — entry-filter rejection table (`..`, absolute, symlink, hardlink, device); advisory-size
  handling for exact, estimated, absent and hostile values; marker state transitions including the
  attempt counter and the terminal blocked state; swap resumption from each intermediate point.
- **Integration** — upload → stage → validate → restart → swap → load, asserting the restored table
  set; a corrupt archive rejected with the live database untouched; a crash injected between the
  database rename and a blob-root move, asserting the next boot completes the swap; a restore
  refused on a node with a peer; rollback leaving the pre-restore database loadable.
- **Live smoke on Fabric**, with recorded evidence: a real `get_backup` archive from one instance
  restored into another, including the GTM drain behavior §5.6 flags as unverified.
- §7.2 needs a fails-on-base check: assert the transaction log survives first open of a database
  restored from a backup older than `logging.auditRetention`.
