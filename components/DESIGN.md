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

The ordering is the design. Three things used to be wrong, the first two in a way each other hid:

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
- **Root config was written before the build and never rolled back**, so a build or validation that failed
  still left config naming the release, and `installApplications()` installed it at the next restart. The
  entry is now the transaction's third effect, published after the commit — see "Root config is an effect
  of the activation" below.

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

**Every roll forward publishes the journal's root-config effect**, before it retires the rollback record — see
"Root config is an effect of the activation" below. A roll back and a return to dormant publish nothing,
because nothing before the commit ever touched config.

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

Two limits are deliberate and tracked separately: activation is two renames, so the live _pathname_ is
briefly absent (in-memory resources are unaffected, but a component that opens its own files during a
request can still see a gap); and validation does not run on the main-thread deploy path.

### Root config is an effect of the activation

A component's root-config entry changes only as a journaled, durable effect of an activation that committed
on this node — or of `drop_component` — so it never names a release that is not live here, and a crash at any
boundary settles config to the same end state as the tree. `deploy_component` only _declares_ the entry
(`describeArtifact`); `prepareApplication` turns the declaration into a `RootConfigEffect`
(`components/rootConfigPublication.ts`) and `activateCandidateApplication` owns applying it:

- `set` — a package build publishes the entry it was declared with, replacing the component's entry whole,
  as `addConfig` did.
- `unset-package` — a payload build removes `package`, `install` and `credentials` and keeps the rest
  (`isolated`, `urlPath`, `host`, `branchedDatabases`), removing the entry if nothing remains. "No package"
  is an opinion: left in place, a cold install resolves the old package over the payload release that is
  live. This is a behaviour change operators can see.
- `keep` — a caller installing FROM root config (`installApplications()`, `add_component`, harper-pro's
  clone) owns no effect. It returns before taking any lock, so a boot re-install never waits on a config
  writer.
- `remove` — `drop_component`. Never journaled, so the drop orders itself instead: what the removal would refuse is
  refused before anything moves, the tree is renamed aside, and the entry goes last, the tree being renamed back if
  the removal fails while the entry is still on disk. Both renames are flushed before the entry's removal is made
  durable. A failed drop therefore never leaves a live component whose entry — its package, settings and
  isolation — is gone. The `node_modules` link and the aside tree are cleaned up after, and a failure there is
  logged, not thrown. A crash between the rename and the removal leaves the entry without its tree: the next start
  reinstalls a package component, and a repeated drop finishes the job.

**The effect is written into `.activation.json` (journal v2) before the first rename, and applied after the
commit** — after the swap is flushed and dependency links are re-pointed, and before the rollback record is
retired, because the journal is the only record of the effect and it goes once that record is settled.
Nothing before the commit touches config, so a failed or compensated activation has nothing to undo; the
best-effort, non-durable undo that used to run there — and the divergence when it failed — is gone. Every
roll forward in `settleInterruptedActivation` applies the same effect at the same point. Roll back and
return to dormant never apply it. Application is idempotent, so a crash between the apply and the journal's
removal is settled by applying again.

**A failure to publish after the commit THROWS**, unlike the retire and sweep that follow it: those cost disk,
this one costs the component its configuration, and `deploy_component` restarts workers on the strength of
the published config — a release staged `isolated: true` would run non-isolated after an operation that
reported success. The error is marked `ACTIVATION_COMMITTED` so `prepareApplication` keeps the deployment
records instead of discarding them as a failed build; the journal survives, and the next settlement — the
next start, a worker's load-time pass, or the component's next deploy — publishes the entry. In recovery the
same failure fails the component closed with `.unsettled`, the contract the retire already has. A
publication-lock timeout is rethrown as a 503 `ServerError` rather than the preparation lock's own timeout
class, which recovery reads as "a live deploy holds this component's lock" — a deferral, not a verdict.

The throw also means `deploy_component` never reaches replication: the release is live on this node only, and
the error says so. A fresh deploy converges; a retry of a `deployment_id` activation does not, because its
preamble settles the kept journal and the artifact is gone — the unconvergeable-retry gap #2315 step 5 owns.
So a condition that would fail every publish is refused BEFORE anything moves: `assertRootConfigEffectPublishable`
runs ahead of the journal and refuses an effect that would have to change a document that does not parse, or
whose directory this process cannot write. Only a static condition is caught; a publish can still fail.

