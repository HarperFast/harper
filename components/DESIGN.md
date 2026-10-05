# components/ — Design notes

Component deploys, the load lifecycle and packaging.

**Read this when:** touching `deploy_component`, `prepareApplication`, `EntryHandler`, `packageComponent.ts` or `deploymentRecorder.ts`.

Index of every design note: [DESIGN.md](../DESIGN.md).

---

## A deploy builds off to the side, is certified, and only then goes live

`deploy_component` builds the replacement at `.deploy-staging/<deploymentId>/<component>`, certifies
_that_ tree, and only then activates it; a deploy that restarts workers is then decided by its canary
(below). Two things share the word: a build's certification (`.complete`) vouches for its bytes on disk, and
a release's certification is its canary's verdict on its load. Activation is one compensating
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
  installed, so requests during a deploy hit an unrunnable tree.
  `integrationTests/deploy/stage-swap-availability.test.ts`
  samples the live path through a deliberately blocked install and fails against the old ordering.
- **Validation ran after the swap committed**, so a component that installed cleanly but threw at load
  went live anyway while the operation returned an error. The in-process load probe that replaced it, which
  ran between build and activation, is retired as well: it could not reproduce a boot load where it ran, and
  did not run where most deploys do. A deploy that restarts workers is decided by a canary instead — see the
  next section.
- **Root config was written before the build and never rolled back**, so a build or validation that failed
  still left config naming the release, and `installApplications()` installed it at the next restart. The
  entry is now the transaction's third effect, published after the commit — see "Root config is an effect
  of the activation" below.

### A restarting deploy is certified by its canary worker

