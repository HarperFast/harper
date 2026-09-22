# config/ — Design notes

Config composition, persistence, env layers and hot reload.

**Read this when:** touching `configUtils.ts`, `readConfigFileSync.ts`, `harperConfigEnvVars.ts` or a root config watcher.

Index of every design note: [DESIGN.md](../DESIGN.md).

---

## `set_configuration` replication is opt-in; `replicateOperation` is default-on (`config/configUtils.ts`)

`server.replication.replicateOperation` (installed by harper-pro's replicator) fans out whenever
`req.replicated \!== false` — absence of the flag means "replicate". That default-on contract is what
DDL ops rely on (`dropSchema`/`dropTable` call it unconditionally), so a handler that mirrors the
drop_schema pattern without a guard silently becomes replicate-by-default. `setConfiguration` must
stay **opt-in** (`if (replicated)` truthy guard) because config bodies routinely carry node-local
params (ports, paths, node identity) that would clobber peers. Two invariants to preserve:
`replicated` must remain in the handler's destructure strip-list on both origin and peers (peers
receive `replicated: false` in the forwarded body; anything not stripped is treated as a config
param), and there is deliberately **no** per-param node-local/cluster-wide guard here — per-field
replicability metadata is deferred to the cluster-level-config work (CORE-3018), which will own that
schema. Per-peer failures never reject: they come back as `{status: 'failed', reason, node}` entries
in `response.replicated[]`, and `message` still reads as success (same contract as drop_schema), so
operators must inspect the array for per-node outcomes.

## Root config watchers must read synchronously (`config/readConfigFileSync.ts`)