**A version-1 journal is replayed from the artifact descriptor.** A v1 activation of a staged artifact
published its descriptor's entry between the two renames, so a crash in that window is exactly the one whose
effect `.artifact.json` still records; mapping every v1 journal to `keep` would carry the isolation loss this
closes across the upgrade. A v1 journal with no descriptor is an immediate deploy, which published before it
built, and gets `keep`. A v2 journal whose effect is malformed, is `remove`, or whose `set` entry fails
`assertApplicationConfig` fails the component closed before anything moves — and `activateCandidateApplication`
refuses the same entries before it writes the journal, since a journal recovery would refuse to read is one it
could never settle. The reverse direction is not covered: a build before this change refuses a v2 journal and
fails that component closed, so settle every interrupted activation (a clean start does) before downgrading.

**One writer, one lock, durable.** `applyRootConfigEffect` is the only runtime read-modify-write of the root
config document besides `set_configuration`, which takes the same lock around `updateConfigValue` — and that
reads and writes the same file the lock is keyed by, the one boot reads. `addConfig` and `deleteConfigFromFile`
are gone — the latter wrote to a path rebuilt from the document's `rootPath` rather than the file it parsed. The
lock is the component preparation lock primitive keyed by `getRootConfigFilePath()`, which names the file boot
reads whenever a boot source exists and so is fixed for the life of the process — not a configured path
`set_configuration` could move under a concurrent writer. Lock order is always
component preparation lock, then this one. Its wait is bounded (30 s) and never renewed, and a ticket left by a
dead worker of this process is reclaimed through `isThreadRunning` — without it a same-process ticket reads as
live and every config writer on the node times out behind it. Each write is
`atomicWriteFile({ durable: true })`: the temp file is fsynced through its write handle (Windows only flushes a
handle opened for writing) and the directory after the rename, tolerating the platform's "cannot sync" codes and
nothing else. An effect the document already satisfies — a replayed journal, or a payload deploy of a component
with no entry, which is most of them — is answered before the lock and needs no write access at all, provided
this thread's memoized view of the entry agrees with the file: the lock creates its directory beside the config,
and a node whose config is readable but not writable took payload deploys before this change and must still.
When the view disagrees, the effect goes through the lock like any writer, because the refresh that fixes the
view re-applies the env config layers on the main thread and can rewrite the file — unlocked, that rewrite could
drop a concurrent writer's change. The lock-free answer still syncs the file and its directory, through read
handles (only Windows needs a write handle to flush, and there a refusal is a tolerated code), because a crashed
predecessor can have renamed it in unflushed. Deciding outside the lock is safe because the file is only
replaced by rename. A document that does not parse cleanly is refused, never rewritten from what the parser
recovered.

**An effect the config environment would undo is refused.** `HARPER_CONFIG` and `HARPER_SET_CONFIG` rewrite every
key they name at each start and each config refresh, over the file and over edits to it. A package activation whose
entry one of them contradicts would go live under the forced entry, and a dropped component would be reinstalled
from the install keys one of them put back. Settings such as `isolated` or `host` a variable keeps for a dropped
component's name install nothing, and do not block the drop. So the pre-flight composes those two variables
together over the document it would write and refuses, with a 409 naming the variable that wins each key, an effect
they contradict; the writer repeats the check under the lock. Keys a variable adds beside the ones an effect
declares are no contradiction: an operator-forced `isolated: true` stays beside a deploy's `package`. After its
refresh, the writer re-reads the file and throws if the effect no longer holds — the backstop for what composing
those two cannot predict, such as `HARPER_DEFAULT_CONFIG` filling a removed key back in on the main thread.

**Boot ordering depends on the refresh.** `env.initSync()` memoizes the config object, so publishing to disk
during recovery is not enough on its own: `applyRootConfigEffect` re-inits THIS thread's config, and boot
recovery runs on main before `installApplications()` reads `getConfigObj()`.

Not covered, and pre-existing: other threads' memoized config stays stale until a restart re-inits it; the
boot-time config writers and out-of-process editors are not serialized with the lock; and
`installApplications()` still reinstalls a package-deployed component from its source at the next start
whenever `harper-application-lock.json` does not match its entry — which, since no deploy writes that file, is
the first start after every package deploy. Validation of a package deploy now runs under the entry in force
rather than the one being deployed, since the latter is no longer published until the commit.

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

