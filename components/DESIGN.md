# components/ — Design notes

Component deploys, the load lifecycle and packaging.

**Read this when:** touching `deploy_component`, `prepareApplication`, `EntryHandler`, `packageComponent.ts` or `deploymentRecorder.ts`.

Index of every design note: [DESIGN.md](../DESIGN.md).

---

## A deploy builds off to the side, is validated, and only then goes live

`deploy_component` builds the replacement at `.deploy-staging/<deploymentId>/<component>`, runs the
load validation against _that_ tree, and only then activates it. Activation is one compensating
transaction over two effects: the live tree moves into `.deploy-aside`, then the candidate is renamed
into the live path.

**Both renames wait out a holder, and the wait happens with the previous version in place.** Windows
refuses a rename outright (`EPERM`) while anything holds a handle in the source tree, which is what
`deploy_component` hit on the Windows nightly, on the swap itself. The holder was never identified —
every Harper-held handle on the candidate is closed before the swap, so it is something outside the
process, but that is inference, not evidence. `renameThroughTransientHolder` retries every rename in
the activation transaction and its recovery with capped exponential backoff against a five-second
deadline. The deadline is per top-level rename, not per activation: a redeploy held up the whole way
spends up to five seconds each on the move-aside, the swap, and the compensating restore. A rename
performed from inside a backoff shares its caller's deadline rather than opening a fourth.

The swap's backoff is not a plain sleep: it renames the aside back to the live path, waits there, and
displaces it again for the next attempt, so the component is missing for one rename rather than for the
budget. Note what that does and does not buy. Watchers are NOT the beneficiary — `Scope` pauses every
`EntryHandler` for the duration of a deploy, so an absent tree is never reported as `unlinkDir`, and
the post-deploy resume diffs against the finished tree. What the put-back protects is everything that
reads the live path directly: a component reading its own files, a lazily imported module, a concurrent
scan of the components root, and any thread whose pause the best-effort deploy broadcast did not reach.

The retry set is `EPERM`/`EACCES`/`EBUSY` only: a destination that exists is structural state nothing
here clears between attempts, and `settleInterruptedActivation` already fails that case closed rather
than guessing which tree is current.

The ordering is the design. Two things used to be wrong in a way each other hid:

- **The live tree was moved aside first**, so the component was broken for the whole extract +
  `npm install`. Worse than unavailable — the live path held the _new_ code before its dependencies were
  installed, so requests during a deploy hit an unrunnable tree. `stage-swap-availability.test.ts`
  samples the live path through a deliberately blocked install and fails against the old ordering.
- **Validation ran after the swap committed**, so a component that installed cleanly but threw at load
  went live anyway while the operation returned an error. Validation is now a callback preparation
  invokes between build and activation, so a rejected candidate is never published. Note this is a
  load-error PROBE, not a safety guarantee: it executes the component's own top-level code with
  incomplete side-effect isolation. It also remains a no-op on the main thread, and the operations API
  deploys on the main thread — so operator deploys are still unvalidated, exactly as before. Fixing that
  is separate work; this only fixed the order.
  **Root config is deliberately NOT part of this transaction.** It is still written before the build and
  never rolled back, so `installApplications()` can reinstall a rejected release at the next restart —
  unchanged from before this change. Making config an effect of the activation was implemented and then
  pulled back out: it kept surfacing durability and locking problems that had nothing to do with the tree
  swap (a memoized config object a disk write does not refresh, `atomicWriteFile` not fsyncing, writers that
  do not share the publication lock). It is tracked as its own step so the tree half can land on its own
  evidence.

### Staging a build now and activating it later

`deploy_component { activate: false }` stops after certification, leaving a dormant artifact; a later
`deploy_component { project, deployment_id }` swaps that artifact in without resolving, fetching or
installing anything. Four things make the delay safe, and each of them exists because the immediate deploy
did not need it:

- **The artifact directory is named by the PUBLIC deployment id**, not by the deploy-lifecycle token. The
  two are separate on purpose: `DeployLifecycle` de-duplicates starts by the id a start announces and
  releases watcher suppression on the first matching end, so two overlapping activations of one artifact
  sharing that id would count as one owner. `prepareApplication` therefore takes `artifactId` and lets
  `broadcastDeployStart` keep minting a fresh token per invocation.