`atomicWriteFile()` swaps the config file in with `renameSync` and, on Windows, retries the
`EPERM`/`EACCES`/`EBUSY` a still-open destination handle produces — blocking the calling thread in
`Atomics.wait`. The handle that blocks it belongs to the _process_, not to the thread that opened
it: measured on `windows-latest`/Node 24 (harper#2313), a single Node **read** descriptor on the
destination fails the rename, while `fs.watch` and chokidar's own handles do not.
`set_configuration` reaches that loop from a live request thread, and every worker runs root config
watchers over the same file, so an **async** read in a watcher is unsatisfiable by construction:
libuv opens the descriptor on the threadpool but closes it from JS, which cannot run while the same
thread is blocked in the retry loop. The worker then deadlocks against its own
watcher and burns the entire budget before failing (harper#2191, reproduced by the Windows
integration job). Both root watchers — `RootConfigWatcher.handleChange` and an `OptionsWatcher`
explicitly identified as a root-config watcher — therefore go through `readConfigFileSync()`, which
holds no descriptor across a yield. A component's own config remains asynchronous even if the
component names it `harper-config.yaml` or `harperdb-config.yaml`. Do not "modernize" root-config
reads back to `fsPromises.readFile`.

Three constraints follow from it. The reader gates its retry to win32 (`isSharingViolation`); the
writer does not (`configUtils`' `isRetryableRenameError`, same three codes, any platform). That
asymmetry is deliberate: a misclassified read falls through to the timer ladder below and still
recovers, a rename has nothing to fall through to, and `process.platform` does not answer the
question that matters — whether this filesystem can replace an open file. A Linux worker whose
rootPath sits on WSL drvfs, a CIFS/SMB mount, or a Docker Desktop bind mount reports `linux` and
still returns these codes transiently.

The reader's 500ms budget is one deadline **per path shared by all callers on the thread**, not per
call — a worker holds one `OptionsWatcher` per root-declared plugin (10+ on a stock install,
`TRUSTED_RESOURCE_PLUGINS`) over the same file, all reacting to a single change event, so a per-call
budget would serialize into N x 500ms of blocked event loop whenever a writer's lock outlives it.

Both watchers parse through `parseConfigFile()` (`config/parseConfigFile.ts`) rather than calling
`yaml.parse` directly: yaml's `prettyErrors` frames the offending source lines into the error's
`message`, and the root config holds credentials, so a parse failure would otherwise ship that
frame to the component log (`OptionsWatcher` → `Scope`) or the config log.

And a lock that outlives even that emits no new watcher event when it clears, so both watchers hand
the failure to `ConfigReadRetry` (`config/configReadRetry.ts`) rather than going stale: retrying from
a timer holds no descriptor either, so it cannot re-enter the deadlock. A ladder rung passes
`waitForLock: false` — the ladder already owns the retry, and letting each rung re-enter the
blocking budget would multiply one lock incident into a stall per rung. The ladder is bounded by
wall clock and its backoff is derived from elapsed time rather than from how many times it was
armed, because watcher callbacks and timer callbacks share one entry point: a rename burst delivers
several chokidar events in milliseconds and would otherwise both spend the ladder and push the next
rung out to the maximum before the writer has let go.

A deletion supersedes the reads already in flight, so `OptionsWatcher.#handleUnlink` claims the
current read sequence rather than only cancelling the ladder: an asynchronous rung completing after
it would otherwise put the removed file's options back, or find ENOENT and report the same deletion
a second time as a `remove` asking `Scope` to restart a scope that deletion just settled. That
ordering cannot be staged from a real deletion — every technique that holds a `readFile` open past
chokidar's `unlink` (threadpool saturation, a FIFO) holds the `unlink` behind it too, because
chokidar's own event delivery needs the same threadpool; measured here, a saturated pool produced no
`unlink` for at least 3 seconds. The regression therefore delivers the deletion through
`_simulateUnlinkForTests`.

### An empty read is a writer mid-write, not an empty config

A non-atomic writer — an operator's editor, a shell redirect, anything that is not
`atomicWriteFile()`'s temp-file-and-rename — truncates the config before it writes it, and the
synchronous read is fast enough to land in that window where the async read never was. chokidar
throttles change events per path for 50ms and _drops_ the throttled ones, so the event carrying the
content is routinely discarded as a duplicate of the truncate's: an empty read that is discarded is
the last read that config gets, and the thread holds the pre-truncate value indefinitely
(`RootConfigWatcher`) or reports the scope as removed (`OptionsWatcher`). Both therefore hand an
empty read to `ConfigReadRetry`, the same ladder a lock takes and for the same reason — there is no
further event to re-read on. `OptionsWatcher` applies it on both read paths, not only the
synchronous one: the asynchronous read is far less likely to land in a truncate window, but the
consequence there is a spurious `remove` that tears the scope down.

A read that _parses_ to nothing is the same event and takes the same ladder: a truncated document,
a lone `\n` and a file of nothing but comments all yield `null` from the parser rather than
throwing. `OptionsWatcher` judges that on the file's own parse, **before** `overlayRootEnvConfig`,
which returns a non-null object whenever a config env var is set — the norm in containers — and
would otherwise launder a half-written file into a valid-looking env-only config and wipe the
file's own options.

Past the ladder the emptiness is believed, and what that costs depends on whether the scope has
settled: a worker still booting starts on the defaults, while one already running keeps the config
it has and only warns. The asymmetry is deliberate in both halves — a running worker must not let a
truncate window that outlived the ladder reset every scope, and a booting one must not hold
`Scope.ready` open waiting for a file that is genuinely empty — but it does mean an operator who
empties `harper-config.yaml` at runtime gets divergence between workers until the next restart.

### `ready` means the watcher is armed

`RootConfigWatcher.ready` is a startup barrier — `harper_logger`'s `updateLogSettings()` attaches
its `change` listener only after awaiting it — so it has to mean "watching", not merely "the first
read landed". The synchronous read would otherwise emit `ready` from inside chokidar's initial `add`
dispatch, and on darwin FSEvents has not armed its stream at that point: a write in that window is
dropped with no later event to recover it (the async read used to defer past it by a threadpool
round-trip, which is why this surfaced only when the read went synchronous). Measured on the
harper#2191 review head, writing that far after `ready`: 0ms is lost, 5ms and beyond is delivered.

So `ready` is gated on chokidar's own `ready` — its initial scan has established the native
watches by then — plus a darwin-only grace over that measurement for the kernel-side warm-up
chokidar cannot observe. Neither half is sufficient alone: chokidar's event still lands inside the
warm-up, and a bare timer could elapse before the scan has created any watch. Config read before
that gate opens is staged into `#config`, re-read once the gate opens — a write that landed while
the watch was unarmed produced no event, so nothing else would ever deliver it — and then handed to
`ready` itself rather than to a `change` that would precede it.

`OptionsWatcher` shares the gate (`ArmGate`, `config/watcherArming.ts`) because it has the same
unarmed window and, for the root config, many more of them: `componentLoader` gives every
`TRUSTED_RESOURCE_PLUGINS` entry its own root-config `OptionsWatcher`, and those read synchronously.
It shares the arming **re-read**, which is what recovers the otherwise-undeliverable write, but not
the barrier: its `ready` still goes out on the first read, so it means "the config has been read",
not "armed". The difference is only ordering, because unlike `harper_logger` its consumer (`Scope`)
attaches `change`/`remove`/`ready` listeners in its constructor, before any read — so a write made
in the unarmed window reaches the scope as a post-`ready` `change` (and, for a plugin that doesn't
handle its own options, a restart) rather than being lost. Holding `OptionsWatcher.ready` behind
arming as well would need every terminal outcome to open a second barrier, per scope, with a boot
hang as the failure mode; the ordering is not worth that.

Whether a scope is configured is tracked separately from its value, because neither truthiness nor
`!== undefined` can answer it: `myPlugin:` with no body is a configured scope whose value is `null`,
and a boot that found no config of its own holds `DEFAULT_CONFIG[name]` — a value the watcher gave
itself. Reading either as "the file supplied this" costs a restart: for the six scopes
`DEFAULT_CONFIG` names, the next read of an unchanged file looks like the block being deleted, and
filling in an empty block looks like the unconfigured → configured transition `Scope` answers by
restarting rather than the `change` it is.

What the arming re-read must _not_ do is report a deletion. Its job is the write no event carried;
a file that is gone is chokidar's `unlink` to report, and answering the re-read's `ENOENT` with
`remove` announces it ahead of the event that would confirm it — where there is a grace, ahead of
chokidar having finished tearing the watch down, so a config recreated on the strength of that
early `remove` lands in a window where its `add` is not observed at all and the scope keeps the
defaults with nothing further coming. Settling a barrier that has nothing applied yet is still the
arming re-read's job: an absent file at boot is the install window, not a deletion.

### Every terminal read outcome settles the barrier

Both barriers — `RootConfigWatcher.ready` and, through `Scope`, `OptionsWatcher.ready` — are
awaited with no timeout, so a read that ends without a config must still settle them or the worker
hangs at boot rather than failing. Every terminal outcome therefore boots on defaults and logs what
failed: a read the ladder could not complete, a file still empty when the ladder is spent, and a
file that will not parse. Only a config that parses is a config; the alternative, failing the boot
closed on an unreadable file, is a different policy than the one `OptionsWatcher` already applies to
its ENOENT and read-failure paths, and the two watchers must not disagree about it. A file that
becomes readable later still arrives, as a `change`.

A missing file is not one of those outcomes to wait on: `ENOENT` is not a sharing violation, so
neither watcher takes the retry ladder for it. `OptionsWatcher` has always settled it at once as
the install window, and `RootConfigWatcher` does the same rather than spending the whole read
budget inside `harper_logger.start()` on every boot that has no config file — an env-var-only
deployment, or a rootPath mounted empty. Neither is a deletion an outcome to wait on. `OptionsWatcher.#handleUnlink` cancels the ladder —
the deletion settles what a pending read was retrying — so when that read had not produced a config
yet, the ladder it cancels was the only thing left to settle `ready`. Before the first `ready` there
is also nothing to remove and nothing to hear it: `Scope` is still inside `await scope.ready`, so a
`remove` there asks for a restart of a component that never booted. A deletion in the boot window
therefore settles the barrier on the defaults, exactly as the ENOENT read path does; only a deletion
after `ready` reports `remove`. A watcher error is terminal for the barrier too, and
settling it is what removes the `error` listener `once(this, 'ready')` attached — so reporting the
failure afterwards has to check for a listener rather than assume one, or an unlistened `error`
throws out of chokidar's dispatch and takes the worker down over a fault it just decided to survive.

An env-compose failure rides that settle rather than preceding it: `#envComposeError` is reported
only after the barrier has settled, because an `error` emitted first rejects `once(this, 'ready')`
instead of settling it. It is set and reported inside one synchronous call chain, the arming path
included: that path defers an absence check rather than reporting a removal, and it drops the
failure before deferring rather than reporting it there. Reporting would duplicate — every
resolution of the deferral recomposes and reports the env state it finds — and holding it would
carry a failure that may no longer be true onto whatever event reports next. So the early returns
taken when the env-only overlay _succeeded_ cannot be carrying one, and hoisting the report ahead of
them for symmetry would put it back before the settle on the paths this ordering exists for.

What a scope does about a config that arrives late is the other half of settling early.
`OptionsWatcher.ready` is not once-per-watcher: it fires whenever a scope goes from having no
config of its own to having one, which is both the recreated-config-file path and a scope that
booted while the file was unreadable. Nothing downstream re-runs on it — `componentLoader` is long
past its `await scope.ready` — so `Scope` answers a repeat `ready` the same way it answers `remove`,
by requesting a restart. Without that, one worker keeps serving the defaults while every worker
that read the file cleanly serves the operator's config.

Arming is a terminal outcome of its own: chokidar reports a scan that found no file by emitting
`ready` and nothing else, so `RootConfigWatcher` always re-reads when the gate opens rather than
publishing what an earlier read staged — a missing config file takes the ladder and settles on the
defaults instead of holding the barrier open. That fallback must also discard the staged value:
the arming re-read is authoritative precisely because a write in the unarmed window may have
superseded it, including by replacing the file with an unusable or missing one. A watcher scan error
also settles the barrier, but preserves a successfully staged value because no read superseded it.
`close()` settles the barrier as well.

What settles the barrier is not the same as what the settled value may be _used_ as. A read that
carried no config settles it carrying nothing — not `{}`, which is a configuration that a consumer
cannot tell apart from one the file really held, and `updateLogger` reads an absent `rotation` as
rotation off and an absent `console` as console off. `updateLogSettings()` therefore keeps what
`initLogSettings()` established until a real config arrives, rather than silently turning logging
off on the very boot that could not read its configuration.

## Config is composed and memoized before any component runs (`config/configUtils.ts`)

`getConfigObj()` composes the config once per thread (module-level memo) at its first call, which
happens before the root component loads and long before any user component's plugins run. Anything a
component does at load time — like `loadEnv` writing `process.env` — therefore cannot affect the
composed config (#1513). By design this stays true: configuration is strictly top-down, so the three
config-shaping env vars (`HARPER_DEFAULT_CONFIG`/`HARPER_CONFIG`/`HARPER_SET_CONFIG`) are **never
honored** from a component `.env`. What #1513 fixed is the silence: `config/componentEnvPrepass.ts`
scans `componentsRoot` + `RUN_HDB_APP` for `loadEnv` declarations during `initConfig` and emits an
actionable warning per config-shaping var found, and `resources/loadEnv.ts` warns again at
component-load time (covering post-boot deploys) and **skips the `process.env` assignment** for the
trio — enforce-at-injection, so anything downstream that (re)composes from `process.env`
(#1618/#1726) can rely on the trio arriving only via sanctioned channels. The pre-pass deliberately
mirrors loader behaviors that must stay in sync if the loader changes: config filename precedence
(`harper-config.yaml` → `harperdb-config.yaml` → `config.yaml`) and `files` pattern validation
(`..` and absolute patterns rejected). Known limitation: a `componentsRoot` override that itself
arrives via env var cannot redirect the scan.

## Boot-path config persistence is best-effort, and its two artifacts commit as a unit (`config/configUtils.ts`, `config/harperConfigEnvVars.ts`)

Every boot with a `HARPER_*_CONFIG` env var set re-derives the merged config and, historically, wrote
it back unconditionally. On a full or quota-exhausted volume that write is refused and, being fatal,
turned a full disk into a container restart loop nothing inside the container could break — the
cleanup that frees space needs a started process (#847). Two rules follow.

**Derived boot writes are best-effort; user-requested ones are not.** `persistConfigDuringBoot()`
swallows exactly ENOSPC/EDQUOT (matching on `errno` as well as `code`, because Linux has no libuv
mapping for EDQUOT and reports `Unknown system error -122`) and lets the boot proceed on the
in-memory config. `updateConfig`/`set_configuration`, `addConfig`, `deleteConfigFromFile` and the
install path keep persist-or-throw: a caller who asked to persist must not get a silent success, and
an install has no last-known-good config to fall back on.

**The env-config state and the config file must never disagree.** The state file records the
_pre-env_ values, so it is the only copy of what the operator's config said before an env layer
overwrote it — the config file itself holds the env-derived value. Both single-file orderings lose
something: writing the state last means the file it would read originals from is already
overwritten; writing it first leaves a state ahead of the file, which the next boot's
`detectConfigDrift` reads as a manual user edit and _permanently_ reassigns those paths to `user`,
silently disabling the env layer even after space is freed. So the commit is three steps —
`saveState()` stages the new state in `.harper-config-state.pending.<pid>.json`, the config file is
written, and `confirmConfigWritten()` **renames** the sidecar over the confirmed record. A rename
needs no free space, which is the point: no write an exhausted volume can refuse ever stands between
the confirmed originals and disk. A refused staging write leaves the config file alone; a refused
config write unlinks the sidecar; a sidecar found at load means a commit was interrupted, so it is
cleared and drift detection is skipped for that boot rather than mistaking the in-flight write for
an edit. A boot that re-derives the same state writes nothing at all.

Two details the name and the caller carry. The sidecar is **per-process**: every CLI invocation runs
`initConfig`, and one shared name would let a starting server clear a running process's in-flight
commit — the loser would then rewrite the config file with the confirmed state still describing the
old values, which is the failure the protocol exists to prevent. Recovery therefore only clears a
sidecar whose owning pid is gone. And only the **main thread** persists or runs recovery: workers
derive the same merged config and would otherwise race over one pair of files for a result they
already agree on — and since a worker shares its process's pid, a recovery scan from one would
delete the main thread's in-flight sidecar as if it were the last boot's wreckage.

A sidecar owned by a _live_ foreign process is not cleared — that process is mid-commit — but its
presence still turns drift detection off for this boot: a pair someone else is halfway through is no
more comparable than one an interruption left behind. That suspension is why a sidecar also ages
out regardless of what its pid says: without it, a sidecar whose owner was killed and whose pid was
later recycled would look mid-commit forever and suspend drift detection on every boot. The age-out
is deliberately far longer than a commit could take — recovery from a recycled pid only has to be
eventual, while deleting a slow-but-live writer's sidecar is the worse error, stranding its config
file against an unpromoted state.

Drift detection is main-thread-only for the same reason recovery is. A worker never owns the state:
in the normal sequence the main thread has already classified and persisted before any worker runs,
and inside the main thread's commit window a file that differs from the snapshot is as likely to be
the write in flight as an operator edit. A worker that concluded "user edit" would drop the
env-supplied value for itself alone and serve different config than its siblings.

Known limit: the pair commits as a unit _within a process_. Two live processes (a server boot and a
CLI invocation) can still interleave their config-file writes and promotions, and nothing in the repo
serializes config writes across processes. Pre-existing — both artifacts were unordered before this
protocol — and out of scope here, but the "commits as a unit" guarantee stops at the process
boundary.

Related: a log write must not be fatal either. `fs.appendFileSync` in `logQueuedData` throws from
both inline and timer call sites, so on a full volume every log statement was a crash point. The
fallback goes through `nativeStdWrite`, never `console` — `installStdioGuard` routes console output
back into this same file logger when `logging.file` and `logging.console` are both on, so a console
fallback recurses until the stack blows.

## Env-config empty objects mean three different things (`config/harperConfigEnvVars.ts`)

An `{}` in the config system is context-dependent, and conflating the contexts is the root of #2067. In an **env layer** (`HARPER_SET_CONFIG` et al.), an empty object contributes no leaves — `http: {}` means "no overrides under http" (load-bearing removal semantics in `flattenObject`). In the **base config file**, a bare `componentName: {}` is user content — a real empty scope declaration that composition must preserve (`restoreBaseEmptyObjects`, #1618/#1726). An `{}` that is _neither_ — the residue of removing an env-sourced entry leaf-by-leaf — is invalid config that validation may reject forever, because the file is written before validation runs and the residue then reads as user content on every later boot.

Removal therefore prunes: `deleteNestedValue` removes ancestors the deletion emptied, only when it actually deleted an existing leaf, and reports what it pruned. The overlap case — a file-declared empty scope an env layer temporarily populated — is tracked in the state file's `emptyScopeOriginals` (separate from `originalValues` so a marker can never mask or be consumed as a real leaf original at the same path; older state files lacking the field are defaulted). Restore consumes a marker only for a path the prune actually removed, so a scalar overwrite or an absent-leaf no-op can never resurrect a scope over live env-layer content. Note there are two coexisting mechanisms for "file `{}` is user content": `restoreBaseEmptyObjects` on the stateless compose path and the marker pair on the stateful removal path — if you touch one, check the other.

Two durable limitations of the marker mechanism, both with user config-file content as the blast radius: markers can only be recorded at populate time, so a scope an env layer populated _before_ `emptyScopeOriginals` existed (any pre-upgrade boot) has no marker and prunes away on its first post-upgrade vacate; and a corrupt config-state file resets to fresh state — dropping `originalValues` and `emptyScopeOriginals` for every tracked path — after which the next removal prunes those scopes for good; `saveConfigState` writes via temp+rename precisely so a torn write cannot be the trigger, leaving genuine corruption (disk faults, hand edits) as the remaining path.