The deploy lifecycle broadcast deliberately sits _outside_ the lock. Overlapping requests therefore increment the existing per-component lifecycle refcount before queueing; watchers remain suppressed continuously until the final queued preparation ends. The lock itself covers credential materialization, extraction, and installation. Its fully-written owner record is published with an atomic rename, so contenders never observe a partially initialized lock. A preparation caller never steals a lock from a known-live owner based on elapsed wall time: installs can be long-running and clocks can jump. Locks from a dead process are reclaimed, and a same-process contender asks the main thread whether the owning worker still exists so a worker crash does not wedge that component until Harper restarts. A ticket its owner could not remove — a Windows sharing violation, a scanner holding the file — would name a finished holder that is still alive, so a release whose unlink keeps failing publishes a `<lockName>.released.<token>` marker instead, which contenders honour by clearing both. Only the ticket's owner writes one, after confirming it still owns the ticket — or, when a scanner holding the ticket without read sharing hides its record, knowing it can only be its own, since the ticket's name carries its token — and tokens are never reused, so a marker cannot retire a holder that has not finished. A process running an older build ignores markers, so overlapping processes of mixed versions do not get this guarantee, and a ticket left live-looking before the upgrade stays until that process restarts. Windows refuses to open a claim whose unlink is in progress (`EPERM`) until the unlinking handle closes, so a contender retries that read until the claim reads or is gone; one that stays unreadable fails the scan instead of reading as absent, since dropping a live ticket would admit a second holder. An older build fails the acquire on that `EPERM`. The boot-time bulk-recovery probe is deliberately different: it never renews its 250 ms deadline, even behind another live recovery, so it can defer that component and let the worker bind its listener.

A plugin load that begins while its component is being deployed waits for that lifecycle to end before
starting `handleApplication`; if a deploy begins during the load, the plugin timeout counts only active,
unpaused load time. This prevents a long install from looking like a hung plugin while its entry handlers
are deliberately paused against the intermediate tree.

A deploy's own validation load is exempt: its Scopes (`isTransientValidation`, set at construction from
`collectScopes`) never read the deploy state, subscribe to `deploy:start`/`deploy:end`, pause their
watchers, or suspend their plugin timeout. The load runs inside the deploy's lifecycle bracket, between
build and swap, so any wait for a deploy to end can be a wait on itself. It was, for a component deployed
as `harper`: the validation load passes no `appName`, so its Scopes take the loader's default name
`harper`, matched the deploy in flight, and waited for its end while the deploy waited for them. A
replicated deploy of that component hung on every peer, since only worker threads validate. The same
cycle formed when a `harper` deploy started on a worker while another component's validation was running
there, because that deploy's own validation queues behind the running one (`validationChain`). The
candidate tree is complete before validation starts and nothing else writes to it, so there is nothing to
wait for. `unitTests/components/componentLoader.test.js` ("deploy validation loads never wait on a
deploy") holds both routes and the plain timeout.

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

## An origin waits for a peer's deploy answer only as long as the peer may take

The origin of a replicated `deploy_component` hands `server.replication.replicateOperation` a `timeoutMs`
from `peerDeployAnswerTimeoutMs(req)` (`components/operations.js`). It is the sum of what the peer is
allowed for that request: its payload wait (`deployment_timeout`, counted twice when credential references
must also replicate in), two full preparation budgets (`componentPreparationBudgetMs`: every extraction
command and both install commands at their allowances), a margin for validation and the swap, and the
restart ceiling when the peer restarts before answering. It is clamped to the longest delay a timer holds.
One budget is the peer's own preparation. The other is the preparation lock's wait: a peer already preparing
the same component for another deploy holds this one at the lock for a budget before the lock re-checks the
holder.

It must never undercut a healthy peer. A shorter bound turns a slow success into a reported failure, and a
two-command install (a custom package manager falling back to npm) is exactly such a success. So the
default is hours, and its job is only that the origin eventually settles, rather than holding the
operation, the deployment row and its own restart for as long as a wedged peer stays wedged. Two things are
not budgeted. The lock keeps waiting while its holder is alive, so queueing behind a preparation that
outlasts the lock's wait, or behind several, can run past the deadline. So can plugin `timeout`s a component
configures beyond the validation margin, which live in the payload the origin does not parse. Covering the
first would take a deadline that follows the peer's progress rather than a sum of its allowances. The
deadline is not cancellation: a peer past it may still finish, so the failure the replicator records says
the outcome there is unknown.
It stays a `failed` peer result, because `getFailedPeers()` counts only that status, and a new one would
read as success.

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

## Secret custody starts before boot-time installs

`installApplications()` decrypts sealed SSH deploy keys and resolves stored registry credentials through
secret custody, which is itself a root built-in (Harper Pro's `secretCustody`). `loadRootComponents()`
therefore starts that one built-in through `startSecretCustodyOnMainThread()` before installing, and the
root load reuses the start through the shared `mainThreadInitialized` gate ([#2780](https://github.com/HarperFast/harper/issues/2780)).
Enforced by `integrationTests/components/boot-install-secret-custody.test.ts`.

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