- **`.artifact.json` is mandatory and versioned**, written before `.complete` so the marker vouches for it.
  It carries the root-config entry the build would have published (explicitly `null` for a payload deploy,
  which owns none), `installationIsOpaque`, and the isolation intent that was admitted — everything a later
  activation cannot re-derive. An _optional_ record could not distinguish a payload build from a package
  build whose record was lost, so a missing, malformed or wrong-version one is refused rather than defaulted.
- **Claiming an id is exclusive.** `buildCandidateApplication` used to tolerate an existing deployment
  directory because a fresh UUID could not collide; a public id can be repeated by an operator or by a
  redelivered replication, so a claim now rejects another component's directory and any directory carrying
  `.complete`, and rebuilds only over an uncertified partial of its _own_ component. Ownership is published
  as part of the claim — the `.component` sidecar is written right after the exclusive `mkdir`, not at
  certification — because `buildCandidateApplication` can spend minutes resolving and packing before any
  tree exists to infer an owner from. For that whole window the directory answered to nobody, and an empty
  `readdir` is indistinguishable from an abandoned claim, so a second component could delete a build that
  was still running. **Emptiness is not a verdict:** an unattributed directory is refused, never reclaimed,
  which is the same reading recovery already gives it. The id this request names is also pinned
  through the preparation preamble, so retention cannot evict the artifact the request is about to use —
  which it otherwise would, immediately, at `deployment_stagingRetention_maxCount: 0`. The contract is
  bounded: an id names one artifact _while that artifact exists_. Activation consumes it (the swap is a
  rename) and retention can prune it, after which the id is free again.
- **Staging owns its bytes.** A `file:<directory>` source is refused, and so is any symlink in the built
  tree resolving outside it (bar the `node_modules/harper`/`harperdb` links the loader owns and repairs).
  Certification fsyncs the tree but follows no links, and the post-swap relocation repair leaves external
  targets alone — so a link out of the build is a hole in "activate exactly the bytes that were certified"
  that only a delay makes reachable. **`.complete` is a durability marker over the bytes, not a seal on
  them:** nothing stops a dormant artifact being edited while it waits, so the link rule and the load
  validation are both re-run at activation rather than trusted from the marker. Content tampering is still
  not detected — that needs a manifest the marker is bound to, and the load validation that would catch a
  broken entry point is a no-op on the main thread until #2315 step 2.

Certification moved out of `activateCandidateApplication` and up into `prepareApplication` for the same
reason: `markCandidateComplete` fsyncs the whole candidate tree, and a delayed activation must not re-walk
a `node_modules` it certified at build time while holding the preparation lock. The swap primitive's
contract is now "the candidate is already certified", and its direct callers — including tests — certify
first.

**Mixed-version clusters are a known, accepted hazard.** A stage replicates as an ordinary
`deploy_component`, and a peer running a build without this change ignores the unknown `activate: false`
and deploys immediately, so it serves a release the operator asked only to stage. Nothing in core or in
harper-pro's replicator carries a peer version or capability, so the origin cannot refuse in advance; a
node that staged returns `staged: true` in its response instead, and the origin fails the stage naming any
peer that did not confirm. That is detection after the fact, not prevention — the accepted trade is
recorded on #2315, and the documented prerequisite is to upgrade every node before staging.

### Recovering an interrupted activation

Every control file is dot-prefixed — `.activation.json`, `.artifact.json`, `.component`, `.complete`,
`.unsettled` — because
a deployment directory holds the candidate tree under the _component's_ own name beside them, and
`isJoinableComponentName` rejects a leading dot. An undotted control file shares that namespace: a component
named `activation.json` would put its tree on the journal path and activate with no journal at all, and one
named `unsettled` would make every settle throw. `assertApplicationConfig` rejects any name
`isJoinableComponentName` rejects, so the collision is unreachable from a root-config key as well as from a
deploy. Ownership inferred from a directory name is validated the same way, so a control file cannot
impersonate a component either.

A journal-LESS staging directory is not ambiguous: it is what a successful settlement leaves when its
best-effort sweep fails. Both the deploy path and boot recovery pass over one rather than failing it closed,
because a verdict written there would outlive the deployment and, once its sidecar became readable again, be
attributed to a live component that never held an unsettled activation.