A deploy with `restart: true` or `'rolling'` (#2315 step 2) is decided by the first worker booted on its release:
a normal boot, held before it binds a listener until it reports whether the deployed component loaded. That load
is a boot load in a fresh realm, so under every lockdown mode it accepts exactly what a restarted worker would
load and rejects what one would fail to. No load in the deploying thread could promise that: the main thread,
where the operations API deploys, runs no application code, and a `freeze-after-load` worker's intrinsics are
already frozen, so a dependency that extends one at load (reflect-metadata) throws there yet loads at every boot
(#2881). The in-process probe that tried, `validateComponentLoads`, is gone in every mode, along with what kept its
throwaway load off the live worker: the guard that dropped its registrations and diverted its status writes, the
transient Scope flag, and the frozen-intrinsics check. `restart: false` gets no verdict —
nothing restarts, so nothing could certify it — and the response reports `certification: 'not-requested'`;
a restarting deploy that could not be armed reports `'unavailable'`.

The protocol, in order (`components/canaryRollout.ts`, `components/releaseCertification.ts`,
`server/threads/manageThreads.js`, `server/threads/heldStart.ts`):

1. **Arm, before the swap.** `prepareApplication`'s activation asks main to register the release. Main
   refuses a second release of a component in flight (409) and answers `unavailable` when no running worker
   places it; an isolation flip, which moves the release to a worker no restart has started, is not armed
   either, and neither is a tree that is a link to its source (`file:` of a directory), which has no bytes of
   its own to restore. Those deploys proceed uncertified, as before. While armed, every HTTP start that places
   the release is held back.
2. **Record, then swap.** `.deploy-staging/<id>/.certification.json` is written `pending`, naming the
   predecessor the swap displaces (`previous`, which step 5 keeps under its own id) and the process
   incarnation. A pending or certified record of this incarnation fences every other preparation of the
   component, `drop_component` included (409 "being certified"); an activation of the same id joins the
   decision instead. A record a dead incarnation left fences nothing. A record that cannot be read fences while
   main's gate holds that release open and is not refusing it, since the restore runs inside the refusal; with
   nothing open, a deploy or a drop is how the component recovers. An activation of that release's own id is refused
   (409) instead of certifying it again, since the new record would overwrite the one naming the release to put
   back. Removing a record retries the transient
   refusals a Windows scanner causes; one that still cannot be removed keeps fencing until Harper restarts, and
   the log says so.
3. **Commit, after the swap.** Main starts the rollout, and drops any in-memory refusal of the component (below).
   First it opens a deploy bracket of its own (`broadcastDeployStart`), which every running thread acknowledges
   before the commit answers, so before the requester's own bracket closes. It closes when the rollout completes,
   after any restore. The workers already running keep their watchers of the component paused through the hold:
   none reacts to a release its canary may refuse, and a refused one is back on disk before they resume. A worker
   the rollout starts never saw the bracket, so it loads the release. The bracket holds watchers only
   (`watchersOnly`): a thread still loading its components ignores it. Its load must not wait on a rollout that
   can be waiting on it, which a canary still booting when another component's release commits would otherwise
   do until its verdict timed out, since that other rollout queues behind the canary's.
   A requester that dies armed is resolved from the disk: committed when its release is live, withdrawn when it is
   not, and committed when the disk cannot say, so that a canary decides — one that loads the previous release
   rejects on its generation, and the restore finds that release already live. Restarts that start replacements are serialized
   (`replacementRestarts`), so no restart boots a worker on a release another's canary has not decided. None starts
   a replacement while another release is armed, either, before each replacement and not only the first: that
   replacement could not decide the armed release, whose own rollout would queue behind this one for good. Worker 0
   is replaced first, so its replacement is the canary, and what an application runs only where `workerIndex` is 0
   is part of the load that decides. The requesting worker is replaced last, once its operation has answered.
   Any restart treats a worker answering a deploy whose release is decided the same way. That deploy waits on no
   rollout, and its peers' answers can outlast the shutdown drain's ceiling. So the restart moves the worker to the
   end and replaces it once the deploy has answered, beating its progress meanwhile (`untilDecidedDeploysAnswer`).
   A release can also be decided while a worker's replacement boots, as when a requesting worker 0's canary decides it,
   or a plain restart's. Where that replacement serves beside the worker, the worker is retired the same way, after
   the rest; elsewhere, at its turn. A worker retired while its deploy still runs, there or with its release still
   undecided, is held by a shutdown drain the deploy registers while its release is armed. That drain is bounded by the
   drain ceiling, and a shutdown before the arm closes as it always did. Until the release is decided, the drain holds
   only as long as a canary may take, the verdict timeout: what decides it may be that release's own rollout, queued
   behind the restart retiring the worker, as for an isolated release a pool worker requested. Only a worker whose
   deploy waits on a decision this restart's own replacements make stays out of the restart's throttle
   (`awaitsDecisionPlacedBy`): waiting on its exit would hold back the start that decides it. One whose release only a
   queued rollout can decide waits its turn like any other, so a pool of such workers never drains out at once. Where
   replacements cannot start beside their predecessors, worker 0's canary is admitted only once the requester has
   exited, so there the rollout still waits for that deploy. There, too, the copy of any worker still answering a
   certifying deploy, whichever restart retires it, starts only once that worker has exited, since its drain keeps its
   ports bound until the deploy answers. A withdraw
   after commit is refused: the release is live, and dropping its registration would leave the rollout
   replacing workers unchecked.
   A worker already loading when a release is armed was not held for it, yet its load can still reach that release:
   the requester's deploy bracket holds its load of the component until after the commit. So every HTTP worker
   reports its load before it binds, held or not, and one whose report comes after a release it was loading across
   committed is refused and started again, now held for that release: a rollout replaces its own replacement again,
   and main restarts anything else. A barrier at arm cannot do this instead: that bracket, opened before the arm,
   holds the very load the barrier would wait for. Where a replacement can only start once its predecessor has exited,
   a copy the gate stops is started again too, rather than leave its slot empty. Every such copy starts only once nothing
   is armed and no decision about a release it would load is under way: a refusal being recorded is restoring its
   predecessor, which no load may race.
4. **The canary.** The first held start boots normally with its loader tracking a private boot outcome per
   component (`trackBootOutcomes`): executed, skipped (`dev-only`, `if-installed`, safe mode), failed (every
   failure site of the load), or pending (a load deferred behind a preparation lock, which it waits out).
   Public component status cannot serve: a later status write overwrites a failure, and a skipped load reports
   itself loaded. The verdict names the release live when the load began and when it reported, and any other
   generation than the one armed is a rejection. `loaded` certifies; `failed`, exiting, or no report within
   `max(2 × threads termination timeout, 60 s)` rejects; `skipped` or `absent` leave it `uncertified`, and the
   rollout goes on unchecked, as every restart did before. Replacing nothing is not a verdict: a rollout that found no
   worker to replace — the only one died between the swap and the commit — has the start it held back load the
   release instead.
5. **Decide.** Before a release is refused, every held start loading it is stopped, the canary and any other, so a
   restore never races a worker still holding the release. One of them can be the undecided canary of another
   release it also loaded. That release is decided from the canary's own report if it made one, rejected if it went
   silent, and interrupted only if it was stopped before either, rather than left waiting on a worker that is gone,
   which would also hold every later restart behind its rollout. A rollout declined at shutdown still waits for a
   decision under way before it closes, or the close would remove the record that decision is about to write. `certified` is written durably. A rejection is written
   `rejected` before anything moves; then step 6 activates the predecessor, only while the rejected release is
   still the live one (`onlyIfLive`), and the record is removed once it is. With no predecessor (a first
   deploy), or a restore that did not land, the release stays live and FAILS CLOSED: every thread's loader
   refuses it (`failClosedReleases`), boot does not reinstall it, and only a deploy, an activation or a drop moves
   on. A record belongs to the component the deployment's ownership sidecar names, else its own `component`, else
   the component it is live for, so an unreadable sidecar never lets a refused release load; retention pins its
   predecessor the same way, and pins everything when a record can be attributed to no one. When even the record
   write fails, main refuses it in memory, bound to that deployment id so a later release
   loads, and the record stays `pending` for the next boot to settle. The origin's deploy fails with the
   decision in `certification` (`status`, `reason`, `failures`, `restored`, `failed_closed`), and nothing was
   replicated. The decision stays answerable after the rollout ends, until its requester releases it or exits, and until every
   deploy that joined it has left: an activation of the release already live while its decision is open joins it
   instead of arming, counts as answering a certifying deploy like the requester, and on finishing leaves rather than
   releasing the requester: a fast
   refusal can end the rollout before the deploy reads its decision, which would otherwise read nothing and replicate
   the refused release as uncertified. A join that finds its decision already closed reads it from the record that
   decision left, as a later activation would. No record, or a `certified` one, means the release stands, decided. A
   `rejected` record is certified again. One still `pending` is refused with 409 until a restart settles it, since its
   decision may have been a refusal whose record could not be written. An `interrupted` certification — the process shutting down, a rollout that failed before any
   canary decided, or a `certified` decision whose record could not be written — is restored exactly as a
   rejection is, which is also what the next boot does with a record left pending: an undecided release never
   stays live. The `load` progress phase spans the wait for the
   decision.
6. **Roll out.** Every later replacement is held too, and admitted only once its own load of the release
   reports `loaded`, as is any start held while the canary was deciding: the canary's verdict certifies the
   release, not another worker's load of it. A held start that reports nothing within the verdict timeout is
   stopped, whatever it was waiting on, and rejects only what it could have spoken for: never a release it booted
   while that release was armed. A later failure keeps the old worker and every worker after it, stops the rollout, and
   restores nothing: the canary proved the release can load. A replacement stopped instead because another release
   it loaded was refused failed nothing of this one, so its worker is replaced again, held only to this release. A
   rejection ends the rollout wherever it was decided. A crash restart during an undecided canary waits for the decision; a held start the gate stopped
   that no restart owns (a crash restart that became the canary) is started again once the decision is made,
   on whichever release it left live.

Where two workers cannot share a port (macOS, Windows, a dedicated worker), a held replacement still boots
beside its predecessor, since it binds nothing until admitted, and the predecessor is retired at admission.

**Boot.** Main resolves the records a dead incarnation left (`resolveInterruptedCertifications`, after
interrupted activations settle and before `installApplications()`): pending becomes rejected and is restored
("the process ended before its canary decided"); a rejection with a predecessor is restored again; certified, or
no longer live, is removed; rejected with nothing to restore is kept, failed closed. An unreadable record is never
permission to run, and neither is one a dead process left pending that boot could not settle: either fails its
component closed. Retention pins every predecessor a record names, and prunes nothing
of a component one of whose records cannot be read. And a package deploy's tree is no longer reinstalled by the
restart that follows it, or at a later start: a deploy never writes the application lock, so the root reload used to
resolve the package again and swap a fresh install over the release the deploy had just activated. When the live
tree's deployment declared an entry, startup now compares that entry with root config, ahead of the lock
(`keepsInstalledTree`). It keeps the tree when the two match and installs from root config when they differ. So the
tree that runs is the tree certified. The lock still names the entry the deploy replaced, so a root config set back to
that entry would otherwise keep the deployed tree. A record that exists but cannot be read, one of a later version
included, installs from root config, since the lock cannot describe a deployed tree. Otherwise the lock decides, but
only for the tree it records installing. With each entry, startup records the marker of the tree its preparation made
live, taken under that preparation's lock (`trees` in `harper-application-lock.json`, `null` for a link). Reading it
afterwards could pick up a tree a competing deploy swapped in. A live tree whose marker names anything else was
made live by a deploy whose record is gone, so it is installed over. A lock written before it recorded trees decides
for any tree, as before, until the next install records one.

**Rolling.** `restart: 'rolling'` certifies on the origin exactly as `true` does, while the peers only stage the
release. A `restart_service` job then activates it on each peer in turn (`activate_deployment`, `bin/restart.ts`)
with `deploy_component { deployment_id, restart: true }`, which certifies it there with that peer's own canary.
Verdicts are per node: a peer that refuses keeps its previous release, nothing is rolled back elsewhere, every peer
is visited, and the job fails naming each one that did not take it, with every peer's outcome in its message. A peer
that staged the release but left the topology before its turn did not take it either. A peer
that activates the release uncertified (`uncertified`, `unavailable`) took it, as the origin would have. The field
is caller-visible on `restart_service`, so `chooseOperation` lets a caller set it only when it may also deploy
(`deploy_component`, token scope included); the deploy flow enqueues the job directly. A rolling deploy whose
release could not be armed on the origin restarts as it did before.

**What it does not cover.** The release is live on disk before its canary boots, so a worker the rollout has not
reached that first imports a module during the hold reads it from the new release
(`integrationTests/deploy/canary-rollout.test.ts` pins this). Its watchers are paused (step 3), so an import is
the only way the release reaches it. Taking a node out of rotation for the rollout is harper#2975. A canary that
takes worker index 0 also sets up that index's singletons (scheduled jobs, data loads, `sourcedFrom`
subscriptions) while its predecessor still runs them, as any replacement that overlaps its predecessor does.

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
  directory because a fresh UUID could not collide; a public id can be repeated by an operator, so a claim
  rejects another component's directory and any directory carrying `.complete`, and rebuilds only over an
  uncertified partial of its _own_ component — in a fresh claim, never inside the partial tree. Ownership is
  published as part of the claim, not at certification, because `buildCandidateApplication` can spend minutes
  resolving and packing before any tree exists to infer an owner from. The claim is built at
  `.deploy-staging/.claiming-<uuid>-<digest>`, named there, and renamed onto the id, so the directory only
  ever appears at its id already attributed. It used to be an exclusive `mkdir` followed by the sidecar write,
  and a death between the two left an unattributed directory — indistinguishable from a claim in flight, so
  refused forever. Now no live claim is ever visible unattributed: an EMPTY directory at an id is that
  wreckage from an older build and is taken over (`rmdir`, which removes nothing else); a non-empty
  unattributed one is still refused. A claim that died before its rename names no id, is skipped by every scan
  of the staging root (all of them skip dot-prefixed entries), and is removed under the component's lock by its
  next deploy, or by `drop_component`; a digest of the component in its name, rather than the name itself, makes
  that attributable without a read and cannot push a long name past a filename limit.
  On Windows a rename onto any existing directory fails with the `EPERM` a transient holder raises, so the
  destination is classified before renaming rather than after a spent retry budget. The id this request names
  is also pinned through the preparation preamble, so retention cannot evict the artifact the request is about
  to use — which it otherwise would, immediately, at `deployment_stagingRetention_maxCount: 0`. What an id
  names after its activation is the next section's subject.
- **Staging owns its bytes.** A `file:<directory>` source is refused, and so is any symlink in the built
  tree resolving outside it (bar the `node_modules/harper`/`harperdb` links the loader owns and repairs).
  Certification fsyncs the tree but follows no links, and the post-swap relocation repair leaves external
  targets alone — so a link out of the build is a hole in "activate exactly the bytes that were certified"
  that only a delay makes reachable. **`.complete` is a durability marker over the bytes, not a seal on
  them:** nothing stops a dormant artifact being edited while it waits, so the link rule is re-run at
  activation rather than trusted from the marker. Content tampering is still not detected — that needs a
  manifest the marker is bound to; a broken entry point is caught only by the canary of an activation that
  restarts workers.

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

An `.activation.json` journal is written beside the candidate — with a `.complete` marker recording that the
build succeeded — before the first rename, so `recoverInterruptedActivations()` can
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
recovery then put it back into its deployment's record, or sweep it when nothing can keep it (see "A deployment
id keeps naming its release"), since otherwise the components root would grow by a whole component version per
deploy. The retire is **correctness, not hygiene** — that marker is what stops the legacy pass treating the record as
authoritative once the journal is gone — so a failure to retire propagates and the component fails closed
with its journal intact. Only the sweep itself is best-effort, because it costs disk rather than a wrong
decision. For the same reason, a swap whose rename cannot be confirmed on storage skips both the retire
and the journal removal: the journal is what would carry the activation forward after a power loss.

Two limits are deliberate and tracked separately: activation is two renames, so the live _pathname_ is
briefly absent (in-memory resources are unaffected, but a component that opens its own files during a
request can still see a gap); and nothing loads a release before it is live: a restarting deploy's canary loads
it from the live path, so a deploy that restarts nothing goes live unchecked.

### Root config is an effect of the activation

A component's root-config entry changes only as a journaled, durable effect of an activation that committed
on this node — or of `drop_component` — so it never names a release that is not live here, and a crash at any
boundary settles config to the same end state as the tree. `deploy_component` only _declares_ the entry
(`describeArtifact`); `prepareApplication` turns the declaration into a `RootConfigEffect`
(`components/rootConfigPublication.ts`) and `activateCandidateApplication` owns applying it:

- `set` — a package build publishes the entry it was declared with, replacing the component's entry whole.
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
the error says so. A fresh deploy converges. So does a retry of a `deployment_id` activation: its preamble settles
the kept journal, publishing the entry, and then answers that the id is already live here, so the operation goes
on to replicate. Peers of an immediate deploy hold no artifact, so its id answers 404 there. Even so, a condition
that would fail every publish is refused BEFORE anything moves: `assertRootConfigEffectPublishable`
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
config document besides `set_configuration` and the deprecated `drop_custom_function_project`'s removal from
the legacy `apps` list, both of which take the same lock around `updateConfigValue` — and that reads and writes
the same file the lock is keyed by, the one boot reads, not a path rebuilt from the document's `rootPath`. The
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

Not covered, and pre-existing: other threads' memoized config stays stale until a restart re-inits it, and the
boot-time config writers and out-of-process editors are not serialized with the lock. Validation of a package deploy
now runs under the entry in force rather than the one being deployed, since the latter is no longer published until
the commit.

### Retention of dormant staged builds

A journal-less deployment directory holding `.complete` and the owner's tree is a **dormant build**: built
and validated, activated by nobody. Recovery used to remove every owned journal-less directory; it now keeps
dormant builds and bounds them per component to `deployment_stagingRetention_maxCount` (default 5, 0 keeps
none), newest by `.complete` mtime, ties broken by deployment id so concurrent passes pick the same victims.
Everything else journal-less — a partial tree, a directory whose tree already moved live, a stale
`.unsettled` — is still residue and still removed. Two things produce them: a stage (`activate: false`), and every
activation that displaces a release it can put back under its own id (next section). A deployment's record — its
directory without a tree — is not a build and is not counted.

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
`drop_component` reclaims the dropped component's dormant builds (`retireComponentDirectory(...).discard()`),
since no later deploy of that
name will. Only ENOENT is absence; any other read error keeps the entry and moves on. Pruning is disk
hygiene: it never fails a component closed and never replaces a deploy's own error, so the bound is
best-effort under filesystem failure and is not a storage quota — journaled, unsettled and unowned
directories are preserved by design and can still fill a volume.

### A deployment id keeps naming its release after the swap

On a node, a deployment id names its release for as long as the node holds that release: while it is dormant,
`deployment_id` activates it; while it is live, activating it answers that it already is, without a swap; when a
later activation displaces it, it becomes dormant again under the same id, within
`deployment_stagingRetention_maxCount`. A node holding neither answers 404 (#2315 step 5). Four pieces:

- **Provenance rides the tree.** `buildCandidateApplication` writes `.harper-deployment.json` — `{ v, component,
deploymentId }` — at the top of every candidate it extracts, after the install and before `.complete`, replacing
  any marker the payload carried. It moves with the tree through the commit rename, so the live tree always names
  the build that made it live, and anything else that replaces the directory replaces the marker too: it is
  absent, never stale. A `file:` link gets none, since its target is not the deploy's to write, and a live link
  has no provenance whatever its target holds. The tree is the component's own to write, which is why the marker
  carries only an id: nothing published on activation comes from it. A component rewriting its own marker can
  mislabel only its own releases. `package_component` and `get_components` leave the top-level marker out; a
  deeper file of that name is the component's.
- **The id's record outlives the swap.** A build whose caller declared what it publishes (`describeArtifact` — every
  `deploy_component`) writes `.artifact.json` before `.complete`, as a stage does, and a committed activation
  keeps `.deploy-staging/<id>` minus its tree and journal: `.component`, `.complete`, `.artifact.json`. That
  record is where the release goes back to, so its directory entry is flushed before the swap, as a stage's is. A
  boot install, `add_component` and a link build declare nothing and keep none, as before. Keeping the descriptor
  here rather than snapshotting the entry at displacement is
  deliberate: for a boot install the entry in force is the new build's, so after an out-of-band edit the displaced
  tree would be described with the wrong package. Re-activating an id publishes what that deployment declared,
  which is the contract a staged artifact already had; `set_configuration` edits made while it was live are not
  carried back, just as a package redeploy replaces the entry whole. One side effect, stated: an immediate deploy
  that crashes before its first rename is now DESCRIBED, so recovery returns its candidate to dormant rather than
  discarding it.
- **The displaced tree goes back into its record.** `retainDisplacedRelease` runs where a committed activation
  disposes of the tree it displaced — after the retire, in `activateCandidateApplication`'s post-commit block, in
  `sweepAsideRecords` on a roll forward, and in the legacy pass for a retired tree still in the aside — and
  renames it into `<record>/<component>` when its marker names this component's record. **Only an explicit
  retention decision deletes a tree**, so its verdict is three-way: _kept_; _ineligible_ (no marker, no usable
  record, or `maxCount: 0`, when the record goes too) — swept as before; or _failed_ (a read error other than
  ENOENT, or a failed rename) — left retired in the aside with its record for the legacy pass to retry at the next
  preparation, since on Windows the rename and the delete both fail while something holds a handle in the tree.
  A failure after the rename (syncing its parents) propagates, as the aside syncs do. At the activation it keeps
  the journal, so recovery repeats the aside barrier before letting it go — not the kept tree's own entry, whose
  loss costs only that kept copy. In recovery it fails the component closed with its journal, the retire's own
  contract. The kept tree's
  `.complete` mtime is refreshed (retried briefly) so retention orders it by when it stopped being live; left at
  its build time, stages nobody activated would outrank it. **Only the activation's own site prunes** after a
  keep, pinning the kept id: settlement runs inside a request's preamble, whose pin it cannot see, and a prune
  there evicted the very artifact that request was activating. The pass a settlement runs inside counts what it
  kept and pins it beside its own pin, so a refresh that failed cannot let that pass evict the release it just put
  back. A kept release is not re-certified: it is kept as
  it was when displaced, including what it wrote into its own directory while live, and activation re-runs the
  link rule; an activation that restarts workers has its canary check the load. An absolute link `repairRelocatedDependencyLinks` wrote after its own swap (a
  Windows `file:`/workspace junction) names the live path, so such a release's re-activation is refused 409.
- **Activating the live id answers without a swap.** After the preamble, `prepareApplication` in `activate` mode
  compares the live marker with the id: equal means the release is already serving here — a retry whose earlier
  attempt swapped on this node and failed later or elsewhere — so it sets `alreadyActive`, requests a restart
  (nothing can tell whether the running generation ever loaded it, the reasoning a late startup preparation
  follows), and returns; `deploy_component` emits the `prepare` phase end itself, since nothing ran
  `validateCandidate`, and replicates. A restart it performs replaces every worker, dedicated ones included: which
  ones loaded the previous release is unknowable, since the preamble may just have published an isolation change.
  Per node, with no cross-node inference: a node that swapped answers success, one still holding the artifact
  activates it, one with neither answers 404. Only `activate`: a deploy or stage claims an id the origin minted
  fresh, and harper-pro never resends a replicated operation (`sendOperationToNode` is one socket per call), so a
  replicated deploy of an id this node already holds — only a hand-crafted `_deploymentId` produces one — is refused
  by the claim. A record whose release is neither live nor kept answers 404, where a missing tree used to answer 409.

**A record is stale only when nothing refers to it.** "Not live" is not enough: a crash after the commit and
before the re-home leaves the displaced release's record and its tree in `.deploy-aside`, and a boot scan can
reach the record before the journal that will re-home into it — the record would be deleted and its only tree
swept. So a record is residue only when neither the live marker nor the marker of any tree in the owner's aside,
retired or not, names it. Boot recovery checks that unlocked and leaves a referenced record alone without the
lock, as it does a dormant build (#2531: a per-directory lock on every pass makes healthy components lose the
250 ms probe to sibling threads), then re-derives it under the owner's lock before removing a stale one.
`drop_component` removes the dropped component's records and abandoned claims along with its dormant builds.

Compatibility: a tree made live before this change has no marker, so the first deploy after the upgrade sweeps
it. An older build reads a record as residue and removes it, and a kept release as an ordinary dormant build it
can activate; the marker is an ignored file to it. The journal format is unchanged. A peer on an older build
answers 404 to a consumed id, as before. `deployment_stagingRetention_maxCount` (default 5) now bounds kept
releases with staged builds, and each is a whole installed tree, so at the default a component holds up to five
extra copies of itself; `0` keeps no previous release, and the rest of this section still applies. A package
deploy's tree survives later starts while root config names the entry its deployment declared. Once root config
names another entry, startup installs that one from its source; that install keeps no record, but the deployed tree it
displaces is kept, which is the one worth keeping.

## Component preparation is serialized across worker threads

`prepareApplication()` performs one transaction per component: build the replacement, certify the build, then swap it in (see "A deploy builds off to the side" above). Deploy operations can execute on worker threads as well as main, so a module-local promise queue is insufficient—each worker has its own module registry. `withComponentPreparationLock()` (`components/componentPreparationLock.ts`) instead acquires an atomic filesystem lock keyed by the absolute component path. The deprecated `install_node_modules` operation uses the same lock, so it cannot run npm concurrently with a deploy.

The deploy lifecycle broadcast deliberately sits _outside_ the lock. Overlapping requests therefore increment the existing per-component lifecycle refcount before queueing; watchers remain suppressed continuously until the final queued preparation ends. The lock itself covers credential materialization, extraction, and installation. Its fully-written owner record is published with an atomic rename, so contenders never observe a partially initialized lock. A preparation caller never steals a lock from a known-live owner based on elapsed wall time: installs can be long-running and clocks can jump. Locks from a dead process are reclaimed, and a same-process contender asks the main thread whether the owning worker still exists so a worker crash does not wedge that component until Harper restarts. A ticket its owner could not remove — a Windows sharing violation, a scanner holding the file — would name a finished holder that is still alive, so a release whose unlink keeps failing publishes a `<lockName>.released.<token>` marker instead, which contenders honour by clearing both. Only the ticket's owner writes one, after confirming it still owns the ticket — or, when a scanner holding the ticket without read sharing hides its record, knowing it can only be its own, since the ticket's name carries its token — and tokens are never reused, so a marker cannot retire a holder that has not finished. A process running an older build ignores markers, so overlapping processes of mixed versions do not get this guarantee, and a ticket left live-looking before the upgrade stays until that process restarts. Windows refuses to open a claim whose unlink is in progress (`EPERM`) until the unlinking handle closes, so a contender retries that read until the claim reads or is gone; one that stays unreadable fails the scan instead of reading as absent, since dropping a live ticket would admit a second holder. An older build fails the acquire on that `EPERM`. The boot-time bulk-recovery probe is deliberately different: it never renews its 250 ms deadline, even behind another live recovery, so it can defer that component and let the worker bind its listener.

A plugin load that begins while its component is being deployed waits for that lifecycle to end before
starting `handleApplication`; if a deploy begins during the load, the plugin timeout counts only active,
unpaused load time. This prevents a long install from looking like a hung plugin while its entry handlers
are deliberately paused against the intermediate tree.

Since #2345 no preparation extracts in place; the live tree moves aside only at activation. What
remains is the legacy recovery pass (`recoverOrCleanupStaleExtractionPaths`), whose
`rollbackExtractedDirectory` atomically renames whatever holds the live path into hidden staging before
restoring the prior tree, so a live writer cannot wedge rollback with `ENOTEMPTY`; cleanup completes
while the same-component lock is still held.
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
race with the running worker. Recovery is durable across a process crash. The legacy pass relies on
rename/create ordering rather than `fsync`, so a host power loss can lose its marker; activation and drop
flush theirs.

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

### The component load lock is keyed by application and plugin

`sequentiallyHandleApplication` (`components/componentLoader.ts`) holds a cross-thread lock keyed by the
application and the plugin type, `${appName}\0${pluginName}` (#2884, for #3184): one application's load of one
plugin is serialized across threads. Keyed by the plugin type alone, one application's hung
`handleApplication` timed out every other application's load of that plugin; NUL separates the two
because `appName` can contain dots and slashes.

Before #2884 the plugin-wide key was also deliberate for a reason #2884 did not revisit: plugin
modules are per-thread singletons carrying module-level state (`server/http.ts`'s `universalHeaders`
ownership array, `resources/graphql.ts`'s `knownGraphQLDirectives`, the scheduler's
register-inside-the-lock contract), and applications load _concurrently_ — `serializeComponentLoad`
serializes per application name and all applications go into one `Promise.all` — so two
applications' `handleApplication` for the same plugin can now interleave on a single thread. Each of
those three tolerates it: the http plugin's `handleApplication` is synchronous and only its first
(root) invocation owns the security headers, `knownGraphQLDirectives` is filled at module load and
only read in `handleApplication`, and the scheduler keys registration by application name behind an
idempotent `startSchedulerEngine()`. A plugin that keeps per-thread state across an `await` inside
`handleApplication` would not.

The price of the lock is that whatever a plugin does inside it is paid by that application's load of
the plugin on every other thread.
So a plugin must return a promise that settles with its real outcome: the `withDeployAwareTimeout`
watchdog exists for a _hang_, never as the reporting path for a failure the plugin already diagnosed. A
success-only wait is what turned one unparseable schema into 30s of instance-wide gating per broken
component (#1917). `Scope.waitForInitialLoads()` is that promise — it resolves once the entry handler's
initial scan and every operation that scan started have completed, and rejects with the first failure,
after draining the rest so no sibling operation outlives the lock. The watchdog can still cut that drain
short, so the serialization the lock buys is bounded by the timeout rather than absolute.

## Peer-side deploy_component payload read: retryable blob stalls and `Readable.from()` cancellation

`readPayloadBlobWithRetry` (`components/deploymentRecorder.ts`) wraps the peer's read of a replicated `hdb_deployment` row's `payload_blob` so a transient 503 `BlobReadError` (`BLOB_UNAVAILABLE_STATUS`, `resources/blob.ts`) — content bytes not arriving within `blobReadTimeout`, e.g. a parked blob send on the origin — retries instead of failing the whole deploy. Two non-obvious constraints shaped the design:

- **Retry is only safe before any byte has reached the consumer.** Once a chunk is handed downstream, re-opening `Blob.stream()` from byte 0 would duplicate it (there's no cheap way to resume from an arbitrary offset across a fresh stream without also plumbing `Blob.slice()`, which was out of scope for this fix). So the helper retries only while the current attempt has yielded nothing yet; a stall after partial content fails immediately, same as before this existed.
- **Backpressure and cancellation are two different problems, and both are easy to get wrong with a hand-rolled `ReadableStream`.** An early version wrapped the retry loop in `new ReadableStream({ async start(controller) { for await (...) controller.enqueue(chunk) } })` — this eagerly drains `streamFactory()` regardless of `controller.desiredSize`, defeating the whole point of not buffering a multi-GB payload in memory. Switching to an `async function*` consumed via `Readable.from()` restores real backpressure (the generator only resumes when the consumer wants more, matching how the un-wrapped `Blob.stream()` behaved pre-fix). But `Readable.from()`'s `return()`-on-destroy cancellation only takes effect at the generator's _next_ `yield` — while the loop is stuck retrying (no `yield` reached yet), destroying the `Readable` does nothing until the loop naturally exits, verified empirically (a generator that never yields kept retrying long after `.destroy()`). The fix: thread the constructed `Readable` back into the generator via a mutable cell (`readable` doesn't exist until after `Readable.from()` returns, so it can't be closed over directly) and check `.destroyed` explicitly at each loop iteration and after each backoff sleep.

## An origin waits for a peer's deploy answer only as long as the peer may take

The origin of a replicated `deploy_component` hands `server.replication.replicateOperation` a `timeoutMs`
from `peerDeployAnswerTimeoutMs(req)` (`components/operations.js`). It is the sum of what the peer is
allowed for that request: its payload wait (`deployment_timeout`, counted twice when credential references
must also replicate in), two full preparation budgets (`componentPreparationBudgetMs`: every extraction
command and both install commands at their allowances), a margin for the swap and the canary's decision, and the
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
configures beyond that margin, which live in the payload the origin does not parse. Covering the
first would take a deadline that follows the peer's progress rather than a sum of its allowances. The
deadline is not cancellation: a peer past it may still finish, so the failure the replicator records says
the outcome there is unknown.
It stays a `failed` peer result, because `getFailedPeers()` counts only that status, and a new one would
read as success.

## A replicated deploy reports each node's install fingerprint, and never acts on it

Every node of a replicated `deploy_component` resolves and installs the release itself, so two nodes can end
up with different code and nothing says so (#2295). Moving the release between nodes was ruled out: shipping
the built tree (#2917, closed) was too heavy, and a strict tree check would refuse a mixed-platform cluster.
So each node records what it installed, and the origin reports a difference without acting on it.

- **The fingerprint** (`components/installFingerprint.ts`) is taken only for a deploy or a stage, after the
  install and before the swap (`fingerprintInstall`, a `prepareApplication` option). It has two parts:
  - `source` is the resolver's own name for what it packed, never a second hash. It is `git:<commit>` from
    Harper's clone, `npm:<name>@<version>` from `npm pack --json` for a registry spec (a tag resolves to one),
    or npm's reported `integrity:<sri>` for a git spec npm packed itself, or a tarball URL. A source the
    resolver could not name is `unidentified`, which never matches. So is a local `file:` path, because each
    node reads its own copy. The one exception is an absolute directory path given without `file:` on Windows:
    Harper copies it through `npm pack` instead of linking it, so npm's reported integrity for that copy names
    it. A payload has no `source`: its peers read the origin's blob. Only a fingerprinting build asks git for the
    commit, and a git failure there leaves the source `unidentified` rather than failing the deploy.
  - `lockfiles` is the sha256 of each root lockfile in `PACKAGE_LOCK_FILES`, by name. An absent lockfile is
    not listed. One that can't be read is `{ unreadable: <code> }`, never absent.
- **The comparison** runs once, on the origin, on the aggregate `response.replicated`, just before the
  recorder re-records it (`markInstallComparisons`, `components/operations.js`). So the per-peer callback's
  entries are replaced rather than contradicted.
  - Each peer gets `install_matches` and `install_differs`. `install_matches` is `false` when anything
    compared differs. Otherwise it is `null` when any evidence is missing, unreadable or `unidentified`, as
    from an older Harper or a failed peer, and `true` only when everything compared matches.
  - Only lockfile names this node recognizes are compared.
- **Where it shows:**
  - one `warning` event, which the CLI prints;
  - a sentence on the final message, added after staging replaces the message;
  - the per-peer fields in `peer_results`, which `normalizePeerResult` keeps only once a comparison ran;
  - the origin's own fingerprint, in the row's `install_fingerprint`.
- **It never changes the outcome.** Drift alone keeps success. A real peer failure still fails the deploy,
  after the warning has fired.

A match means equal evidence, not identical trees. A custom `install_command` can install different
dependencies and leave the same lockfile, or none. Lockfiles written against different registry mirrors
differ while the code matches. This prevents nothing, and a restart can still re-resolve a package component
(`installConfiguredApplication`) with no report.

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
