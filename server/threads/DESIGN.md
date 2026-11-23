## A per-thread UDS mirror is bound at a temp name and renamed over its published path (`server/threads/threadServer.ts`)

libuv unlinks a pipe server's bound path when the handle closes (`uv__pipe_close` → `unlink`), with
no check of who owns the path now. On Linux `restartWorkers()` pre-starts the replacement worker
while the outgoing one still runs (#1417), and both publish the same `<worker>-<port>.sock`. Bound
directly at that path, the replacement rebinds it and the outgoing worker's `closeServers()` then
deletes the replacement's socket — Harper's own `cleanupUdsFiles()` is inode-ownership-aware
(#2035) and skips it, but libuv's unlink ran after that and removed every mirror on every rolling
restart (#2961). So `listenOnDomainSocket()` binds a mirror (`server.isPerThreadSocket`) at
`.<threadId>.<seq>` in the sockets directory and `renameSync()`s it over the published path:
`rename()` keeps the listening inode, so the close-time unlink only ever targets a temp name that
no longer exists, and the published path is never absent between an unlink and a bind.

- `recordUdsBindSuccess(publishedPath)` runs after the rename, so the identity it records is the
  inode that is listening; `cleanupUdsFiles()`'s ownership guard is unchanged and is now the only
  thing that removes a mirror's published file. The regression and the shutdown sequence are
  covered by `unitTests/server/threads/threadServerListenOnPorts.test.js`; the real rolling restart
  by `integrationTests/server/uds-mirror-overlapping-restart.test.ts`.
- The temp name is unique per process (`threadId` never repeats; `seq` is per thread); both it and
  the published path are checked with `isDomainSocketPathTooLong`, and an overlong one takes the
  existing fail-soft branch rather than falling back to a direct bind; it never matches a proxy's
  `*-<port>.yaml`/`.sock` discovery; a leftover from a crash is swept by `cleanupSocketsDirectory()`
  before any worker binds.
- The operations API's primary domain socket keeps the direct bind on purpose: `bin/cliOperations.ts`
  reads that file's presence as "Harper is running", so its unlink on close is load-bearing.
- The uWS mirror (`HARPER_UWS_UDS`) keeps its direct bind: measured on uWebSockets.js 20.68.0,
  `app.close()` never unlinks a `listen_unix` path, so it is not exposed. Bun restarts are
  non-overlapping, so the Bun mirror is not exposed either.
- A mirror's `.yaml` is published only by the worker whose bind is the socket on disk.
  `restartWorkers()` never pre-starts an isolated application's worker, so on a certified (rolling
  or full-restart) redeploy its replacement is held: it loads beside its predecessor and binds only
  after that predecessor has exited. A yaml written while it loaded was deleted by the predecessor's
  `cleanupUdsFiles()`, which still saw its own socket, leaving a socket no proxy routes
  (harper#4436). `publishUdsMetadata()` therefore waits for `recordUdsBindSuccess()` and checks
  ownership before every write, so `cleanupUdsFiles()`'s socket check also covers the yaml. The
  check and each write or unlink are separate syscalls, so two workers acting in the same instant
  can still cross; the crash sweeps (`cleanupSocketsDirectory()`, main's
  `cleanupApplicationSockets()` once an application has no slot) remove files their writer cannot.
  Covered by the redeploy suite in `integrationTests/components/isolated-application-lifecycle.test.ts`
  and the `publishUdsMetadata` cases in `unitTests/server/udsMirror.test.js`.

## A worker that misses an ITC ack gets its OS thread state logged (`server/threads/manageThreads.ts`)

`broadcastWithAcknowledgement` already times out (30 s) on a worker whose port stays open but never acks, and that shape is almost always a blocked event loop — a native lock, a runaway synchronous call — which nothing inside the worker can report (harper-pro#788: a restarted node's single http worker went byte-silent while main kept serving `cluster_status`, and the app log only said "not acknowledged by worker thread(s) 2"). So each worker posts its Linux thread id (`readlink /proc/thread-self`) to main once at startup, before anything else runs on it, and the timeout branch reads that thread's kernel state from `/proc/self/task/<tid>`: state, `wchan`, the syscall number (the first token only — the rest of that file is argument registers and stack/instruction pointers), CPU ticks, and context-switch counts, plus two cross-platform signals main already has, `worker.performance.eventLoopUtilization()` and the age of the last 1 s resource report. It samples again a second later and logs the deltas: no CPU ticks, no context switches and `event loop active +1000ms` is "parked on a lock"; ticks climbing with state `R` is "spinning". It is deliberately main-thread-only and best-effort: `workers` and the tid live on the main thread's `Worker` objects, every `/proc` field is reported individually (a hardened container may deny `wchan`/`syscall` while `stat` stays readable), a follow-up sample whose `starttime` differs from the first is discarded (the tid may have been recycled), one diagnostic runs per worker with a 30 s cooldown so concurrent timeouts on the same worker don't multiply reads, and nothing here runs when acks arrive on time. It does not name the lock owner; that still needs a native stack from the next occurrence.

That diagnostic is reactive — it only fires once something else (an ITC ack) has already timed out. `sampleWorkerELU`, run from the same 1 s monitoring tick that already computes `recentELU`, is the proactive counterpart: it warns as soon as a worker's `eventLoopUtilization()` stays `>= 0.99` for `PINNED_ELU_SUSTAINED_TICKS` (30) consecutive ticks, and warns once more on recovery. State (`pinnedELUTicks`, `pinnedELUWarned`) lives on the `Worker` object, so a replaced worker starts a clean streak, and a single tick below threshold resets it — no partial credit across a dip. The very first sample after a worker (re)starts is skipped: `worker.performance.eventLoopUtilization()` called with no prior baseline returns the worker's whole-lifetime total, not a 1 s delta, so counting it could misattribute pre-tick startup work as a pinned tick. That baseline check requires a nonzero `idle` or `active` on the prior sample, not just a prior sample existing: before a worker's loop is online, `eventLoopUtilization()` returns a truthy-but-empty `{ idle: 0, active: 0 }`, and treating that as a real baseline would let the following tick's delta span the same whole-lifetime window. Bun has no `eventLoopUtilization()` and reports a placeholder `{ utilization: 0 }` instead (see `sampleWorkerELU`'s Bun branch), so this warning is Node-only. A worker tearing down can briefly report `idle < 0`, putting `utilization` outside `[0, 1]`; that tick is treated as unmeasured — neither counted nor a streak reset — rather than logging an absurd percentage or ending an episode early. Both log lines name the worker by thread id plus `name`/`application` (e.g. a job or isolated-application worker), since a legitimately saturated worker looks identical to a wedged one from ELU alone; this warns on saturation regardless of cause; distinguishing "busy" from "stuck" is left to the operator.

## A worker's `parentPort` close is not the main thread's exit (`server/threads/manageThreads.ts`)

`REMOVE_PORT {threadId}` and the `onThreadExit` listeners (database-drop owner release, deploy lifecycle, registered operations, log rotation) act on a thread's death. A sibling port's `close` is taken as the far thread's exit. A worker's `parentPort` carries `threadId = 0` so lookups can route to main, but its `close` means this worker is leaving: main's exit ends the process. `addPort`'s close listener therefore passes no dead thread id for `parentPort`. Announcing one would make every sibling fail its pending acks to main, drop its own `parentPort`, and fire exit listeners for main. Regression cover: `unitTests/server/threads/stuckWorkerDiagnostics.test.js`, "does not report the main thread as exited to a sibling of a worker that closes its parentPort".

## `manageThreads` has two different `workerCount`s (`server/threads/manageThreads.ts`)

The module-global `let workerCount` and the per-worker `workerData.workerCount` share a name and
nothing else. `getWorkerCount()` (and therefore the `server.workerCount` a component reads) resolves
only `workerData.workerCount`, frozen at spawn — it never reads the global; on the main thread it
answers `isMainWorker ? 1 : undefined`. The global's one and only reader is `restartWorkers`' default
`maxWorkersDown = Math.max(Math.floor(workerCount / 8), 1)`, so it is the _serving topology_ the
rolling-restart throttle is sized from, nothing more.

That makes the global writable only by a start that declares the topology. It used to be assigned
unconditionally from `options.threadCount` inside the `workerData` literal, so every job worker — which
passes no `threadCount` — set it to `undefined`, and the next rolling restart computed `NaN` (harper#2491).
`NaN` defeats the guard below it (`NaN < 1` is false) _and_ every throttle comparison, so the restart
took the whole pool down at once. A string does the same thing for the same reason. So the fix is the conditional write plus a consumer guard that clamps anything not a usable number. `Infinity` is exempt: it is the deliberate "all at once" sentinel `shutdownWorkers` passes, and `shutdownWorkersNow` depends on it to mark every worker synchronously before the first await. A literal `0` is also left alone, because it reads as a ratio rather than as garbage — it still reaches the ratio branch and stops the restart after one worker (harper#2601).

`workerData.workerCount` must stay exactly what it is for each start, `undefined` for job workers
included: an earlier attempt to give job workers the serving count instead broke the Windows
integration shard with ECONNREFUSED across the job tests. A job worker that believes it is part of the
pool behaves differently.

## Dedicated worker pools own their listeners and load no applications (`server/threads/workerPools.ts`)

A dedicated pool (today only `replication`, sized by `replication.threads` in `server/threads/socketRouter.ts`) is a set of workers of a type other than `http`, started by `startHTTPThreads` with indices past the HTTP pool, so worker 0 and last-worker duties never land on one. The invariants:

- **Default sizing and port admission.** An unset `replication.threads` (`undefined`, `null`, or `''`) defaults via `replicationThreadCount(n)` to `Math.floor(n / 2)` for `n >= 2` and `0` for `n < 2`, where `n` is the HTTP worker count after `DEV_MODE` and the `win32` single-worker clamp (`effectiveHttpThreadCount`); an explicit non-negative integer is honored as-is. The pool needs a dedicated `replication.port` or `replication.securePort` not shared with `http` or `operationsApi.network`: an explicit size with a missing or shared port throws in `admittedWorkerPools`, a defaulted one logs a warning and falls back to `0`. With `threads.count: 0` there is no pool (an explicit `replication.threads > 0` is logged and ignored).
- **A defaulted pool waits on the first HTTP worker's load (harper-pro#1197).** A defaulted size above 0 starts _pending_: main counts it active, so placement defers to it, while HTTP workers (`workerData.pendingWorkerPools`) treat it as not yet active, so registration-time choices (a UDS mirror) assume they bind the port, and none binds before the decision. The first admitted shared (non-isolated) HTTP worker's load report decides (`decideWorkerPools`), since shared workers load the same applications: any `poolUnsupportedTables` entry declines the pool with one warning, and `startHTTPThreads` starts pool slots only after. A table first registered by a deferred component load or later deploy is warned, not re-decided. An explicit size never pends.
- **No application code.** `shouldLoadApplicationHere` returns false on a pool worker; trusted built-ins (including `HARPER_BUILTIN_COMPONENTS`) still load, and databases open from storage. Per-thread application installs are absent there, so `Table.setResidency`, `Table.setResidencyById` and a resolver for an indexed `setComputedAttribute` are deprecated as of 5.4: registering one warns once per table per thread, pool or not. A pool worker throws rather than index `undefined` for a computed index it cannot resolve; `Table.unresolvedComputedIndexes()` names them.
- **Exclusive listeners.** A component passes `threadType` in its `server.http`/`server.ws`/`server.socket` options to claim a port (and its UDS mirrors); `listenOnPorts` then binds it only on that pool's workers, and a pool worker binds nothing else. Without `SO_REUSEPORT` only pool member 0 binds, retrying `EADDRINUSE` for up to a minute while its restarted predecessor drains; a pool worker then fails startup rather than reporting ready with no listener, so a longer drain costs auto-restarts until the port frees.
- **Active means admitted, not live.** `activeWorkerPools()` is fixed at startup (once a pending pool is decided) and passed to every worker in `workerData.workerPools`, so a restarting pool's port never goes back to HTTP workers. Changing the pool size needs a full restart.
- **Restarts.** Deploys and drops restart `http` workers only; `restart_service` with no `scope` restarts `http` and `replication` together (`bin/restart.ts`). Pool restarts overlap like HTTP ones.

## On a pointer-compression Node, no standard-V8-ABI addon is dlopen'ed (`server/threads/nativeAddonGuard.ts`, `utility/nativeAddonAbi.ts`)

V8 pointer compression changes V8's C++ ABI but not `NODE_MODULE_VERSION`. So an addon that links
V8's C++ API (NAN or direct `v8::`) built for the standard ABI passes Node's own check, loads, and
SIGSEGVs the process on first use. Node-API addons are unaffected. On a runtime with
`process.config.variables.v8_enable_pointer_compression === 1`, `process.dlopen` (the call behind
CJS `require`, `createRequire` and ESM addon import alike) is wrapped in every thread, and a `.node`
loads only when one of these holds:

1. its `.dynsym` has no undefined `_ZN2v8…`/`_ZNK2v8…` symbols (JS ELF64 reader, no binutils);
2. its package directory has `.pointer-compression-build`. Producers (the harper-pro pc image) must
   only mark a package whose every loadable binary they replaced;
3. it sits under a `build/` whose `config.gypi` records `"v8_enable_pointer_compression": 1`, and is
   strictly newer than that file. node-gyp writes `config.gypi` at configure, before compiling, so a
   failed compile next to a shipped binary must not admit it.

Every other ELF64 is refused with `IncompatibleNativeAddonError`, including one whose symbols cannot
be read. The reader trusts the section headers: this guards against accidental crashes, not against a
binary crafted so that its section headers disagree with its dynamic segment. The error carries `code: 'ERR_DLOPEN_FAILED'`, so fallback-to-JS code treats it like any
unloadable addon: cbor-x and msgpackr do that off-image, where `node-gyp-build-optional-packages`
picks an `abi137` V8-API prebuild before the Node-API one. A file that is not ELF64 and has no marker or build evidence is
admitted, because a 64-bit Linux `dlopen` rejects it itself; pc images are Linux-only. Only admissions are cached, keyed by realpath and
validated against the binary's dev/ino/size/mtime. Refusals re-check, so rebuilding or adding a
marker takes effect on retry.

The guard installs when its module loads, and must be the first module of each thread:

- **Main thread:** the first import of `bin/harper.ts`, `index.ts` and
  `launchServiceScripts/launchHarperDB.js`. `harper_logger.ts` calls `initLogSettings()` at module
  scope, which loads `segfault-handler` (a V8-API addon) on the main thread, so installing from
  `manageThreads.ts` would be too late.
- **Workers:** the first `--require` in `startWorker`'s `execArgv`. Argv `--require`s run in order
  and before every `--import`, so the guard precedes `threads.preload`/`threads.preloadRequire`, and
  safe mode keeps it.

For the same reason, `nativeAddonAbi.ts` imports only Node builtins; the guard also uses the builtin-only `packageUtils.js` runtime-path helper. Out of scope:
`NODE_OPTIONS` preloads. They run in the main thread before Harper's entry module, where no Harper
code can precede them. `createUwsServer` checks the uWS binary itself, because `uws.js` rethrows
any load error as a misleading "supports only Node.js versions" message.

## `threads.v8Flags` is applied once, before the first Harper worker (`server/threads/v8Flags.ts`)

V8 reads most flags when an isolate is created, so `applyConfiguredV8Flags()` runs on the main thread before the first `new Worker`. `startWorker()` holds the only production `new Worker`, and calls it first; `startHTTPThreads()` calls it after explicit full-text query policy validation, so a bad value fails startup before components load and listeners bind, including under `threads.count: 0`, where the first worker may be a job started long after the server is serving.

It is not applied at `manageThreads.ts` module load, as `threads.heapSnapshotNearLimit` is: `bin/run.ts` imports that module before `initialize()` runs the install that first composes `HARPER_SET_CONFIG` into the config file, and before it writes the `THREADS_V8FLAGS` env/CLI form. A module-load read misses the value on a fresh container's first boot. `unitTests/server/threads/v8Flags.test.js` assigns the setting after the module loads, so a move to module load fails it.

The first successful call latches, including on an unset value: V8 flags cannot be unset, so a rolling worker restart keeps the process's flags, and a changed value takes effect when `restart` relaunches the process. Every entry is validated before any is applied, so a refused list leaves V8 untouched.

An entry that is not a flag fails startup, by design, unlike `threads.maxHeapMemory`, which recovers an unstartable value at the point of use (harper-pro#558). What #558 guards against is a value that one replicated `set_configuration` writes to every peer, so the next rolling restart stops the whole cluster. Here the Joi pattern (`validation/configValidator.ts`) refuses an entry that is not a flag before the write lands, because `updateConfigValue` validates before writing. So a non-flag entry can only come from an operator at boot (file edit, env var, `HARPER_SET_CONFIG`), and it stops the node with an error naming `threads.v8Flags`. The pattern checks only the prefix. A prefix-valid set that aborts V8 (for example `--abort-on-contradictory-flags` with a contradicting pair) can still be replicated, and each node then aborts natively at its next process start; that is the accepted cost of an unrestricted expert setting. Joi also runs at boot, so it usually rejects the value before `applyConfiguredV8Flags` does. The point-of-use check covers values that bypass Joi.

`v8.setFlagsFromString` does not apply a flag's implications as the CLI does. `--optimize-for-size` from the CLI caps the semi-space at 1 MB; applied at runtime it does not. A worker with Harper's 1 GB limits reports a 536 MB heap limit with runtime `--optimize-for-size`, and 515 MB with that from the CLI or with `--max-semi-space-size=1` added at runtime (Node 26.2.0). Implied flags must be listed explicitly. A contradictory set (e.g. with `--abort-on-contradictory-flags`) aborts the process natively, beyond a JavaScript catch; applying after query-policy validation in `startHTTPThreads` places that abort before Harper serves.

## Server starts enable Node's compile cache before their first worker (`server/threads/compileCache.ts`)

`enableCompileCache()` runs right after config init on every path that starts a server process: a foreground start and `harper start`'s parent (`bin/harper.ts`, before `bin/run.ts` loads, while 938 of the main thread's ~1,630 modules are still to compile), a CLI `harper restart` (`bin/restart.ts`), and the operations-only launcher (`launchServiceScripts/startHarperDB.ts`, which can start job workers). The last two run it after their own static imports have compiled; moving it earlier would mean importing their server modules after `initSync()`. `main()` calls it again after `initialize()`, which covers a fresh install (no rootPath until the installer runs) and entries that call `main()` directly (harper-pro's clone path). When `initialize()` moved rootPath (a command-line or env override), that second call moves the workers to the final root; Node cannot move the main thread's cache once enabled, so that one start's main thread writes to the old root, and the override is in the config file from the next start on. It is never enabled at module load or in `initSync()`: `threadServer.ts` imports `run.ts`, and non-server CLI processes call `initSync()`, so a CLI run by another uid would create `<rootPath>/cache/compile` as that uid.

Node does not hand an enabled cache to workers; only `NODE_COMPILE_CACHE` in a worker's env does. `startWorker()` sets `env` after `...options`, merging the directory under the caller's env (job workers pass their own). The main thread's `process.env` stays unset, so its spawns, an operations-API deploy's `npm install` included, do not inherit it; processes spawned from a worker (application code, a deploy replicated to this node) do. An operator's `NODE_COMPILE_CACHE` wins even when Node could not use it.

Pruning keeps every subdirectory for the running Node version and arch: Node names them by V8's `cachedDataVersionTag`, which folds in V8 flags, and `threads.v8Flags` applies after main enables the cache but before workers start, so main and workers can use two same-version subdirectories. Inside those it removes only Node's persist temp files (`<entry>.XXXXXX`) older than 10 minutes: an exiting process (a CLI restart overlapping the old one, old workers in a rolling restart) may still be renaming a younger one into place. A non-directory at this thread's subdirectory name gets a warning and is left alone; Node reports ENABLED for any existing path and then fails every write, so workers are not handed it.

The default is on only from the Node release, per line, listed in `server/threads/compileCacheNodeReleases.ts`. Before that release Node keeps every entry it read until the thread exits, about 7 MiB of RSS per thread; the table stays empty until a release frees accepted entries. `unitTests/server/threads/compileCache.test.js` and `integrationTests/server/compile-cache.test.ts` pin this.