An `.activation.json` journal is written beside the candidate — with a `.complete` marker recording that
build _and_ validation both succeeded — before the first rename, so `recoverInterruptedActivations()` can
settle a crash at any boundary. Both go to a temp name, are fsynced, then linked into place, so the final
name never exists with partial contents; the candidate's own contents are fsynced before `.complete` is
written, since `.complete` is what vouches for them. Recovery runs before `installApplications()`, which
installs whatever the root config names and would otherwise reinstall over a half-swapped candidate.

**Every settlement outcome clears an earlier failed recovery's `.unsettled`, including the one that returns a
staged artifact to dormant.** That branch returns before the settled tail, so it has to clear the verdict
itself: an artifact left carrying a stale marker is refused by `deployment_id` and then deleted by the next
retention pass as a stale unsettled build, which is the opposite of returning it to dormant. It also needs a
durability barrier the tail does not, because the tail removes the whole deployment directory afterwards and
this branch keeps it: with both unlinks flushed by one sync at the end, a crash can persist the journal's
removal and not the marker's, leaving a verdict no settlement will ever revisit — settlement keys on the
journal. The marker's removal is therefore flushed before the journal's — and because Windows cannot fsync a
directory, the ordering cannot be the only defence: the residue pass treats a DESCRIBED artifact carrying a
verdict but no journal as settled rather than disposable, clears the marker, and retains it. `fail()` only
ever writes `.unsettled` beside a journal it keeps, so a marker without one says settlement finished and only
the marker's own removal was lost. An undescribed build in that state stays disposable, which is the rule
that predates staging.

**Keeping the activation journal after a failed root-config undo only changes the outcome for a first-ever
deploy.** Compensation has already put an existing component's tree back and taken its rollback record with
it, so the next settle reads live-plus-candidate-with-no-record and returns the artifact to dormant whatever
the journal says — holding it there defers the same verdict to the next start and leaves the artifact
unusable until then. Only a first deploy leaves the live path absent, which recovery reads as a roll forward.
Config is stranded either way for an existing component; that is the durable-config window #2315 step 3
closes, not something the journal can cover.

**The same window costs isolation, not just a version string.** A staged artifact records the isolation the
build admitted in its `.artifact.json`, and an activation publishes that with the rest of its root-config
entry between B1 and the commit. `rollForward()` publishes nothing, so a crash after the roll-forward state
exists but before that publish brings the certified artifact up under the previous release's config — and a
component staged to run isolated comes back NON-ISOLATED, with nothing in the operation reporting it.
Isolation is a containment boundary, so weigh that window by this rather than by the version mismatch.

The journal is consulted **first**, and the legacy in-place extraction recovery enforces that itself: it
refuses to restore a rollback record while an unsettled journal is attributable to that component — by its
own `component` field OR by the deployment's ownership sidecar, whichever can be read, because restoring is
the destructive step and takes the conservative union while settlement keeps the precise intersection.
Ordering settlement
ahead of it is not enough, because a worker can be respawned mid-activation with no settlement in front of
it, and settlement that _fails_ deliberately keeps the journal while the same boot carries on. The refusal
is scoped to the branch that actually restores a tree — a record that was already retired has nothing to
restore, so that component still loads. Where no journal is attributable to the component, the legacy pass applies
unchanged: a crash in that path also leaves an in-progress aside with the live tree present, and retiring
it there would keep a half-written tree instead of restoring the good one.

Settlement runs on **every thread**, not only main, for the same reason. It is safe anywhere because each
deployment is settled under the cross-process component preparation lock and the pass is idempotent. It
_probes_ for that lock — a 250 ms try, no renewal, matching the legacy boot probe — rather than queueing:
it runs before every component load on every thread, so waiting behind a live deploy's `npm install` would
load no components at all until that install finished. A held lock means a live deploy, and a live deploy
settles its own journal.

Ambiguity exists mainly while the live path is absent, and there `.complete` is the roll-forward authority:
without it the candidate was never validated, so the committed tree in the aside wins. Live-present with a
candidate is normally pre-swap (or already rolled back) — discard the candidate — **unless a rollback
record shows the live tree had already been moved aside**. Then whatever is at the live path was recreated
afterwards by something else, and settling either way would destroy both the committed tree and the
validated candidate, so that component fails closed with both still on disk.
Live-present without a candidate is a lost tail — finish forward; never revert a completed activation.
Neither a live tree nor a rollback record is unrecoverable, so that component fails closed rather than
guessing. Every branch is idempotent, so a crash _during_ recovery is settled by the next run, and
failures are per component so one unsettleable component does not stop healthy siblings loading.

Directory fsync is best-effort by necessity — Node cannot fsync a directory on Windows — so the protocol
never depends on it. Roll-forward requires the journal, the candidate and `.complete` to all be
observable, which means a lost directory update degrades to a roll back rather than to a wrong decision.

Retiring the rollback record only marks the displaced tree disposable; both the activation path and
recovery then sweep it, or the components root would grow by a whole component version per deploy. The
retire is **correctness, not hygiene** — that marker is what stops the legacy pass treating the record as
authoritative once the journal is gone — so a failure to retire propagates and the component fails closed
with its journal intact. Only the sweep itself is best-effort, because it costs disk rather than a wrong
decision. For the same reason, a swap whose rename cannot be confirmed on storage skips both the retire
and the journal removal: the journal is what would carry the activation forward after a power loss.

Three limits are deliberate and tracked separately: activation is two renames, so the live _pathname_ is
briefly absent (in-memory resources are unaffected, but a component that opens its own files during a
request can still see a gap); validation does not run on the main-thread deploy path; and config
publication is not yet an effect of this transaction, as above.

### Retention of dormant staged builds

A journal-less deployment directory holding `.complete` and the owner's tree is a **dormant build**: built
and validated, activated by nobody. Recovery used to remove every owned journal-less directory; it now keeps
dormant builds and bounds them per component to `deployment_stagingRetention_maxCount` (default 5, 0 keeps
none), newest by `.complete` mtime, ties broken by deployment id so concurrent passes pick the same victims.
Everything else journal-less — a partial tree, a directory whose tree already moved live, a stale
`.unsettled` — is still residue and still removed. Nothing here produces a dormant build yet beyond the crash
window between `.complete` and the journal; #2315 step 6 (deploy from an existing aside) is the producer this
bound exists for.

Removal is decided **only under the owner's preparation lock**: activation writes `.complete` moments
before its journal while holding that lock, so an unlocked read of "complete, no journal" is a candidate, not
a verdict. Boot recovery catalogues dormant builds unlocked, then reconciles each owner once: if any
catalogued directory has acquired a journal since the scan, or the owner is over its bound, it takes the lock
and re-reads only that owner's catalogued directories — never the whole staging root, which sibling threads
are probing — settling any journal that appeared (a deploy that published one and died mid-swap would
otherwise leave the component unloadable until the next start) and bounding what is still dormant. The
residue branch re-classifies under its lock too, since the `.complete` a deploy wrote before dying can land
while the scan waits for the lock. A build created after the scan waits for the next pass. It used to take the lock per journal-less directory, which was one-shot because the directory was
removed — doing that for retained builds on every pass made a healthy component lose the 250 ms probe to its
sibling threads at boot and be deferred with nothing in progress. A lock a live deploy holds is still recorded as
that same deferral: "do not delete" is not "safe to load". The deploy path prunes inside the settlement scan
it already runs under the lock, before building, so a deploy pays one traversal of the staging root.
`dropComponentDirectory` reclaims the dropped component's dormant builds, since no later deploy of that
name will. Only ENOENT is absence; any other read error keeps the entry and moves on. Pruning is disk
hygiene: it never fails a component closed and never replaces a deploy's own error, so the bound is
best-effort under filesystem failure and is not a storage quota — journaled, unsettled and unowned
directories are preserved by design and can still fill a volume.

## Component preparation is serialized across worker threads

`prepareApplication()` performs one transaction per component: build the replacement, validate it, then swap it in (see "A deploy builds off to the side" below). Deploy operations can execute on worker threads as well as main, so a module-local promise queue is insufficient—each worker has its own module registry. `withComponentPreparationLock()` (`components/componentPreparationLock.ts`) instead acquires an atomic filesystem lock keyed by the absolute component path. The deprecated `install_node_modules` operation uses the same lock, so it cannot run npm concurrently with a deploy.

The deploy lifecycle broadcast deliberately sits _outside_ the lock. Overlapping requests therefore increment the existing per-component lifecycle refcount before queueing; watchers remain suppressed continuously until the final queued preparation ends. The lock itself covers credential materialization, extraction, and installation. Its fully-written owner record is published with an atomic rename, so contenders never observe a partially initialized lock. A preparation caller never steals a lock from a known-live owner based on elapsed wall time: installs can be long-running and clocks can jump. Locks from a dead process are reclaimed, and a same-process contender asks the main thread whether the owning worker still exists so a worker crash does not wedge that component until Harper restarts. The boot-time bulk-recovery probe is deliberately different: it never renews its 250 ms deadline, even behind another live recovery, so it can defer that component and let the worker bind its listener.

A plugin load that begins while its component is being deployed waits for that lifecycle to end before
starting `handleApplication`; if a deploy begins during the load, the plugin timeout counts only active,
unpaused load time. This prevents a long install from looking like a hung plugin while its entry handlers
are deliberately paused against the intermediate tree.

### The component load lock is keyed by plugin type, so a plugin's promise is everyone's clock

`sequentiallyHandleApplication` (`components/componentLoader.ts`) holds a cross-thread lock keyed by the
plugin TYPE name — `graphqlSchema`, `rest`, … — not by the component. That is deliberate. Plugin modules
are per-thread singletons carrying module-level state (`server/http.ts`'s `universalHeaders` ownership
array, `resources/graphql.ts`'s `knownGraphQLDirectives`, the scheduler's register-inside-the-lock
contract), and applications load _concurrently_: `serializeComponentLoad` serializes per application
name and all applications go into one `Promise.all`. Without this key two applications' `handleApplication`
for the same plugin would interleave on a single thread, not merely across threads.

The price of that key is that whatever a plugin does inside the lock is paid by every other application.
So a plugin must return a promise that settles with its real outcome: the `withDeployAwareTimeout`
watchdog exists for a _hang_, never as the reporting path for a failure the plugin already diagnosed. A
success-only wait is what turned one unparseable schema into 30s of instance-wide gating per broken
component (#1917). `Scope.waitForInitialLoads()` is that promise — it resolves once the entry handler's
initial scan and every operation that scan started have completed, and rejects with the first failure,
after draining the rest so no sibling operation outlives the lock. The watchdog can still cut that drain
short, so the serialization the lock buys is bounded by the timeout rather than absolute.

Extraction renames an existing component aside before writing the replacement and keeps it until
dependency installation and metadata verification complete. Any preparation failure atomically
renames the partial tree into hidden staging before restoring the prior tree, so a live writer cannot
wedge rollback with `ENOTEMPTY`; cleanup completes while the same-component lock is still held.
On non-root POSIX systems, rollback uses a mode-`000` placeholder to keep that writer out between
retries. Before moving or removing it, rollback verifies the placeholder's device/inode identity and
restores owner permissions because a cross-parent directory move updates `..` and requires write
permission on the moved directory.
The aside name is itself the recovery record: an `.in-progress-*` directory or symlink preserves a
previous tree, while an `.in-progress-*-prior-absent` file records that a first deploy must remove a
partial live tree after a crash. A sibling `.retired-*` marker records that the replacement committed.
Cleanup removes the recovery record before its marker, so an interrupted cleanup cannot make obsolete
state recoverable.
Component loading recovers unretired interrupted deploys before scanning the component root, and
preparation repeats recovery under the same-component lock before reading runtime metadata. A full
`drop_component` writes retirement markers before deleting the live tree and keeps its filesystem,
and configuration mutations under that lock, so cleanup residue cannot resurrect a dropped
component and a concurrent deploy cannot interleave with the drop. Peer replication begins after
the local lock is released, and each peer serializes its own drop independently. Full-component drops
rename the live tree into staging before best-effort cleanup, avoiding an in-place recursive-delete
race with the running worker. Recovery is durable across a process crash. It relies on rename/create
ordering rather than `fsync`, so a host power loss can lose the marker.

A package-manager timeout must not release this lock while npm descendants are still mutating `node_modules`. POSIX spawns therefore run in a dedicated process group; timeout sends the group `SIGTERM`, escalates to `SIGKILL`, and waits for exit before rejecting. Windows uses `taskkill /T /F` for the equivalent process-tree termination. `manageThreads` tracks each spawned process tree by its owning Harper thread and force-terminates it if that worker exits, preventing detached installers from surviving a worker restart or Harper shutdown. `SIGKILL`/`taskkill` only queue termination, so a worker's dead-owner reclamation (above) waits for that thread's tracked process groups to be confirmed gone, not merely signaled—otherwise a replacement preparation could start while the old writer might still be alive. A process group a dead worker's own event loop spawned is never reaped from another thread, so it persists as a zombie rather than fully disappearing; since a zombie can no longer touch the filesystem, confirmation treats a zombie the same as a fully reaped exit.

Boot's `harper-application-lock.json` records an application configuration only after preparation fulfills. Recording at queue time would make a failed install look complete and suppress its retry on the next boot.

Every npm install Harper invokes directly — automatic component installation and the deprecated
`install_node_modules` operation alike — composes its arguments in `packageManagerInstallArguments()`,
which is production-only and adds `--omit=dev --no-audit --no-fund`. `--no-audit` is load-bearing, not
hygiene: npm 10 puts even a `file:` link into its audit bulk request, and the registry's answer to that
is unbounded from Harper's side. The operation accepts the established `install_allow_scripts`
spelling (and `allowInstallScripts` for compatibility), defaulting to its historical `true`; false
reaches the shared builder and adds `--ignore-scripts`.
`installApplication()` skips the package-manager child entirely when the root manifest declares no
production dependencies, non-empty workspaces, or enabled install lifecycle. An explicitly selected
non-npm manager still runs so it can discover workspace configuration outside `package.json`, and it
retains its own install defaults. A configured `install_command` remains the explicit escape hatch for
build-time tooling, but not for lifecycle-script policy: unless `install_allow_scripts` is true, its
spawn gets `npm_config_ignore_scripts=true`, which covers npm nested anywhere in the command without
adding an argument that could break non-npm tooling. The setting uses npm's configuration namespace;
other package managers that consume `npm_config_*` options can honor it too. When the policy is
omitted, Harper warns that package lifecycle scripts—including `npm run` pre/post hooks—are suppressed
and names both the operations-API and root-config opt-ins.
`readInstalledPackageMetadata()` must use the same automatic-work predicate so a
dev-only npm manifest does not force a restart on every redeploy for lacking a lockfile while an
explicit non-npm workspace install still does. Absolute local archives are classified before
package-protocol detection: a Windows drive letter's colon is path syntax, not an npm protocol. File
type detection remains asynchronous in extraction. Bare absolute Windows directory inputs retain
npm's copy/pack behavior rather than becoming live links; explicit `file:` and relative directory
inputs retain their existing symlink behavior.

## Peer-side deploy_component payload read: retryable blob stalls and `Readable.from()` cancellation

`readPayloadBlobWithRetry` (`components/deploymentRecorder.ts`) wraps the peer's read of a replicated `hdb_deployment` row's `payload_blob` so a transient 503 `BlobReadError` (`BLOB_UNAVAILABLE_STATUS`, `resources/blob.ts`) — content bytes not arriving within `blobReadTimeout`, e.g. a parked blob send on the origin — retries instead of failing the whole deploy. Two non-obvious constraints shaped the design:

- **Retry is only safe before any byte has reached the consumer.** Once a chunk is handed downstream, re-opening `Blob.stream()` from byte 0 would duplicate it (there's no cheap way to resume from an arbitrary offset across a fresh stream without also plumbing `Blob.slice()`, which was out of scope for this fix). So the helper retries only while the current attempt has yielded nothing yet; a stall after partial content fails immediately, same as before this existed.
- **Backpressure and cancellation are two different problems, and both are easy to get wrong with a hand-rolled `ReadableStream`.** An early version wrapped the retry loop in `new ReadableStream({ async start(controller) { for await (...) controller.enqueue(chunk) } })` — this eagerly drains `streamFactory()` regardless of `controller.desiredSize`, defeating the whole point of not buffering a multi-GB payload in memory. Switching to an `async function*` consumed via `Readable.from()` restores real backpressure (the generator only resumes when the consumer wants more, matching how the un-wrapped `Blob.stream()` behaved pre-fix). But `Readable.from()`'s `return()`-on-destroy cancellation only takes effect at the generator's _next_ `yield` — while the loop is stuck retrying (no `yield` reached yet), destroying the `Readable` does nothing until the loop naturally exits, verified empirically (a generator that never yields kept retrying long after `.destroy()`). The fix: thread the constructed `Readable` back into the generator via a mutable cell (`readable` doesn't exist until after `Readable.from()` returns, so it can't be closed over directly) and check `.destroyed` explicitly at each loop iteration and after each backoff sleep.

## A dangling symlink silently truncates the deploy tarball (`components/packageComponent.ts`)

Packaging uses `tar-fs.pack(dir, { dereference: true })` by default (`skip_symlinks` off).
tar-fs's own walker calls `fs.stat` (not `lstat`) on every discovered entry when dereferencing; a
dangling symlink's target throws `ENOENT`, and tar-fs's `statAll` loop treats _any_ `ENOENT` from
a walk-discovered (not explicitly-requested) entry as end-of-stream — it calls `pack.finalize()`
immediately, silently dropping every entry still queued (BFS order) after the link. No error is
ever emitted, so `packStream.on('error', ...)` never fires and `deploy_component` reports success
on a truncated archive. `scanPackageDirectory()` now pre-walks the tree once (async) to build a
skip-set of dangling symlinks, which `streamPackagedDirectory`'s `tar.pack({ ignore })` consults via
a synchronous `Set.has()` — **`ignore` is called synchronously by tar-fs with no Promise support**,
so any fix here has to resolve the dangling set _before_ constructing `tar.pack`, not from inside
the callback (an earlier draft used `lstatSync`/`statSync` per entry there, which would have added
blocking I/O to a path that also runs inline on the Harper server's event loop via the
`package_component` operation). The scan recurses into _valid_ symlinked directories the same way
tar-fs's dereferenced walk does (readdir through the link), since a dangling symlink nested inside
one is just as capable of tripping the same early-finalize — skipping recursion into symlinked
dirs there would silently reintroduce the bug for that case. Circular directory symlinks are not
guarded against (in the scan or in tar-fs's own pack walk); that's a pre-existing tar-fs limitation
this fix doesn't attempt to solve. `deploy_component`/`package_component` still never validate that
declared entry points (`jsResource`/`graphqlSchema`) survived extraction — a truncation from some
other future cause would still report success silently; that's a deferred, separate fix.

## Deploy watcher generations preserve logical entry events

Component deploys pause each scope's `EntryHandler` while the component directory is replaced. A
new chokidar instance then performs a cold-style initial scan, which reports every surviving path
as `add`/`addDir` and cannot report paths that disappeared. Exposing those raw scan events changed
the public `scope.handleEntry()` contract in #1806: consumers could no longer distinguish an
unchanged file from a changed one, and deletions vanished entirely.

`EntryHandler` therefore owns the deploy boundary. It retains a compact snapshot of matching paths
(entry kind, URL path, and a SHA-256 content digest for files), assigns each watcher a monotonically
increasing generation, and compares the resumed generation's scan with the pre-pause snapshot. The
comparison emits only logical `add`, `change`, `unlink`, `addDir`, and `unlinkDir` events; unchanged
entries remain silent. File contents are still read once for the event payload and are not retained
in the snapshot. Reads and readiness are generation-scoped, and a per-path sequence prevents a slow
read from an obsolete event from overwriting a newer state. Missing paths are synthesized as unlink
events only after the resumed scan and all of its reads complete.

Every watcher recreation uses the same comparison. The first generation compares against an empty
snapshot and therefore retains its cold-load `add` behavior; deploy resume, configuration updates,
and polling recovery compare against the last completed generation. This keeps file identity intact
when watcher recovery could otherwise replay stale modules as new and ensures an update racing a
deploy scan cannot discard its removals. New component deploys still use `Application#isNewComponent`
to mark a restart as required for #674; other existing-component redeploys request a restart only when
their logical entry, loaded runtime, or configuration changes require one.

## Restart-free deploys require proof of runtime equivalence

`EntryHandler` intentionally observes only the files a component declares in its `files` option. It
cannot prove that the JavaScript runtime is unchanged: a watched `resources.js` can import an
unwatched `lib/db.js`, and installed dependencies live under the watcher's ignored `node_modules`
tree. Conversely, hashing the entire extracted tree treats unused source and generated caches as
runtime changes and collapses restart-free deploys back into unconditional restarts.

Runtime equivalence is therefore layered. A deploy can remain restart-free only when all three
layers it uses are proven equivalent:

- `EntryHandler` compares consumer-visible watched entries.
- `ApplicationScope` records the file URL and load-time digest of every application-local module
  that Harper's VM or compartment loader reads, including application-local package imports and
  package self-references, together with every application-local resolution edge. After a deploy,
  those exact logical paths are re-read and each edge is resolved again against the replacement tree
  after evicting Node's matching resolution-cache entry. Adding a higher-priority `foo.js` ahead of a
  previously resolved `foo.json` is therefore a runtime change even when `foo.json` itself is
  byte-identical. For import-only package exports that Node's CommonJS resolver cannot resolve, the
  package manifest itself is recorded as a runtime input so an exports-map retarget is also observable.
- The deploy pipeline compares dependency metadata at the same preparation stage: the previous
  installed tree before extraction versus the replacement tree after installation.

Loader or installer paths that Harper cannot observe are conservative. Full native module loading,
custom install commands, enabled install scripts, payloads that already contain `node_modules`, and
installs without deterministic lock evidence mark the runtime opaque; an existing component using an
opaque path requires a restart on redeploy. `harper deploy` omits `node_modules` by default; callers of
`package_component` that want restart-free comparison must likewise set `skip_node_modules: true`.
Npm dependencies delegated from the default VM loader to Node's native loader are instead covered
by the installed package/lock comparison—otherwise the default `dependencyLoader: auto` mode would
make nearly every application opaque. Explicit `dependencyLoader: native` remains authoritative;
an application-local import delegated by that setting marks the runtime opaque. `package.json` is compared as parsed JSON so formatting and
key order are irrelevant, while lockfiles remain exact installed-tree evidence. A module first
loaded while a deploy is in flight also invalidates the old runtime rather than letting a mixed
generation appear equivalent. This is deliberately proof-oriented: an unused new local file need
not restart a fully observed runtime, but a changed or missing imported helper, changed resolution
input, changed dependency evidence, or any genuinely opaque runtime does. Entry changes themselves
remain consumer-directed: the static plugin applies asset changes incrementally, while executable
consumers such as `jsResource` request a restart on their logical `change` or `unlink` events.

## Startup waits for component preparation only up to `deployment.startupInstallTimeout`

Listeners open and workers start only after `installApplications()` returns, so any component preparation it
waits on gates the whole node. It waits at most `deployment.startupInstallTimeout` (default 10 minutes, `0` =
unbounded) (`waitForStartupPreparations`). Everything per component that can block — the lock-file read, the
credential lookup, the build — runs inside the tracked preparation, so the deadline bounds it; enumeration
itself only validates config.

A preparation still running at the deadline is left behind, not cancelled: it keeps its component preparation
lock, so no second writer touches that component. A later `installApplications()` (every worker restart runs
one) rejoins it rather than starting another (`trackStartupPreparation`, keyed by component and configuration)
and does not wait for it again, since the node already runs without it.

Startup then loads the installed tree: the previous version, or nothing for a new component. On the installing
thread that needs `deployLifecycle.releaseLoads()` for the preparation's own deploy id, because a Scope created
while its component's deploy is in flight would otherwise wait for that deploy and pause its watchers — in
single-thread mode that is the node's only serving thread, and startup would block on the very preparation it
stopped waiting for. Workers started after the broadcast never saw the deploy, so they already load the
installed tree. `deploy:start`/`deploy:end` bracket the periods in which an unreleased deploy is in flight
(`loadsAwaitDeploy`), so a release ends a pause and a later overlapping deploy still starts one.

When a left-behind preparation succeeds it requests a restart unconditionally: some running generation
predates its swap, and the package-metadata comparison `requestRestartAfterDeploy` uses cannot tell whether
that generation ever loaded a working version. Because a preparation outlives the call that started it, each
`harper-application-lock.json` transition is a read-modify-write in one per-path queue
(`updateApplicationLock`), and a reinstall clears its entry under the component preparation lock
(`recordApplicationPreparation`), after any earlier preparation's success write (harper#2072). Enforced by
`unitTests/components/installApplicationsLock.test.js` and
`integrationTests/deploy/startup-install-timeout.test.ts`.
