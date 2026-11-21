# server/ — Navigation Guide

This layer routes HTTP, HTTPS, WebSocket, MQTT and NATS traffic to Resources.

**Read this when:** changing protocol handling, middleware, requests, responses or WebSocket upgrades.

Use the symbol and section names below to navigate; line numbers drift. Notes owned by `threads/` and `serverHelpers/` are in [threads/DESIGN.md](threads/DESIGN.md) and [serverHelpers/DESIGN.md](serverHelpers/DESIGN.md).

---

## Three HTTP stacks coexist — know which one

Native `http.ts`, the Fastify operations API (`operationsServer.ts`) and legacy custom functions (`fastifyRoutes.ts`); [AGENTS.md](../AGENTS.md) (Server) says what each serves.

A request entering `http.ts` does **not** go through Fastify unless no Harper handler answers it (status `-1` cascades to a registered Fastify instance). Of the two Fastify files only `fastifyRoutes.ts` has a `handleApplication(scope)`; `operationsServer.ts` is the `operationsApi` component, started once on the main thread through `startOnMainThread`. Its `preValidation` chain (`reqBodyValidationHandler`, then `authHandler`) needs each hook to signal completion exactly once: Fastify's hook runner does not make `done` single-use, and the async `onSend` hooks keep `reply.sent` false long enough for a second call to reach `authHandler`. `unitTests/server/serverHelpers/reqBodyValidationHandler.test.js` pins it.

---

## File overview

### Core dispatch

- `Server.ts` — Defines the `Server` interface — the contract that protocol plugins use to register listeners. Has `socket()`, `http()`, `ws()`, `upgrade()`, `contentTypes`, `getUser()`, `operation()`, `replication`, etc.
- `http.ts` — Native HTTP/WS server. Registration entry points (`onRequest`, `onUpgrade`, `onWebSocket`), per-port middleware chains, UDS support, PROXY protocol. **See section map below.**
- `middlewareChain.ts` — Topological sort respecting `before`/`after` constraints on listener registrations (`topoSort`). Falls back to registration order on cycle. Also `urlPath`/`host` sub-route dispatch: a mount is a prefix with a segment boundary, the mount prefix is stripped from `request.pathname` before the sub-chain runs, and the root mount `'/'` normalizes to _no_ path constraint (joins the default chain, nothing stripped — #1766).
- `REST.ts` — Resource-routed REST handler: URL → `Resource.getResource()` → method dispatch + content negotiation.
- `graphqlQuerying.ts` — GraphQL query/mutation/subscription execution against Resources.
- `mqtt.ts` — MQTT broker (connect/sub/pub mapped onto Resource interface).
- `DurableSubscriptionsSession.ts` — Persistent subscription state (resume across reconnects).

### Operations & Fastify

- `operationsServer.ts` — Boots Fastify for operations API. `buildServer()` constructs the server; `handler()` parses `{operation: ...}` and dispatches.
- `fastifyRoutes.ts` — Legacy custom functions. Discovers routes from each component's `routes/` folder.

### Helpers

- `serverHelpers/Request.ts` — Wraps `IncomingMessage` with Harper-specific fields (user, response, headers).
- `serverHelpers/Headers.ts` — Header mutation/merge utilities.
- `serverHelpers/contentTypes.ts` — (de)serialization registry; `serialize`, `serializeMessage`, `getMessageSerializer`, `getDeserializer`.
- `serverHelpers/sharedMessageEncoding.ts` — Per-message encoding shared across the subscribers of a topic — one serialization per (message, content type) and, for MQTT QoS 0, one PUBLISH packet per (payload, topic, protocol version). Keyed on the message object, which `transactionBroadcast` dispatches by identity to every subscription of a key. **Identity contract:** see below.
- `serverHelpers/serverUtilities.ts` — `OperationDefinition` and shared helpers.
- `serverHelpers/OperationFunctionObject.ts` — Wraps an operation handler with metadata.
- `serverHelpers/JSONStream.ts` — Streaming JSON output for large responses.
- `nodeName.ts` — Resolves this node's name (config → hostname).
- `static.ts` — Static file serving for component-bundled assets.
- `throttle.ts` — Event-loop backpressure: runs a caller's calls one per `setImmediate` cycle and hands a call to the caller's limit handler (HTTP request queues, cache-source resolution) once queue depth × average cycle time passes the limit.
- `storageReclamation.ts` — Disk-pressure signals to downstream consumers; `getStorageSpaceStats()` is the shared quota-aware (falls back to `statfs`) source of available/free/size storage numbers — used by `Table.getStorageStats()` (#1976). NOT used for blob storage path weighting (`resources/blob.ts`): quota-status.json is a single instance-wide figure, so it can't distinguish between multiple `STORAGE_BLOBPATHS` disks — that still needs raw per-path `statfs`.
- `serverRegistry.ts` — Trivial registry export.
- `status/` — `get_status`/`set_status`/`clear_status` over `system.hdb_status`, aggregated with flat component status, an opt-in component tree (`components: true`), and opt-in resolved middleware chains (`middleware: true`, #1573). Both status views render errors with the shared `serializeStatusError()` formatter; raw Error objects remain internal.

> **Subscription message identity.** [sharedMessageEncoding.ts](serverHelpers/sharedMessageEncoding.ts) shares bytes by envelope identity and version ([subscriptionValueIdentity.test.js](../unitTests/resources/subscriptionValueIdentity.test.js)). Internal sharing is sound because `transactionBroadcast` forwards one audit envelope, `auditStore.getValue` memoizes on the entry and `primaryStore.getEntry` guards versions.
>
> `DurableSubscriptionsSession` forwards the version to the delivery listener, which re-encodes on mismatch. Custom Resources may reuse an envelope only with a changed version; mutating it without advancing the version can serve stale bytes. Messages without a version are not shared. Custom serializers must be pure in their input (`ContentTypeHandler.serialize`, `Server.ts`).

> **Pass-through payloads are `Buffer | string`.** A message that carries its own `{ contentType, data }`
> is delivered as its `data`, but binary data leaves `serializeMessage` as a `Buffer`: on a worker other
> than the publisher's, the record is decoded from the transaction log and `data` is a plain `Uint8Array`,
> which mqtt-packet cannot encode. Pinned by `integrationTests/mqtt/opaque-payload-across-workers.test.ts`.
>
> **Only text or bytes make an envelope.** A table may declare attributes named `contentType` and `data`,
> so the shape alone proves nothing: `isPassThroughEnvelope` (`serverHelpers/contentTypes.ts`) requires a
> string `contentType` and string or ArrayBuffer-view `data`, and every other record goes through the
> negotiated serializer. Delivered raw, object or number `data` made mqtt-packet throw, and a durable
> session replayed the delivery on every reconnect. `isHttpPassThroughEnvelope` also accepts a `Blob`, streams
> and other async iterables, and generators, which the HTTP body writer sends and a record cannot hold; arrays
> and objects stay records. Pinned by `integrationTests/mqtt/passthrough-envelope-shape.test.ts`.

### Threads

- `threads/socketRouter.ts` — Starts the HTTP worker pool (`startHTTPThreads`), dedicated pools such as `replication` (`admittedWorkerPools`) and isolated applications' dedicated workers (`reconcileIsolatedWorkers`); workers bind their own ports, so no socket is routed.
- `threads/workerPools.ts` — Dedicated worker pools: which pools run, which worker type owns a listener (`claimListener`), and whether this thread binds it (`shouldBindListenerHere`).
- `threads/manageThreads.ts` — Thread pool lifecycle.
- `threads/threadServer.ts` — Worker entry point — loads components (`startServers`) and binds each registered server itself (`listenOnPorts`, `reusePort` where the OS has it).
- `threads/itc.ts` — Inter-thread comms primitives.
- `transactionLogCooling.ts` — Main-thread timer that cools transaction-log mmaps.

Process-wide shutdown begins by calling `beginProcessShutdown()` in `threads/manageThreads.ts`.
Once set, it blocks every worker replacement path and makes new `startWorker()`
calls fail with `ERR_HARPER_PROCESS_SHUTTING_DOWN`; scoped worker-type restarts do not set it on main. In an outgoing worker, any SHUTDOWN is terminal. HTTP startup checks the flag after each await and before binding or reporting ready. Its idempotent shutdown chain waits for component loading, drains, scope disposal and branch-database closure. Main startup and rolling reloads recheck it before starting replacements.
A signal runs `shutdownProcess()`: SHUTDOWN with `exitDeadline` reaches every live worker (`wasShutdown` precedes a restart's SHUTDOWN). Scopes close after servers drain, main disposes after workers exit, and `process.exit` runs once; the storage close stays unbounded (rocksdb-js#1001).
`shutdownWorkersNow()`: best-effort SHUTDOWN, then a forced exit.

A rolling restart serves the _old_ code until each worker is replaced, and where the OS grants
`SO_REUSEPORT` the not-yet-replaced workers keep accepting connections for the whole restart — so a
component deploy is not live pool-wide until `restartWorkers()` resolves. For the overlapping types
(HTTP) it waits for each replacement to report `CHILD_STARTED` — including the ones that can only be
started after their predecessor releases its exclusive ports (Windows/macOS/Bun) — and reports how
many workers it left on the old code because a replacement never came up, versus how many
replacements never started after their predecessor was already gone. Other thread types start their
replacement without being awaited. A per-worker startup backstop bounds each wait, so
resolution means "the restart finished", not "every worker is new". A caller that treats its own success as
"the component is live" must await it (see `deployComponent` in `components/operations.ts`).

A restart can hold its replacements, for release certification (components/DESIGN.md, "A restarting deploy is
certified by its canary worker"). A held worker runs its boot load, reports `CHILD_COMPONENT_VERDICT`, and binds
nothing until main posts `CHILD_ADMITTED` (`threadServer.startServers`, `threads/heldStart.ts`); a refusal arrives
as an ordinary `SHUTDOWN`. Since it binds nothing, it boots beside its predecessor even where the two cannot share
a port, and the predecessor is retired at admission. Restarts that start replacements are serialized on main
(`replacementRestarts`), none starts one while a release is armed (`untilNoCertificationArmed`), and the worker
asking for a certifying restart is replaced last.

Every HTTP worker's load report also lists the applications its loader placed on it (`applicationsPlacedOnThisThread`),
which main keeps as what that worker may hold until it exits, since nothing unloads an application; one that has not
reported may hold anything (`poolMayHold`). A restart named for one application replaces that application's
dedicated worker and, when a pool worker may hold it, the pool too, and reconciles only that application.

> HTTP worker startup requires `threadServer` to be the actual entry file. Imports from user/job workers do not start listeners; `index.ts` also sets `workerData.noServerStart = true` for unmanaged workers.
>
> `threadServer.listenOnDomainSocket()` skips a listener only when its path exceeds the platform's
> `sockaddr_un.sun_path` byte limit (some Node versions reject it; others silently truncate it).
> Every actual `listen()` error rejects startup, and the temporary bind-error listener is removed
> once the socket is listening.

### Where periodic maintenance runs (main thread vs last worker)

Single-instance background tasks pick their thread by what state they touch:

- **Last worker** (`ownsStoreMaintenance(storePath)` in `threads/manageThreads.ts`: the last pool worker for shared stores; a dedicated isolated-application worker maintains only its own branch stores) — for tasks that operate on **worker-resident JS state**: audit cleanup (`resources/auditStore.ts`), TTL scans (`resources/Table.ts`) and disk reclamation (`storageReclamation.ts`) walk per-store objects that only exist in a worker.
- **Main thread** (`isMainThread`) — for tasks that drive a **process-global native singleton** and need no JS state. `transactionLogCooling.ts` is the example: rocksdb-js's transaction-log registry is one C++ static shared across all worker threads, so any thread cools every log. The main thread is chosen because it is the only thread that lives for the whole process — a worker-driven timer would stall whenever that worker is recycled.

---

## Native and compiled runtime startup

The public `index.ts` import initializes configuration and synchronously discovers persisted databases before exposing the live table registry. Build children must set their root and read-only environment before importing it. Discovery uses `getDatabases()`; it does not run startup hooks, load application components, start workers or bind listeners. In particular, running all startup hooks here would try to create authentication tables in read-only build processes. `unitTests/resources/packageEntry.test.js` checks persisted reads and unchanged storage in both runtimes.

`threadServer.listenOnPorts()` owns one bind batch per thread. Bun caches its native/raw listener promise just as Node caches its listener batch; concurrent and later callers must share that work. Main-thread startup can call this boundary again after `startServers()` has already bound the listeners.

HTTP selects the installed `ws` server lazily on Bun, through `loadNativePackage('ws', 'index.js')`, instead of Bun's bare-specifier substitution. In Bun 1.4.2 the substitution retries a frame already accepted under native backpressure and miscounts buffered bytes; a paused/resumed subscriber receives duplicates. Node and uWS retain their backend selection. This also gives MQTT-over-WebSocket a real Node socket for its drain, closed-state and debug-address checks. Reconsider the substitution only when its exactly-once backpressure contract passes the regression, including secure connections.

REST WebSocket subscriptions await the underlying socket's drain signal. One resolver and drain handler per connection also settle on close and remove the drain listener. Middleware completing after close starts no subscription; a connect completing after close returns its eventual iterator. No per-message close listener is added. `integrationTests/server/typestrip.test.ts` checks exact-id delivery after a paused reader resumes, producer cleanup and a gated late connect.

The uWS WebSocket adapter translates native drain progress into a Node-style drain only when its buffer is empty and the socket remains open. It coalesces notifications with a callback reused per connection and `setImmediate`: empirically, a promise continuation that sends again within the WebSocket behavior's `drain` callback can leave the next accepted write buffered indefinitely; a microtask retains that failure. HTTP's `onWritable` has a different progress-return contract and is unchanged. Waiting for an empty buffer also prevents a resumed producer from exceeding uWS's native backpressure limit after partial progress. The real-socket regression in `unitTests/server/serverHelpers/uwsServer.test.js` and the source/compiled subscription integration test pause, resume and disconnect readers without replacing the transport. The unit suite skips without a compatible uWS binary and is excluded from the Windows gate.

HTTP startup separates worker-owned loading and verdict publication from main-owned admission. Shutdown waits for loading to settle and then runs the existing disposal chain; it never waits for CHILD_ADMITTED. The optional heldStart reporting callback closes the load barrier after the verdict is posted, while whenComponentsLoaded retains its post-admission timing. A rejected bind on a terminal worker follows cleanup instead of forcing an early exit. A restart skips a load that has not started and waits a bounded time for one that has (`closeScopeAfterLoad`).

Native TypeStrip execution loads the runtime as ESM; compiled distribution files remain CommonJS. Worker paths use `RUNTIME_SRC_ROOT` and `RUNTIME_FILE_EXT` from `utility/packageUtils.js`, which stays CommonJS to resolve its own directory in both modes. `threadMessageState.ts` and `processIncarnation.ts` hold dependency-free worker state: cyclic imports may register callbacks before `manageThreads.ts` evaluates, so that registration must remain synchronous and must not be overwritten by a later initializer. Configuration-dependent wiring and built-in plugin preloads run through `utility/lifecycle.ts` after configuration initialization, before worker listeners bind. Environment-selected built-in overrides survive those preloads. Conditional loggers retain one shared object that updates with the current main logger configuration, including after first-install initialization. HTTP workers hold their parent-port ref throughout startup hooks as well as component loading, so an unreferenced asynchronous completion cannot end startup early. The compiled and source routes are exercised by `integrationTests/server/typestrip.test.ts`; native unit probes run through ESM stdin, where no global `module` exists.

Transaction monitoring and token lifetimes can be imported before configuration is linked. Their startup hooks refresh cached settings, including re-arming the transaction monitor at the configured interval. Job workers also initialize configuration and run startup hooks before executing operations. Configured token lifetimes and builtin restrictions are covered by the two-mode REST test; `integrationTests/database/blob-commit-over-time.test.ts` proves the configured transaction monitor actually ticks in both modes.

Runtime paths use the canonical parent of the CommonJS helper; the adjacent `hdbTerms.ts` marks source execution. Embedded compiled core keeps its own `dist/core` paths while package metadata and the compiled product daemon entry retain the outer package root. Public relative `startWorker()` paths retain that root and their `.js` default; internal job callers pass complete absolute runtime filenames. `threadServer.ts` automatically starts HTTP only when its own file is the worker entry; loading it from a job or evaluated worker must remain an import. Evaluated workers have a pseudo entry name rather than a real file. These boundaries are pinned by `unitTests/server/threads/typestrip-runtime.test.mjs`.

Cold SQL dependencies retain synchronous first-use loading through `loadRuntimeModule()` in the intentional CommonJS `packageUtils.js` helper. Its own `__dirname` preserves the caller's path family under `--preserve-symlinks`, avoiding a second module instance. Cached call-site bindings avoid repeated resolution. Hoisting these loads pulls the legacy SQL math library into every worker's boot and exceeds the accepted 64 MB heap minimum. The legacy Fastify plugin uses the existing lazy trusted-plugin loader. Default tagged loggers follow the current main sink when an in-process install replaces it; explicit logger arguments retain their original receiver. Conditional tagged loggers read that receiver’s current level on each access. Authentication refreshes its component logger and arms its cache-reset interval during startup; serving entries must drain startup to bound that cache. Application lockdown/builtin policy, MQTT local authentication, operation forwarding timeouts and CSV download paths also refresh after first-install configuration becomes available. Inspector setup runs once: configured workers initialize at import to preserve module-body breakpoints; the main thread waits for startup after CLI/environment overrides, and unconfigured workers also defer. Both-mode heap, cold SQL/export, denial-log and main-thread first-install integration tests enforce these boundaries.

Startup drains callbacks in registration order, including callbacks appended by an initializer. A nested initializer runs after previously queued callbacks; failure rejects the cached startup promise and skips remaining initialization. `hasStarted()` attests only that initialization began. Hooks registered after success or failure run independently on the next microtask, preserving the late-import contract. Test resets detach the old queue so an in-flight generation cannot consume a new generation's callbacks. Entry points must initialize configuration and await `runStartup()` before handling requests; the legacy operations launcher follows the same order. Its existing `.js` entry delegates through `#src` to the TypeScript implementation, preserving both source and distribution paths without changing main's existing listener behavior. Managed source workers explicitly carry `--conditions=typestrip` even when the parent supplied it as a command-line flag rather than `NODE_OPTIONS`.

The twelve declared package globals are also runtime named exports from `index.ts` in source mode. Their owners assign each identity during graph evaluation and subsequently mutate the objects in place. The facade reads the default CommonJS export from `globals.js` after the graph loads: CommonJS synthetic ESM named exports capture early values and cannot supply these identities. Compiled CommonJS retains its existing extra export properties. The direct facade and real user-worker checks cover this boundary; the package's bare `harper` specifier continues to resolve to the compiled distribution.

## `http.ts` — symbol map

`npm run outline -- server/http.ts` lists every symbol; these entries say what it cannot.

- `registerUdsCleanupPaths`, `recordUdsBindSuccess`, `cleanupUdsFiles`, `markUdsBindFailed`, `writeUdsMetadata`, `cleanupSocketsDirectory`, `ensureSocketsDirectory` — UDS socket / metadata file lifecycle. The sockets directory is the access gate for these mirrors (they skip TLS and trust the PROXY v2 identity), so `ensureSocketsDirectory` forces it to `0700` at every creator (`http.ts`, `threadServer.ts` Bun and raw TLS) before any registration. A worker that cannot secure it skips its mirror; an isolated worker, reachable only through its mirror, fails startup instead of reporting ready. `writeUdsMetadata` publishes the yaml via `atomicWriteFile`, so readers never see a partial file. Ownership-aware: `recordUdsBindSuccess` captures the inode a worker's own bind confirmed; `cleanupUdsFiles`/`markUdsBindFailed` only unlink a path when the inode on disk still matches, so an overlapping restart's outgoing worker can never delete the replacement that already rebound the same path (see restartWorkers() in manageThreads.js). `cleanupSocketsDirectory` is the separate crash-path sweep, run once from `socketRouter.ts`'s `startHTTPThreads` on main-thread startup, before any worker can bind.
- `deliverSocket()` — Exported but called nowhere in core or harper-pro (`proxyRequest` is its only caller); workers bind their own ports.
- `proxyRequest()` — Exported but called nowhere in core or harper-pro.
- `getHTTPServer(port, secure, options)` — **The largest function in the file.** Creates/retrieves the underlying Node HTTP/HTTPS server. Wires `request`, `upgrade`, error handlers, TLS context, and the per-port middleware chain.
- `makeCallbackChain()` — Builds the per-port handler chain via `middlewareChain.topoSort`, and records its resolved order for `get_status`.
- `buildChains()` — Stores a built chain, and rebuilds every other already-built chain of that kind when the registration is on the `'all'` pseudo-port. See "Middleware ordering" below.
- `onWebSocket()` / `websocketListeners` (const) — Register WebSocket listener; auto-adds default upgrade handler the first time it runs for a port. Underlying list of registrations.
- `enableProxyProtocol()` — PROXY v1/v2 stripping on UDS mirrors (Node 24+-compatible workaround). Decoding lives in `serverHelpers/proxyProtocol.ts`; v2 TLVs forward the client source address plus the connection's TLS facts a fronting proxy (symphony) observed — ALPN, SNI authority, TLS version/cipher, JA3/JA4 fingerprints, and the mTLS client cert chain. These are surfaced on `request.connectionInfo` (see below); the verified cert chain is additionally exposed with TLSSocket semantics (`authorized`, `getPeerCertificate()`) so HTTP/MQTT mTLS auth works unchanged, and the SSL TLV lets `request.protocol` report `https` on the plaintext UDS mirror. A peer that stalls mid-header is destroyed after `prehandoffTimeout` (default 10s), matching `withProxyProtocol`'s guard on the raw-socket path.

### Middleware ordering (`before` / `after`)

Components register listeners with optional `before: 'name'` / `after: 'name'` options. `middlewareChain.topoSort` resolves order; cycles fall back to registration order with a warning. Three lists hold the registrations:

- `httpResponders` — request handlers
- `upgradeListeners` (in `http.ts`)
- `websocketListeners` (in `http.ts`)

The default WebSocket upgrade handler is registered automatically inside `onWebSocket()` the first time it runs for a given port.

**`port: 'all'` is a pseudo-port, and its chain is not the one that serves traffic.** Chain building
folds every `'all'` entry into each concrete port's chain, so `chains.all` exists but nothing
dispatches through it — `httpChain[port]`/`upgradeChains[port]`/`websocketChains[port]` are looked up
by the bound port on every request (Node, Bun, and uWS alike). A registration therefore has to
rebuild the chains it affects, not just its own key: `http.ts → buildChains()` rebuilds every
already-built chain of that kind whenever the registration is on `'all'`. Without that, an entry
registered on `'all'` after the concrete port's chain was built — the shape an application catch-all
mounted `after: 'rest'` takes, since `rest` registers first — updates only `chains.all` and never
reaches a request (#2418). Rebuilding is a pure function of the listener list and the port, so the
extra passes can only reproduce a port's order or extend it. `buildChains()` also writes the
`get_status` chain description in the same pass, which is what keeps that report from ever
describing an order a port isn't running (#1573).

### Application mounts (`host` / `urlPath` in the root config)

An operator mounts an application by putting `host`/`urlPath` on its entry in the **root** config; `components/scopeMount.ts` models it and the loader threads it into every `Scope` for that application (both load paths — the root-config `package` recursion and the components-root directory scan).

**The mount is applied at exactly one place: `Scope.routeFor()`, used by the `scope.server` proxy.** Do not push it anywhere else. In particular, do not compose it into the plugin config the entry pipeline reads: `entry.urlPath` is what `graphqlSchema` and `jsResource` derive **resource** paths from, and the router strips the mount _before_ REST resolves them. Composing it there registers a table at `/v1/Thing` while REST looks up `Thing`, and every mounted REST route 404s. A single-app `static` test will not catch it — static de-prefixes its own map keys, so it stays self-consistent either way.

Consequences worth knowing:

- Everything inside an application addresses itself **mount-relative**. Only two things need the absolute path: code that emits a URL back to the client (use `Scope.externalBasePath()` — static's redirect `Location`), and code that bypasses the routed chain (legacy fastify registers on the bare server, so its route prefix must be the full external path). `static.ts`'s mount-root redirect gates on the _external_ base path, not the plugin-local one — a root-level static plugin (`baseURLPath === '/'`) still needs the redirect when the application itself carries a mount, since the client-visible mount root is then `externalBaseURLPath`, not `/`.
- A plugin registering per-mount state must key it on `Scope.routeFor()`'s resolved route, not on the parts it composes from — distinct `(mount, pluginUrlPath)` pairs can flatten to the same string (`/a`+`bc` and `/ab`+`c`). `REST.ts`'s `startedMounts` does this; it replaced a process-global `started` flag that silently 404'd the second mounted application's REST API. `handleApplication` also closes over `resources`/`httpOptions` per call rather than a module-level var.
- A mount is routing, **not** isolation: exported resources stay instance-wide, and a `host` mount cannot constrain legacy fastify routes — `fastifyRoutes.ts` refuses to load (throws) rather than warn when a `host` mount is configured, since the fallback really is reachable on every host.
- Application **module** code is outside the mount, and nothing refuses it. `jsResource` imports a module through the application's `ApplicationScope`, whose `server` is the loader's unmounted `server`, so `server.http()` from `import { server } from 'harper'` registers unrouted: it still answers outside the mount and, being on the default chain, does not run for requests the mounted route answers (unless a mounted handler names it in `after`). REST shares one registration, and so one options object, per resolved route: the first `handleApplication` on a route keeps its `rest:` options. Which application is first depends on load order, and components-root applications load concurrently, so unmounted applications that set different `rest:` options get one of them per boot. Caller shapes are pinned in `unitTests/server/serverHttpMountCallerImpact.test.js`.
- An invalid mount (unparseable `host`/`urlPath`) fails the application **closed**: `componentLoader.tryRootConfigMount` skips loading it entirely rather than falling back to unmounted access — loading unconstrained would silently drop the isolation the operator asked for, which is worse than not loading at all.
- Two applications mounted at different routes can register same-named middleware (e.g. both enable `rest`) without colliding: `middlewareChain.resolveRoutedChains` resolves `before`/`after` name references against a registry scoped to that route's own group, falling back to a _global_ registry that only holds genuinely unmounted entries (e.g. `authentication`) — never another mounted route's entries.
- `host` matching reads `request.host` (Harper's `Request.host` getter), not the raw `Host` header — HTTP/2 clients send `:authority`, never `Host`, so reading the header directly silently 404s every host-mounted app under h2 while h1 keeps working. `hostnameFromHeader` also strips a trailing dot (`api.example.com.`, the absolute-FQDN form some resolvers emit) since it names the same origin.
- `scopeMount.normalizeMountHost` validates against the same grammar as the `deploy_component` operation's `host` field (bare DNS hostname or IPv6 literal) and throws otherwise, so a hand-typed root-config `host` with a port/scheme/path fails the application closed too, instead of loading it unreachably. `nestScopeMount` logs a warning when a child's `host` is discarded by the parent-authority rule, so that isn't silent.

---

## Operations authorization boundary

Operations request bodies are untrusted data. `serverHelpers/serverHandlers.ts → handlePostRequest()` rejects
prototype-mutating property names and strips the legacy `bypass_auth` property before dispatch.
`serverUtilities.ts → chooseOperation()` never reads authorization control from the body: trusted
internal callers pass bypass state as a separate argument and expose it to operation handlers only
through `operationAuthorizationState.ts`'s async context. When an operation must run on another
thread, `registeredOperations.ts` carries that state in the same-process ITC envelope, separately
from the structured-cloned body. Never attach trusted dispatch state to an operation payload.

Each thread has its own operation map, so a fact about a registered op reaches another thread only
through the OPERATION_REGISTERED announcement (workers also get main's names in `workerData`),
never a module-local registry. It carries routing and `grantable` (so `validateOperations` accepts
the name in an `operations` allowlist); a new consumer extends that message. Mirroring grantability
only widens what an allowlist may _name_: enforcement stays in `chooseOperation` on the registering
thread. Main forwards a miss to a registering worker (#1736); a worker forwards a miss for a
main-announced name to main (#4134). `operationExecuteRequestHandler` passes `forwarded`, so a
request that crossed once dispatches locally only and the two directions cannot loop.
Only a `PermissionResponseObject` denial returns as data.

### A sealed operation's inner body is untrusted the same way (`components/encryptedOperation.ts`)

`encrypted_operation` (#3288) opens an `enc:v1` envelope and dispatches the inner body through `chooseOperation`
under the outer principal. That body may not carry `hdb_user`, `impersonate`, `bypass_auth` or dispatcher fields,
both operations pass `verifyPerms`, and job operations are refused because `system.hdb_job` keeps the request and
result readable by `get_job`. Only admission failures before the nonce is reserved answer in plaintext. Dispatch logs
the body's view (`utility/operationLogView.ts`), never the body, and forwarding carries the view beside the body like
trusted state. That holds on this node only (#3338); replay is refused per process (#3344, #3816). Tests:
`unitTests/components/encryptedOperation.test.js`.

## Resource ↔ HTTP boundary

`REST.ts → http(request, nextHandler)` is the chief integration point: it takes a `Request`, asks the `Resources` registry for a match, builds a `RequestTarget`, and dispatches into the Resource class's static method. Cache headers are translated to `request.expiresAt` / `onlyIfCached` / `noCache` flags within the same function.

### Multipart request bodies

The header-aware `getDeserializer` in `contentTypes.ts` selects built-in multipart decoding outside the synchronous `server.contentTypes` registry. That registry has no built-in `multipart/form-data` entry; a custom unary deserializer registered under that type takes precedence, and deleting it restores built-in request decoding. Multipart REST static handlers receive ordered `{ name, value }` parts directly, with files as Blobs carrying `type` and `name`. The inherited POST/PUT/PATCH wrappers collect the object (repeated names become arrays) and consume files into replayable Blobs before calling `allow*` and the instance method with the same object. GraphQL POST retains buffered form-object delivery. This replaces the previous raw-byte envelope in REST and the shared GraphQL POST decoder; a custom multipart deserializer can restore raw-byte delivery. Cached-source Responses retain their opaque Blob fallback. Media types are normalized, including fallback envelopes, while exact custom registrations retain precedence. Synchronous WebSocket/MQTT decoders retain opaque multipart envelopes. `Request<Body>` describes the body with `ResourceBody<Body>` while its default preserves middleware's existing `any` type. A custom static streaming handler takes over authorization and must authorize individual fields, for example by passing a fresh context with `authorize: true` to each table static write (the entry call consumes that flag). Preserve the request's signal and transaction in that context. `multipartForm.ts` requires each streaming file's source to be consumed before advancing; an unread file fails rather than being silently drained. Applications saving a file must await that write too; source consumption alone does not establish durability. Consume the body during the custom static handler, before returning a response; its staged writes require an explicit transaction commit before advancing on both RocksDB and LMDB. Delegating to the inherited wrapper needs no per-file application commits. Delegation must be the body’s first and only consumer: returned, partially read, exhausted or already-claimed multipart bodies fail with `ServerError` (500) before authorization or a write. Direct reads while delegation is running are unsupported and are not detected. Advancing or abandoning a save before consuming the file is a handler fault (`ServerError`, 500); malformed input remains a client fault. Explicit commits can leave earlier files durable if a later part fails, and existing transaction time limits apply. Parser errors, truncation and unsafe names fail the form; busboy limits each field to 1 MiB, with field/file/part limits of 64/64/128. The existing global HTTP body limit applies in both modes. Cancellation fails active files and drains the remainder only within the remaining body budget, pausing further intake at the cap while the response remains open. A one-second discard grace applies, starting after response completion on Node because destroying an unread request closes its socket. A handler may deliberately stop iteration and return a successful response; errors from discarding queued files must not replace that result. Failures recorded before cancellation still reach the handler. Bun and uWS can buffer incoming bytes independently of decoder backpressure; the byte cap bounds decoder consumption, not those transport buffers. The multipart unit tests and `integrationTests/resources/multipart-form.test.ts` pin this contract.

### Streaming startup errors

SSE and NDJSON serializers eagerly take and hold their first iterator step for GET; HEAD takes the same step when `REST.ts` waits for it, then discards the body so HEAD answers GET's status. HEAD of an event stream (`Accept: text/event-stream`, dispatched as CONNECT) is not started: a subscription's first event can be indefinitely far off, and an async generator's `return()` waits behind it. `REST.ts` waits one event-loop turn for that step: an immediate rejection stays a Problem Details HTTP error, while a first item or the cutoff commits the stream. Mutating requests skip the startup-status gate because their transaction has already committed; all of their stream failures are in-band. Later GET failures are terminal, format-valid records (`event: harper-error` for SSE and a reserved control record for NDJSON). Keep the decision in the serializer/REST boundary so Node, uWS, Bun, compression, and injection share one contract; transports must not independently prefetch the iterator.

SSE terminal event data uses `{ error: <code-or-class>, message: <message>, status?: <status> }`; NDJSON wraps the same object as `{ "$harperStreamError": { ... } }` so it cannot be mistaken for an ordinary row with an `error` field.
Sources with `mapError` remain unmapped for both so their failures reach this single contract instead of becoming legacy data records.
Generic JSON-array streaming has no record that can mark an array failed (an ordinary row may carry an `error` field), so `JSONStream` writes a `{ error: "<name>: <message>" }` diagnostic element (best-effort: lost if backpressured, never the abort), omits the closing `]`, and destroys its Readable (`destroy(error)`); every sink then aborts the transfer ([below](#a-streamed-response-is-completed-only-when-its-source-ends-cleanly-serverhttpts-serverserverhelpersuwsserverts)). A rejected promise element or a row that fails to serialize fails the stream the same way in the row's place. The failure is thrown, never yielded, so backpressure cannot leave a written element without the failure that follows it. Mutating requests are no exception: their writes have committed, so a client that retries an aborted POST can repeat them; the element keeps `replicationUnconfirmed`/`retryable: false` for a client reading the partial body. A local JSON export writes a temporary sibling and renames it over the target only on success, so a failed export rejects and leaves the target intact. Rows that a `mapError` mapper recovers become plain `{ error, message, ...partialObject }` rows (kept in JSON, CBOR, and MessagePack; CSV keeps the key with blank cells unless `error`/`message` are in the column set, or drops later data columns if a failing first row sets the header), and only a row's own failure is recovered: `ReadSnapshotExpiredError` (the snapshot is gone, so no later row can be read) is rethrown by both the REST and operations-API mappers and fails the stream even inside a row's nested read. The CSV stream is piped with `stream.pipeline` so failure reaches the transport instead of raising an uncaught exception. A slow client that stalls a collection read past `storage.maxTransactionOpenTime` hits this via `ReadSnapshotExpiredError`. Pinned by `unitTests/server/serverHelpers/JSONStream.test.js`, `unitTests/server/serverHelpers/rowErrorRecovery.test.js`, `integrationTests/server/stream-error-contract.test.ts`, `integrationTests/server/stream-snapshot-expiry.test.ts` and `integrationTests/server/stream-row-error-recovery.test.ts`.
REST problem details publish only an explicitly negative `retryable: false` hint; a missing hint is unknown.
All three terminal records add `replicationUnconfirmed: true` for a reported commit whose local writes landed
but whose confirmation failed, and `retryable: false` for that outcome or another explicitly non-retryable error.
An enclosing scope that rolls back, or has already discarded, writes removes the confirmation flag while preserving the negative retry hint. Metadata getters
on a thrown value may fail; omit unreadable extensions and still finish a valid error record. The commit-level
scope and producer coverage are described in [resources/DESIGN.md](../resources/DESIGN.md#replication-confirmation-failure-means-the-linked-writes-committed-locally).
The `error` value is the stable programmatic discriminator; `message` is diagnostic and follows the same thrown-message exposure policy as pre-commit Problem Details.

Clean stream completion does not prove completeness; clients must inspect SSE for the `harper-error` event and NDJSON for the `$harperStreamError` control record.

The operations API keeps the same line for a request refused before its progress stream starts (authentication, the role allowlist, validation): the Fastify `preSerialization` hook in `contentTypes.ts` answers an error-status reply that would negotiate `text/event-stream` as JSON, unless the route itself set `text/event-stream`. A stream payload never reaches that hook, which is how the progress stream (`progressEmitter.ts`) keeps its in-band `event: error` at status 200. The hook is shared with the legacy custom-functions server (`fastifyRoutes.ts`), whose untyped errors follow the same rule. `harper deploy` unwraps the unnamed frame older servers still send in that case.

### Deferred credential rejection (#2418)

`authentication` runs before route matching, so when it meets an `Authorization` header it cannot
resolve it does not yet know whether Harper or an application owns the URL. Rejecting there forces
an application to choose between two things it needs: Harper owning its own routes (status, REST
resources) and its own routes receiving their own credential scheme untouched.

So a rejection is recorded rather than answered:

- **Valid Harper credentials** authenticate normally and populate `request.user`. Unchanged.
- **No credentials** continue anonymously. Unchanged.
- **A syntactically valid credential Harper does not recognize** leaves `request.user` unset, leaves
  the inbound `Authorization` header byte-for-byte intact, and records request-local state through
  `security/deferredAuthentication.ts`. The state lives behind a module-private `Symbol`. Its
  descriptor and value are immutable and non-enumerable, so downstream middleware cannot clear it
  and it does not leak through request copies or serialization.
- **An internal authentication fault** — unreadable or malformed JWT key material, a storage failure,
  an unexpected error type — is never deferred, and fails closed with the in-line 401.
- **The operations API** never defers: `request.isOperationsServer` short-circuits to the in-line
  401, because every operations route is Harper-owned and there is nothing to defer to.

**Rejection provenance is asserted, never inferred.** `security/credentialRejection.ts` holds a
module-private `Symbol` tag; only the code that actually concludes "this credential is unacceptable"
sets it, and `isCredentialRejection()` reads nothing else. Status ranges cannot carry that meaning:
user resolution touches system-table searches (`listUsers()`) that raise a default-status-400
`ClientError` when `system.hdb_role`/`system.hdb_user` is unavailable, so a 4xx test would classify a
storage outage as an unknown credential and hand it to application authorization. The tag is set at
exactly these points:

- unknown user, inactive user, bad password — `security/user.ts → findAndValidateUser()`
- JWT syntax, signature, expiry, not-before, subject/claim rejection — `security/tokenAuthentication.ts → validateToken()`
- refresh-token hash mismatch, malformed scoped-token claims — `security/tokenAuthentication.ts`
- an `Authorization` scheme Harper does not implement — `security/auth.ts`
- a component's `server.getUser` override that tags its own error — `markCredentialRejection` / `credentialRejectionError`, exported from `harper` (harper#2703)
- a component's `server.registerBearerValidator` hook that tags its own error — `markCredentialRejection` / `credentialRejectionError`, exported from `harper`

`validateToken()` separates the two in the same catch: `jsonwebtoken` reports unusable key material
through the very same `JsonWebTokenError` type it uses for a forged token, so the public key is
validated as key material before `jwt.verify()` runs and a residual key-material message is treated
as a fault. An untagged error propagates unmasked.

The Bearer path's refresh-token probe follows the same rule. When operation-token validation says
`invalid token`, authentication retries the credential as a refresh token; a fault raised by that
retry propagates, and only an ordinary _tagged_ refresh rejection lets the credential go on to the
component validators (below) and, if they all decline, restores the original operation-token
rejection for deferral. An in-line fail-closed response logs the original fault server-side and
returns the same generic authentication failure a rejected credential gets, so internal detail never
reaches an unauthenticated client.

Any layer that establishes Harper owns the route then settles the deferred state before doing work:

- `REST.ts → http()` — after `resources.getMatch` succeeds (and for the OpenAPI document)
- `REST.ts` WebSocket handler — once the HTTP chain settles, _before_ `resources.getMatch(url, 'ws')` (`assertNoDeferredCredentialRejection`), so the close code cannot reveal whether the resource exists
- `graphqlQuerying.ts` — after the `/graphql` prefix match, ahead of its error mapping
- `static.ts` — after a static file entry matches
- `mqtt.ts` WebSocket handler — once the pending HTTP chain settles, before the first packet
- `components/mcp/adapters/harperHttp.ts` — after the WebSocket hand-off, before the body is read
- `security/fastifyAuth.ts → authorize()` — when a legacy Fastify route runs `hdbCore.preValidation` (not under uWS or Bun: `injectToFastify()` carries no base request)

**Every Harper-owned handler registered `after: 'authentication'` owes this settlement**, because
declining to call `nextHandler` is precisely the moment ownership is settled. A handler that skips
it serves an unrecognized credential as anonymous — the MCP application mount did exactly that, and
returned 200 for an `initialize` the base revision answered with 401.

Settlement goes through `settleDeferredCredentialRejection()`, which returns the descriptor an in-place
rejection gets (`credentialRejectionResponse()`): status 401, `serializeMessage({error: message}, request)`
in the negotiated content type, and the challenge described below. That matters because an owner's own error mapping is not
that contract — REST renders a thrown error as an RFC 9457 Problem Details document and GraphQL as
`{errors:[{message}]}` — and a rejected credential never reached either before deferral existed.
`assertNoDeferredCredentialRejection()` is the throwing form, for a WebSocket upgrade that has no
descriptor to return. A WebSocket owner cannot read the state synchronously: `server/http.ts` starts
`httpChain[port](request)` and invokes the WebSocket chain with the still-pending completion, so
authentication has not yet classified the credential. `mqtt.ts` therefore settles on that promise —
the same one the session's principal resolves from — and closes the socket from its rejection, while
its frame handlers still attach synchronously. The deferred status is pinned to 401 regardless of the underlying error's own
status, so a 403 `token expired` reads exactly as it did before. A Harper-owned route therefore behaves identically to the pre-deferral
build, protected or public: an unknown credential can never buy access an anonymous caller would
have received, and can never reach an application catch-all. Only a URL that reached
`nextHandler` — one no Harper route owns — carries the original header onward.

The contract is route-ownership-based, not path-based. There is no exemption list, no carrier
header, no credential rename, and no pre-auth stripping shim.

**Every authentication 401 Harper renders is challenged; an app's own 401 under a deferral is not re-decorated.**
`credentialRejectionResponse()` builds in-place and settled 401s: a negotiated `Content-Type` and, off the operations
API, `Bearer realm="Harper"` for a Bearer credential (`error="invalid_token"` only for a rejected token; browsers raise
a dialog for Basic), else `Basic realm="Harper"`. `auth.ts` challenges or login-redirects a downstream 401 only when
nothing was deferred: a settled 401 is already challenged, and a redirect would loop (`static.ts` settles the login
page). The legacy Fastify error handler adds a missing challenge from the error (its deferred strategy, or
`bearerTokenRejection()`), else from the presented scheme. The #1565 identity floor is stamped in `applyResponseHeaders`.

**The identity cache floor survives the legacy Fastify fallbacks.** A response produced under a
deferred credential is credential-dependent (#1565), so `authentication` stamps
`Cache-Control: private, no-cache` and `Vary: Authorization, Cookie` on it. Before deferral an
unrecognized credential could not reach a fallback at all, so this was unreachable. All three adapters
now reconcile through one policy, `Headers.ts → mergeChainHeadersIntoFallback()`: Fastify wins every
single-valued header it set, `Vary` is unioned, and the private scope is re-applied unless the final
response explicitly opts into shared caching (`public`/`s-maxage`).

`Set-Cookie` is the deliberate exception to Fastify-wins. It is a list-valued field, so the chain's
cookies are appended beside Fastify's and de-duplicated by exact value, never by cookie name. A cookie
is identified by name _plus_ `Domain` _plus_ `Path` (RFC 6265 §5.3), so collapsing by name drops
legitimately distinct cookies — a same-name pair scoped to `/` and `/wp-admin`, or a `Max-Age=0`
deletion paired with a set. Exact value is also what makes Node's `writeHead` re-merge idempotent,
because that path sees the chain's own cookie already on the response. Two cookies that do share a
full identity both reach the client, chain last, and the user agent resolves them last-wins.

Bun and uWS rebuild their headers from Fastify's reply and merge once. Node hands Fastify the same
`ServerResponse` the chain's headers were copied onto, so copying is not enough — a route calling
`reply.header('Cache-Control', …)` replaces the floor outright and can make a credential-dependent
response shared-cacheable. `bridgeChainHeadersToNodeResponse()` therefore runs the same merge from a
`writeHead` interception, the last point the header set is still mutable and the one Node also routes
implicit headers through.

### Component Bearer validators (`server.registerBearerValidator`, `security/bearerValidators.ts`)

A component can accept Bearer tokens Harper did not issue (first consumer: the OAuth plugin's MCP
authorization server). The validators run inside `authentication()`, not as `before: 'authentication'`
middleware, so one place still decides `request.user` for every Harper-owned route. A middleware that
set `request.user` itself would have to re-implement, per plugin, what this path enforces:

- **Harper tokens win.** Validators see only a credential `validateOperationToken` and the refresh
  probe rejected as `invalid token`; an expired Harper token never reaches them.
- **A validator names a user; Harper supplies the role.** The contract is
  `{ username, authExpiresAt?, authCacheable? }`, resolved through `server.getUser` (the Basic path's
  `userRecordVersions` → `getUser` → `trackUserRecords`), so `isCurrentUser` and the authorization
  cache treat it like a Basic login. Any other field is refused, `role` included. Inline-permission principals (a per-token narrowed role under the scoped-token ceiling)
  were built and dropped: the first consumer's tokens name a Harper user and carry no permissions,
  and a principal no `hdb_user` backs needs its own revocation at every by-name rehydration site
  (`security/DESIGN.md`). Refusing `role` now keeps adding it later from changing an existing
  result's meaning.
- **Expiry is exact.** `authExpiresAt` is the validator's value (300 s when omitted) capped by the
  token's own JWT `exp`; it is checked again after the `server.getUser` lookup. `authorizationCache` evicts at
  it, live subscriptions end at it (#1414), and MQTT wills persist it and are dropped past it, on
  restart replay checked again after the replay's own `server.getUser` lookup. The
  decoded `exp` is unverified, so it only shortens, down to refusing a token whose `exp` has passed
  (`token expired`) even when the validator accepted it. A validator that verified the token's
  expiry should still return it as `authExpiresAt`, since Harper decodes only JWTs.
- **The cache key is the Authorization header.** A cached principal is served to any route and host
  on the worker without calling the validator, so a validator whose answer depends on the request
  (an RFC 8707 audience bound to one mount, say) must return `authCacheable: false`.
- **Disposal is exact.** The cache records which registration resolved each principal; a hit whose
  registration was disposed is evicted, so registering never flushes cached Basic or session users.
  Declines are not cached: a validator caches its own.
- **Faults fail closed.** A tagged throw is a credential rejection (deferred, or 401 on Harper-owned
  routes); an untagged throw, a malformed return, or exceeding `timeoutMs` answers 401 in place. The
  claim's `server.getUser` lookup shares the chain budget, so total authentication latency stays
  bounded; a deadline only bounds waiting, it cannot interrupt a synchronous validator.
- **No minting, no operations port.** A `_bearerValidator` principal cannot turn its token into Harper
  tokens: `createTokens` refuses it a passwordless operation/refresh mint and (unless operation
  authorization is bypassed) a scoped token, also after impersonation; a username and password still
  mint as usual. A dedicated operations API port never runs validators or serves their cache entries. On a shared port they reach `verifyPerms` like any principal.

Registrations are worker-global and outlive `scope.close()`, so in-flight requests drain. The
`Scope` proxy records what a plugin registers through `scope.server`, and
`sequentiallyHandleApplication` disposes those if that load fails. A module's `import { server } from
'harper'` is the application's shared server, not tied to one plugin load, so its registrations stay,
like its `server.http` middleware.

### Response Cache-Control / Vary policy (#1518, #1565)

Three tiers, applied in two places:

1. **App/resource explicit** — a `Cache-Control` set by the resource (or `@table(cacheControl: "...")` for anonymous reads, emitted in `REST.ts → http()`) always wins. The declaration is required: anonymous readability alone never emits shared-cache headers, because a request-attribute-gated `allowRead` (IP, headers) would make inferred `public` unsound.
2. **Identity floor** — `security/auth.ts → applyResponseHeaders` stamps `Cache-Control: private, no-cache` + `Vary: Authorization` (+ `Cookie` when sessions are on) on any response where a principal was resolved, credentials were rejected (401), or a credential rejection was deferred (#2418 — the application answered using the header Harper passed through, so the response is credential-dependent at a plain 200), _unless_ the app opted into shared caching with `public`/`s-maxage` (the RFC 9111 opt-in).
3. **CORS partitioning** — when CORS is enabled, every response gets `Vary: Origin` (the ACAO header is reflected per-origin, and its absence on no-Origin requests is origin-dependent too).

The `@table(cacheControl:)` value is persisted on the primary-key attribute (like `expiration`), so all threads and future boots see it; `resources/databases.ts → table()` treats `null` as "schema explicitly has none" (clears on reload) and `undefined` as "caller is not schema-defining" (no clobber from `add_attribute`/cluster schema events).

---

## MQTT durable sessions resume through the checked subscription (`server/DurableSubscriptionsSession.ts`)

A persisted QoS 1/2 entry is `{ qos, topic, startTime, databaseGeneration? }`, and the record carries the `incarnation` of the connection that owns it (harper#2448). A QoS 0 entry is `{ qos, topic }`: it is session state with no position, resumed live with retain handling 2 and no acknowledgement tracking.

- **Positions are certified, never clocks.** A new subscription starts at its registration watermark (`registeredThrough`), bound to the database generation when one exists, and otherwise unbound until the first certified position replaces it: on RocksDB at `localResumeStart`, sampled when it registers, before the log is opened — just below the lowest outstanding local reservation (a thread still mid-reservation contributes the lower bound its slot carries), or else at a clock sample every later key exceeds — so no local write still in flight is skipped (committed keys above a held reservation replay, as duplicates; a late apply from another origin is covered by the log positions below); on LMDB at the newest committed log key, also sampled when it registers (`newestCommittedKey` in `resources/transactionBroadcast.ts`): lmdb-js stamps each log key at commit, under the write lock, from the native realtime clock, so every later commit is above it while that clock does not move backwards, and an empty log starts at 1, below every key and above the log's symbol metadata. Only a resource that is not a table starts at `getNextMonotonicTime()`. On either engine the log keys come from a native clock, so a JS-clock start could land below a record the retained scan had already sent, or above a write committed after it registered. A first live delivery below the start (a commit that landed while the subscription registered) holds the position below its key until acknowledged, even before progress certifies anything. A SUBSCRIBE that replaces a QoS 1/2 topic's subscription continues that topic's position through the checked replay, since replacing must lose nothing; a pruned-history refusal there resets the session as it would at reconnect. A topic's position is `min(subscription.progress(), previousKey of its oldest unacknowledged delivery)`, where `progress()` is the database's certified local watermark, held below every local key reserved but not committed and every committed one a notify pass has not dispatched (resources/DESIGN.md "Origin-closed timestamp floor", harper#3112); a transaction's messages share a key, so one unacked message holds the position before its whole transaction, and while a message is still queued the position stays before the last delivered transaction, which that message may share. Live events arrive in commit order, and a RocksDB transaction takes its key before it commits, so a transaction can arrive after a higher key; a resumed replay reads the log in commit order too. Its previousKey is then the position just below its own key, and while such a late delivery is unacknowledged the position takes the lowest previousKey of all of them rather than the oldest's (harper#3101). The position never passes an event sent to the subscription and not yet delivered: `progress()` certifies dispatch into the queue, not delivery, so while a late event is still queued behind deliveries of higher keys the position stays just below it (`lowestLateUnconsumed`, counted by send ordinal against the session's `consumed`). Every other queued event is at or above the last delivered key, which the queued-message rule already covers. Scan deliveries (`fromScan`: the retained-record scan, the single-record current send, and a reload re-snapshot, on every storage engine) stay out of this ordering: they are retained state, which a resumed session does not resend: `resumeTopics` subscribes with retain handling 2 (`addSubscription` omits current values for that or an explicit `omitCurrent`), since a record topic whose saved position covers its current version would otherwise send that version again.
- **Checkpoints:** coalesced after acknowledgements, on one unref'd sweep per thread (`min(auditRetention / 10, 1h)`), and at disconnect, where positions are taken before subscriptions end because `close()` clears a queue and would read as idle. Nothing past a resumed position is saved until that subscription's `resumeVerified` resolves true. A delivery acknowledged above the position (a PUBACK at QoS 1, a PUBREC at QoS 2, below) is kept as a receipt, bounded as below, so a partly acked transaction is redelivered only in its unacknowledged part. A QoS 1 receipt is kept while the position may stay below it, or while a checkpoint is kept or certified, whose replay revisits everything above its floor. One at or below a scalar of this generation is read only by such a replay on another node, so it is written only by the final save (disconnect, takeover); writing them with every save cost about 3× on a steady QoS 1 acknowledgement stream (measured in-process), and after a crash a checkpoint resume elsewhere can resend QoS 1 deliveries acknowledged within the floor lag. QoS 1 receipts are kept while the session holds fewer than half the receipt limit, so they never take the share QoS 2 needs; at that share the ones at or below this node's scalars give way first, once per position pass. Legacy `acks` lists are ignored.
- **Before CONNACK,** a collection entry bound to its database's current generation is checked against the floor (a record entry's own walk decides after CONNACK); a failure deletes the record and reports the session as not present. The connection then writes its incarnation (`takeOver`), and every later write first checks the stored incarnation: a connection that finds another's stops writing and closes (0x8E), and one resumed from a record never creates one. Any newer authenticated connection for the client id on the same thread, a clean start included, closes the older durable connection the same way before it reads or deletes the record, once that connection has saved its positions, and waits for that save to settle; a connection that has already closed counts until its last save settles. A save that failed leaves the record at the last one that landed, so the newer connection resumes from there and may redeliver, never skip. Simultaneous CONNECTs for one client id take their turn through a per-thread claim, so each sees the one before it; one that gives up waiting keeps its place until the one before it finishes. The CONNECT's pending session is assigned before it waits, so packets sent right behind the CONNECT wait with it rather than being refused; the wait is bounded (10 s, then CONNACK 0x88, or 0x03 on v3.1.1), and a CONNECT whose client closes while it waits takes nothing over. A session that has ended, by a disconnect or by yielding to a takeover, saves nothing after its final save, so a SUBSCRIBE still in flight cannot write over the record a newer connection claimed.
- **Subscription changes are serial.** Packets are handled concurrently, so a durable session applies SUBSCRIBE, UNSUBSCRIBE and `resume()` one at a time: a topic's state belongs to one subscription. A SUBSCRIBE of any QoS is saved before SUBACK, and an UNSUBSCRIBE before UNSUBACK: each waits for a save that read the session after its change (`saveExchanges()`), never for `persist()`'s loop, which acknowledgements keep running while a save outlasts the gap between them (`durableSessionSubscribeBoundedSave.test.js`). A failed SUBSCRIBE on a live session leaves its topic unsubscribed and saves that: it ends the subscription it started, and drops the state of the one it replaced, which replacing ended. Once the session has ended, a SUBSCRIBE or UNSUBSCRIBE that has not yet updated it is refused with `SessionEndedError` without dropping saved topics, while a failed new topic is still dropped (`durableSessionEndSubscribeRace.test.js`). An UNSUBSCRIBE whose save fails is reported failed again on a retry until the removal is saved, and any failed save starts the checkpoint timer, so a session with only QoS 0 topics retries it too.
- **QoS 2 is exactly-once by packet id, in both directions** (harper#906). A packet id belongs to its exchange until that ends: a new outbound id skips ids awaiting a PUBACK, PUBREC or PUBCOMP and ids held for a resend, and a session with all 65,500 in flight closes its connection (0x83) rather than reuse one. Every QoS 2 acknowledgement that lets the client discard state is sent only after the first save that read the session after the change lands (not after the save loop goes idle, which steady traffic can postpone indefinitely); a retransmitted packet waits on the same save and gets the same answer, and a failed save sends none (the packet's error path answers with DISCONNECT); the client's retransmission of that packet tries the save again. A session that ends (disconnect or takeover) while an inbound QoS 2 PUBLISH is still committing takes its final save after that publish (waiting up to 5 s for it, within the 10 s takeover deadline; one slower than that is saved as not published, so its retransmission publishes again), so the id is kept; `writes`, which a takeover waits on, is that save. An ended session publishes no new QoS 2 PUBLISH and acknowledges nothing it can no longer save. The record carries `awaitingRelease` and `awaitingCompletion`; a clean session keeps both in memory for the connection.
  - _Inbound:_ the v5 CONNACK advertises a Receive Maximum of 1,000, and a QoS 2 PUBLISH that would open more exchanges than that ends the connection (DISCONNECT 0x93 on v5), which bounds `awaitingRelease`. A QoS 2 PUBLISH is published once per packet id. Until its PUBREL, a PUBLISH with that id, DUP or not, gets the first one's PUBREC and is not published (MQTT 5 §4.3.3 Method B). The id is saved before the PUBREC and its removal before the PUBCOMP, since the client may reuse the id once it has the PUBCOMP. A failed PUBLISH (PUBREC ≥ 0x80) ends its exchange, so a retry publishes. A PUBREL for an unknown id gets PUBCOMP 0x92.
  - _Outbound:_ a PUBREC for a QoS 2 delivery acknowledges it; one for any other id gets PUBREL 0x92 and changes nothing. The PUBREL waits for the save that records it as owed, and a resumed session sends owed PUBRELs before anything else (MQTT 5 §4.4). A topic's position is a low-water mark, so a delivery PUBREC'd above it (behind an older unacknowledged one, or in a partly acked transaction) is kept in the entry's `received` list and a replay skips it. Receipts collapse into `receivedThrough` only below every key that can still arrive new: below `progress()`, every unacknowledged delivery and every late event still queued, and not at all before a certified subscription's progress certifies a key or while a resumed replay awaits its verdict, since the replay reads the log in commit order and can still hold a lower key unread. Deliveries sent and not yet PUBREC'd are kept in `inFlight` with their packet ids, saved at checkpoints and at disconnect, not before each send; a replay sends each again under its id with DUP set. A SUBSCRIBE that replaces a QoS 2 subscription carries both lists over and moves the replaced one's deliveries awaiting PUBREC into the resend list, since the replacement replays from the position; a PUBREC that arrives for one before it is sent again marks it received. So does one for a delivery restored from `inFlight` and not yet sent again: its id is in `reservedIds` and its entry in `resend`, with no `awaitingAcks` entry until it is sent, so `received()` finds it there (`takeResend`) rather than answering 0x92, which would have the client discard an exchange the server then sends again. A restored topic whose resume subscribed to nothing is replaced the same way, with or without a live subscription, so the saved QoS is always the granted one: a downgrade releases its receipts and reserved ids, and an upgrade starts tracking PUBREC. Retained values (scan deliveries) are outside this: as before, a resumed session does not resend them. Every key below the deliveries still awaiting PUBREC, below the last delivered key (whose transaction may have more queued) and at or below the subscription's certified progress (a transaction that took a lower key can still commit until progress passes it), was taken whole, so its entries collapse into one `receivedThrough` key. A replay skips keys at or below it, but a live transaction that commits below what was already delivered is not skipped. Within the key still being delivered, deliveries taken in order from its start are kept as one `receivedRuns` entry `[key, count]`, and only those taken out of order singly in `received`, so entries accumulate only behind a delivery the client withholds. All three drop once the position passes them, and are restored only into the database generation whose log keys they name. Past 1,000 entries across a session no more are kept, which bounds the record: a delivery taken behind a withheld one is then resent after a reconnect, under a new packet id. `receivedThrough` acts as a position for a replay, so a late transaction below it still queued at disconnect is skipped, as with a late commit below a saved position (harper#2928).
  - _Delivery identity_ is `[log key, ordinal, record id]`: a transaction's events share one key and a record can recur in it, so the ordinal (the delivery's place among those sharing its key, counted after filtering, in the same order live and on a replay) tells them apart, and the record id is checked for `received` and resend entries, so a mismatch there delivers rather than skips. A run trusts ordinals alone: if an application row or event filter changes what a subscriber sees between the live delivery and the replay, ordinals within that key can shift.
- **A delivery that cannot be sent ends the connection, not just the session.** The listener's `catch` in `mqtt.ts` aborts the transport (`destroy`/`terminate`, as for a parse error) and `onClose` ends the session, so the client sees the drop and reconnects. Ending only the session, as before, left the client connected and receiving nothing. An abort rather than a graceful end, because teardown on a graceful TCP end waits for the peer to close its side. A delivery that fails every time therefore repeats on each reconnect (a durable QoS≥1 session replays the unacknowledged message).
- **Wills are kept per connection,** keyed `[clientId, incarnation]`: a connection closing after a takeover publishes and deletes only its own will (MQTT 5 §3.1.4 publishes a taken-over client's will), never the will of the connection that replaced it.
- **Only a will's publish is authorized** (`settleWill`, harper#1874). The `hdb_session_will` row is the session's bookkeeping: it is read and deleted on contexts of its own, not the session's `authorize: true` context, which spends its one-shot check on the first call (roles are not granted system tables, so a non-super user's will never published and its row leaked). The publish then runs on a fresh session context, as the connection's user or a scoped will's embedded role, and the row is deleted after any outcome, a refused or failed publish included, so a will that fails for a transient reason is lost: the boot sweep, the only retry path, would replay a kept row only at the next restart, with no liveness check (harper#3034). The publish commits before the delete, so a crash between them leaves the row for that sweep and the will may be published twice (by design; untested). `unitTests/server/sessionWill.test.js` and `integrationTests/mqtt/will-authorization.test.ts` enforce that only the publish is authorized and that the row is deleted after a publish, a refusal and a clean DISCONNECT.
- **One terminal path** (`subscriptionFailed`): a refused resume subscribe, a final `Error` value (observed through the subscription's `close` as well as the consumer loop, which may be parked on socket back-pressure), or an iterator failure. Only a 410 (pruned history) discards the session — writers fenced, siblings ended, a v5 DISCONNECT (0x83, the client-error message when problem information is allowed) and a socket close that never waits on storage, then a deletion only if the record still carries this incarnation. Anything else, a 409 from a restored or copied database included, saves positions and closes the connection so the client resumes.
- **A per-origin checkpoint is kept beside the scalar** (harper-pro#922 items 3–4): once `checkpoint(holds)` returns one — `holds` is the lowest unacknowledged or resend key per origin, from the `ORIGIN_ID` tag each delivery carries (an in-flight delivery is saved with its origin name) — the entry stores it. **A scalar saved in this generation is the position** (`resumesFromCheckpoint`; bound to it, or a fresh topic's start not yet bound): the checkpoint trails what the session reached by the floor cadence (floors are published and captured every 5 s), so the scalar is never capped by it, and a resume, a replacing SUBSCRIBE and the before-CONNACK check use the scalar, exactly as on an engine that issues no checkpoint. A scalar bound to another generation — another node's record, or a restored copy — names nothing here (it is saved back with that generation, receipts and all, until this node certifies a position of its own), so its resume prefers `resume: checkpoint` with `filterKey: topic`, checked before CONNACK whichever node issued it, record topics too: a 410 resets the session as a pruned position does, a 409 or 400 (another scope, LMDB) falls back to the scalar and drops the token. While floors are unavailable the token stops advancing. Receipts kept with a checkpoint name origin keys, so they survive another node's generation, and their compaction is bounded by the checkpoint's lowest boundary (`checkpointFloor`) and their pruning by the lower of it and the scalar, so a checkpoint replay elsewhere skips what was acknowledged above its floor and a resume here what was acknowledged above the scalar (an unacknowledged delivery can hold the scalar below the floor, under a late delivery acknowledged since); scalar pruning stops from the call that certifies one (but for the QoS 1 share's reclaim, above), and foreign receipts are dropped on a fallback to the scalar. **A topic adopts its first checkpoint only once its floor passes every key whose receipt it may lack** (`prunedThrough`: receipts pruned, compacted or never kept until then, receipts a replacing SUBSCRIBE forgot, and the topic's start), so a checkpoint replay neither resends what the session acknowledged nor delivers what preceded its SUBSCRIBE; until then a resume elsewhere uses the scalar, best-effort. A session with a checkpoint but a delivery of unknown origin keeps its last token. Pinned by `durableSessionCheckpoint.test.js`.
- **Only the current generation is checked.** A position bound to another generation, another node's (`hdb_durable_session` replicates, and each node mints its own generations) or this database's before a restore or copy, resumes best-effort: it is not checked before CONNACK, replays unchecked from where it is, and binds again at the first certified position. Until a live write gives it a watermark, that replay saves no position, so a reconnect on a quiet database replays it again.
- **A position per transaction log is kept beside the scalar, for a wildcard topic on RocksDB** (harper#3790). The scalar is this node's own watermark, and each origin's log is appended in arrival order, so another origin's transaction can arrive after a save with a key below it; a resume by key never reads it. The subscription reports, per log, the key of the last complete transaction it has read (`logCursors`), and every event carries its log and that log's position just before its transaction (`LOG_NAME`, `LOG_BEFORE`). At each position pass a verified topic takes two positions per log, both what the subscription has read unless a delivery holds them back: `cursor`, before the earliest delivery from that log still unacknowledged or queued, and `readThrough`, before the earliest still queued, so nothing after it was sent. Deliveries of one log arrive in that log's order, so the first found is the earliest and neither moves back. `takenThrough`, just below the lowest key among the deliveries a topic holds, is saved while it holds any: what was sent with a key at or below it is not among them, so it was taken (a late delivery of another origin can sit below the scalar, which never moves back for it). The scalar and the positions move together or not at all (a topic whose subscription keeps none drops its saved ones when its scalar moves, and they are still replayed on a resume the broadcast cannot track), so the scalar's invariant holds for what the positions cover: every delivery sent up to `readThrough` with a key at or below `takenThrough` was taken.
  - **Record shape.** Keys are origin node names, never log names or node ids: the record replicates and this node's own log has another name elsewhere. `record.cursors[database]` is the read-through the database's live topics share, with the database generation that saved it; an entry's `cursors` lists only the logs it differs in, each with both keys, so a topic that could not be read in a pass never inherits a sibling's newer baseline. A topic whose replay has no verdict yet keeps the vector it loaded, whole.
  - **Resume on the saving node** (`fromScalar`; the positions are of the current generation): each log is read after its cursor by exact-start lookup, in arrival order, and a log the vector does not name was created since and is read from its start. Up to the saved `readThrough` the log's deliveries were sent before the save: an entry at or below `takenThrough` was taken and is skipped, and above it the exact receipts decide. After it nothing was sent (`ARRIVED_AFTER_SAVE`), so it is delivered. `receivedThrough`, a key range, is consulted for neither: one compacted before a late delivery arrived can cover it. No checkpoint or route certificate is involved.
  - **A position that is not in its log** never resets the session by itself. One at or below the log's purge watermark was purged: the log is read from its first retained entry when the topic held no delivery of that log and nothing above the scalar was purged (a file written after the save is purged only once retention has passed the save), else the resume is refused (410). Any other miss, or a torn transaction, reads that log alone by key above `takenThrough`, with a warning, or refuses when that key is below the resume floor. Retention is otherwise checked on the scalar, as before: a late delivery not yet taken can have a key older than the retained history while its entry is recent.
  - **On another node** the resume is the checkpoint's (above), unchanged: positions are keys of the saving node's logs in its generation, and nothing shows that another node's copy of an origin's log is in the same order (an entry relayed ahead of the direct route lands early there). The subscription keeps positions of its own from then on. A checkpoint replay reads past the broadcast, so it reports none until the broadcast has returned every entry (`broadcastPassedReplay`). An older copy of this node's own record has positions at or before a newer one's, so it can only send again.
  - Pinned by `durableSessionLogCursors.test.js`.
- **Not covered:** concurrent connections for one client id on different threads, together with crash replay of a failed conditional write (harper#2940); late commits below a saved position (harper#2928) on a single-record topic, on LMDB, in a record saved without log positions, or on a moved session below an origin's checkpoint boundary or with no checkpoint; a late commit whose key equals a delivery acknowledged from another origin (receipts carry no origin); a late transaction still queued behind the message being sent, which the session cannot see; a replay from another generation, which is unchecked. Inbound QoS 2: the publish and the saved packet id are in different databases (the target's and `system`), with no commit spanning them, so a process crash between the two republishes a retransmitted PUBLISH. Outbound QoS 2: `inFlight` is saved at checkpoints and disconnect rather than before each send (that would serialize a system-table write per message per subscriber), so after a crash or a cross-thread takeover that missed the disconnect save, a delivery whose PUBREC never arrived is replayed under a new packet id; a client that delivers at PUBREL (mqtt.js, Paho) still delivers it once. A record written by an older binary drops the QoS 2 lists, which falls back to the previous behavior: owed PUBRELs are forgotten, and PUBREC'd and in-flight deliveries above the position are replayed under new ids.

## Live subscriptions are rechecked by principal, not by sweep (`server/liveSubscriptionAuth.ts`)

The registry indexes each live subscription by username, and each username by the role id its `hdb_user` record names (re-read whenever that username is rechecked, so a reassignment re-indexes it). An `onUserChange` naming a username or role rechecks only those subscriptions; an unknown change, or more than 1,000 pending identities, rechecks all. Token expiry is one unref'd timer over an indexed min-heap of `authExpiresAt`, clamped to the 2^31-1 ms `setTimeout` range and re-armed, so expiry needs no pass. The 30 s tick (`HARPER_SUBSCRIPTION_REAUTH_INTERVAL_MS` overrides it and the backstop) rechecks every entry not registered `identityOnly`, because its decision may read state no notification covers (an overridden `allowRead`, a caller's `select` reaching related tables, an opaque `recheck`). An identity-only entry is rechecked by a full pass only every 5 minutes, or at the next tick once the notification epoch is 0 or differs from the one captured when the last full pass started.

Within a pass, `Resource.ts` resolves each username once (`RecheckPass.memo`) and shares a default-RBAC `allowRead` result (`defaultAllowReads`, no caller-supplied `select`: one written by authorization names no relationship) per resolved user, but still gives each context its own `cloneUserView`. Passes and expiry batches yield every 256 entries. A registration admitted by a principal that is no longer current (`isCurrentUser`, or that check failing) is rechecked by `verify()` before the subscription is returned, because the notification for that change may have run before it registered. A principal with no record provenance (a component's `server.getUser` on a path that does not track it) cannot be checked that way, so it registers as a policy entry; a user only the override knows (`isRecordlessPrincipal`) is not re-read by name. Certificate principals: `security/DESIGN.md`. Enforced by `unitTests/server/liveSubscriptionAuth.test.js` and `integrationTests/security/subscription-revocation.test.ts`, which runs with no periodic pass so every revocation comes from a targeted recheck or the expiry timer; `unitTests/resources/liveSubscriptionReauth.bench.js` measures it at 100k subscriptions.

## "Where is X" cheat sheet

- Where do I register a new HTTP handler? — `http.ts → httpServer()` (or `onRequest()` for the request-only form)
- Where do I register a WebSocket handler? — `http.ts → onWebSocket()`
- How does `before`/`after` middleware ordering work? — `middlewareChain.ts → topoSort`
- Where does PROXY protocol get parsed? — `serverHelpers/proxyProtocol.ts` (applied by `http.ts → enableProxyProtocol` / `createH2CProxyFront`)
- How does an app read forwarded TLS facts (JA3/JA4, ALPN, SNI, mTLS cert)? — `request.connectionInfo` (`ConnectionInfo` from `serverHelpers/proxyProtocol.ts`); only set from a trusted PROXY v2 header on the UDS mirror, never from a request header
- Why does mTLS revocation checking look up the client cert's issuer itself? — `security/certificateVerification/trustedIssuers.ts` — Node only completes a peer chain from the _listener_ context's store, but Harper's client CAs live on SNI contexts (`security/keys.ts → createTLSSelector`), so a resumed TLS session (and Node 26.8.0/26.8.1, nodejs/node#65579) exposes the leaf alone; `verifyCertificate` recovers the issuer from the published CA set and otherwise applies `failureMode`
- Where is the REST request → Resource dispatch? — `REST.ts → http()`
- Where is the operations API request handled? — `operationsServer.ts → handler`
- How are content types (de)serialized? — `serverHelpers/contentTypes.ts`
- Why doesn't every MQTT subscriber re-serialize the message it receives? — `serverHelpers/sharedMessageEncoding.ts` (memoized on the message object the fan-out shares); consumed by the outbound listener in `mqtt.ts`
- Where do durable subscriptions live? — `DurableSubscriptionsSession.ts`
- How do worker threads get their connections? — Each binds its ports itself after the main thread's first bind (`threads/threadServer.ts → listenOnPorts`, `reusePort` where the OS has it); `threads/socketRouter.ts → startHTTPThreads` starts them
- Where is the Operations API wired into Fastify? — `operationsServer.ts → buildServer`

---

## Conventions

- Don't add new code to `fastifyRoutes.ts` — it's the legacy custom-functions path.
- New protocol plugins register through the `Server` interface (`Server.ts`): `server.http()`/`request()`/`ws()`/`upgrade()` (bound to `http.ts`'s `httpServer`/`onRequest`/`onWebSocket`/`onUpgrade`) and `server.socket()` (`threadServer.ts → onSocket`).
- Always pass `name` when registering a listener with `before`/`after` — anonymous entries can't be ordered against.
- Tests live in `../unitTests/server/`.

---

## `universalHeaders` (`http.securityHeaders`): ownership, precedence, and per-thread scope

`server/http.ts` exports `universalHeaders: [string, string][]`, applied to responses in the
Node, Bun, and uWS (`#914`, `HARPER_UWS_HTTP`) request handlers alike. `http.securityHeaders`
config populates it via `applySecurityHeaders()`, called from `handleApplication()` on load and
on `scope.options.on('change', ...)`. Three invariants to preserve:

- **Ownership tracking.** Other components may push entries onto the same shared array, so a
  hot-reload can't clear-and-rebuild it. `applySecurityHeaders` tracks the exact `[name, value]`
  tuples it previously pushed in a module-level `ownedSecurityHeaders` array and splices only
  those out (by reference, via `indexOf`) before re-adding the new set. Any future feature that
  pushes into `universalHeaders` from a hot-reloadable source should follow the same "track what
  I added, only remove what I added" pattern.
- **Root scope owns the config.** `'http'` is a `TRUSTED_RESOURCE_PLUGINS` key, so an application
  `config.yaml` with an `http:` block re-invokes `handleApplication`. A module-level guard makes
  only the _first_ invocation (the root config, which loads before applications) own
  `applySecurityHeaders` and its change listener; later invocations still refresh `httpOptions`
  but cannot wipe root-configured headers.
- **App wins on conflicts.** Universal headers are _defaults_: `applyUniversalHeaders()` (a shared
  helper used by all three transports) only sets a header when `has(name)` is false, and the
  direct-to-`nodeResponse` paths (handlesHeaders, error) check `hasHeader` first. A route that sets
  `X-Frame-Options: DENY` is never loosened by a configured `SAMEORIGIN`. Response paths covered:
  normal writeHead, `handlesHeaders` streams (e.g. the static component's `send()`, which writes
  its own headers directly — universal headers are pre-set on `nodeResponse` / the Bun
  `responseHeaders` shim so the stream can still override its own names), the thrown-error path,
  and the `status === -1` cascade — on Node via the Fastify `'unhandled'` event bridge, on Bun/uWS
  via `injectToFastify` (or the bare-404 fallback when no Fastify instance is registered for the
  port). Each `status === -1` branch builds a **fresh** `Headers` object from the fallback
  response rather than reusing the request's original `headers`, so `applyUniversalHeaders()` must
  be called again on whichever object actually gets returned — applying it only once, before the
  `status === -1` branch, is a trap that silently drops universal headers on every unhandled/404
  response. CI first caught this on the uWS shard (the integration suite's only unauthenticated
  404 case landed there); the same bug existed unnoticed on Bun's parallel `status === -1`
  branches (`getBunHTTPServer`'s bare-404 return and `bunDelegateToNodeServer`'s two `Response`s)
  and is fixed alongside it in #1568.

**Why the operations API doesn't get these headers in normal mode**: ops requests _do_ flow
through the Harper-native `requestHandler` (`httpServer()` calls `getServer()` for every
registration, including Fastify's non-function listener) and cascade to Fastify via the
`status === -1` branch, which copies `response.headers` onto `nodeResponse`. But the ops API runs
on the **main thread**, and the main thread loads components with `resources.isWorker = false`
(`server/loadRootComponents.ts`), so the componentLoader's `resources.isWorker &&
extensionModule.handleApplication` gate (`components/componentLoader.ts`) means http's
`handleApplication` never runs there — the main thread's `universalHeaders` array stays empty.
`universalHeaders` is per-thread module state, populated only where the http component loads.
Corollary: with `threads: 0` the ops API shares the worker where `handleApplication` _did_ run,
so ops responses **will** carry the headers there (benign).

## Under Bun, the main HTTP port is served by `node:http`, not `Bun.serve`

`getBunHTTPServer()` builds the `Bun.serve()` fetch config, but `onWebSocket()` calls
`getHTTPServer()` unconditionally: it has a uWS branch and no Bun branch, because Bun native WebSockets
are unimplemented (nothing sets `config.websocket`; WS uses the installed Node `ws` server on an
`http.Server`, bypassing Bun's substitution). MQTT's `handleApplication` registers WS on the default
port before REST's `httpServer()` call for it, so `httpServers[port]` is already a Node server and
`getBunHTTPServer` early-returns without a serve config. `listenOnPortsBun`'s trailing "non-HTTP
servers" loop binds that server; only the exclusive operations port reaches `Bun.serve`. So on Bun the
`Request`/`Response` fetch path is dead code for the main port, and its divergences show up as
`node:http`-emulation divergences instead.

One such divergence, `#2210`: Bun's `node:http` never derives keep-alive from the request. For a
`Connection: close` request `shouldKeepAlive` stays `true`, and neither a `Connection: close` response
header nor `response.socket.end()` closes the connection — a **stream-ended** response (an async
source ended through `pipeline()`; a direct `response.end()` is fine) delivers its full body and
terminal chunk, then holds the connection until Bun's own idle timeout — a chunked-aware client
completes the message and can walk away, but the un-honored close still violates RFC 9112 §9.6 and
strands the socket; a raw client waiting on the FIN (and the HTTP/1.0 case below, which has no
terminal chunk to stop at) hangs outright. An HTTP/1.0 client hangs the same way
without asking to close at all, since 1.0 persistence needs both an explicit `keep-alive` and a length
to read to — so a 1.0 response that got no `Content-Length` is close-delimited, the same line Node
draws (Node closes it at ~7ms; Bun never does). An explicit `close` token wins over `keep-alive` on
both versions. A 1.0 `keep-alive` request whose response _did_ get a
`Content-Length` (`body.size` on a blob — the `body instanceof Blob` branch of `getHTTPServer`'s request handler) is left open, as on Node.

`pipeBodyToResponse()` therefore ends `request.socket` itself for those shapes
(`endConnectionIfClientExpectsClose`, `isBun`-gated, HTTP/1 only, clean path and a pre-header error
response — an aborting error path already closes because the response is destroyed with the stream error). Ending the
_request's_ socket is the only remedy that works after a clean stream end on Bun: a `Connection:
close` response header, `response.socket.end()` and `response.destroy()` were all measured as no-ops
there. `socket.end()` is graceful, so it does not truncate — 8 MB over plain TCP and 6 MB over TLS to
a deliberately slow reader each arrive whole. The
`Content-Length` check reads `response.hasHeader()`, which Bun populates from the `writeHead(status,
headers)` fast path this file uses (Node does not, but the branch is Bun-only). A
keep-alive arm pins the other direction (such a client keeps its connection and reuses it); the two
HTTP/1.0 arms are Node/Bun-only, because uWS does not route an HTTP/1.0 request to the resource at
all.

`listenOnPortsBun`'s loop binds the main port without `reusePort`, and Bun's `http.Server.listen` drops
the option outside a `node:cluster` worker anyway: the others swallow `EADDRINUSE`, and
every request on the port, WebSockets included, runs on one worker whatever `threads.count` is.

## Per-worker UDS mirrors are separate server instances — port-keyed wiring does not reach them (`server/http.ts`)

With `tls.unixDomainSockets: true`, every secure port gets a per-worker cleartext mirror
(`<worker>-<port>.sock`) so a fronting proxy (symphony) can terminate TLS and route to a specific
worker. The mirror is a **separate** `http.Server` instance registered in `SERVERS[udsPath]` — it is
_not_ `httpServers[port]` — so anything wired by port key (upgrade listeners, uWS `wsHandler`,
mTLS flags, socket options) must be explicitly propagated to it. `getHTTPServer()` exposes the
mirror as `server.udsMirror` (Node) / `server.udsMirrorUwsConfig` (HARPER_UWS_UDS) for exactly this;
`onWebSocket()` uses those to attach the `'upgrade'` dispatch and uWS `wsHandler`. Two lessons paid
for in production (WS handshakes died with a zero-byte close on the mirrors while SSE worked):

- An HTTP server with **no** `'upgrade'` listener destroys WebSocket upgrade sockets with no
  response and no log, which makes a missing listener look like a network problem. Plain Node would
  hand such a request to the `'request'` listener instead; Harper's
  `IncomingMessage.prototype.upgrade` override (no-op setter, `http.ts`) defeats that fallback on
  every thread that loads `server/http.ts`, including for servers an application creates there.
  Pinned in `unitTests/server/serverGlobalCallerImpact.test.js`.
- `enableProxyProtocol()`'s data interception must hand the socket **back to the original
  listeners** once the PROXY header decision is made (it re-attaches them and removes its wrapper).
  A permanent wrapper breaks protocol handoffs: Node's upgrade path removes its parser's `'data'`
  listener _by reference_ before ws takes over, so a lingering wrapper keeps feeding the freed HTTP
  parser — which the parser pool can re-issue to another connection, injecting one connection's
  WS frames into another's request stream (`Parse Error: Data after 'Connection: close'`).

The h2c mirror (`HARPER_H2C_UDS`) is exempt: HTTP/1.1 `Upgrade` doesn't exist in h2, and the
fronting proxy routes WS to the h1 mirror by ALPN.

Known limitation on uWS-served transports (`HARPER_UWS_HTTP` ports, `HARPER_UWS_UDS` mirrors):
uWS accepts WebSocket handshakes natively in `app.ws()`, so `server.upgrade()` middleware never
runs pre-handshake there (auth is unaffected — it runs in the WS connection chain on both paths,
matching Node's upgrade-then-authorize order). No core component registers custom upgrade
middleware; `onUpgrade()`/`installUwsWsHandler()` warn when one is registered for a uWS-served
port so the gap is visible instead of silent.

While an isolated application's mirror is down the proxy falls back to the pool, so a shared worker answers that
application's root-config host with 503 rather than another application's routes (`server/isolatedHostGuard.ts`).

## A request-queue shed is a 503 the server never logged (`server/throttle.ts`)

`throttle()` sheds a queued call once `queuedCalls.length × averageEventCycleTime` exceeds the limit (20s by default). `server/http.ts` answers it directly with `Service unavailable, exceeded request queue limit` and records only an analytics action; nothing is thrown, so the HTTP error path that logs every thrown status (`info` for a 503, `warn` for a 500) never runs, and the `DatabaseTransaction` write-queue and conflict 503s log at `error` (once per stuck commit, rate-limited) as well as `info` when thrown. A 503 with that exact body and the `service-unavailable` action comes only from `throttle()` or `rejectWhenLoopDelayed`; each writes a rate-limited `warn` per instance naming its queue (`HTTP request queue on port …` vs `HTTP read admission on port …`), and `resources/Table.ts`'s cache-resolution throttle throws its own 503 under the same warn. The gate is per instance on purpose: a shared one let a cache-fill shed silence the HTTP shed that followed. Reproduce with a large concurrent non-GET burst on one CPU-starved worker (`integrationTests/resources/sourcedfrom-eav-cache-coherence.test.ts` P1 under Bun pinned to a contended core).

## The request-queue throttle sheds only on cycles from the current backlog (`server/throttle.ts`)

The cycle-time average behind each shed decision is per `throttle()` instance and returns to 0 when that queue drains, so an earlier backlog's or another throttle's slow cycle cannot shed this one ([#3200](https://github.com/HarperFast/harper/pull/3200)). A new backlog ramps from 0, like a new process. Enforced by the stale-backlog and two-instance cases in `unitTests/server/throttle.test.js`.

## HTTP reads are rejected on event-loop delay, never queued (`server/http.ts`, `server/throttle.ts`)

GET/HEAD/OPTIONS go through `rejectWhenLoopDelayed`: an admitted read runs synchronously in the call that received it, and a read arriving after the current event-loop iteration has run longer than `http.readRequestQueueLimit` (default 5000ms, `false` = off) gets a 503 without running its handler. Writes keep the `throttle()` queue (`http.requestQueueLimit`); native `Bun.serve` listeners still dispatch writes immediately. Queuing reads cost 7–16% of cached-read throughput because `throttle()` dispatches one queued call per iteration. The iteration start comes from one `setImmediate` probe per thread, shared by every listener (the delay belongs to the loop; each listener applies its own limit). Every read marks activity, so the probe re-arms from the check phase while reads keep arriving and then measures whole iterations, including timers and async continuations before the first read. One read-free iteration stops it: an idle worker has no wakeups and no stale sample. The cost is that the first read after idle cannot see a stall that ended before it arrived. Only the current iteration counts, not the previous one, so after a one-off stall the next iteration's reads are served rather than shed; under sustained overload each iteration admits about the limit's worth of work. `readRejectionHeaders` applies the configured response and CORS headers without running authentication. A 503 OPTIONS preflight still fails browser CORS. The one `http` key governs every listener, operations API included: `operationsApi.network` has no registered copy of it. The 503 callbacks run outside the handler's error handling, so their CORS inputs must be valid header values: `validation/configValidator.ts` checks `corsAccessControlAllowHeaders` and `readRequestQueueLimit` on `http`, then `effectiveHttpConfigValidator` checks them again on the `flattenConfig()` output, because flattening lowercases keys and merges `customFunctions.network` over `http` after validation. `unitTests/server/httpRequestQueue.test.js` enforces synchronous dispatch, rejection without handler entry, warm/cold probe behavior, the shared probe with per-listener limits, and the headers. `integrationTests/server/request-queue.test.ts` covers Node, uWS and native Bun.

## A streamed response is completed only when its source ends cleanly (`server/http.ts`, `server/serverHelpers/uwsServer.ts`)

A response stream that fails after its first byte has no status left to report the failure with. The only signal HTTP/1.1 has is an incomplete message: the connection closes without the chunked terminator. So each transport sink ends the response for a source `'end'` and aborts the connection for anything else — a source `'error'`, or a `'close'` with no `'end'`. Ending cleanly instead hands the client a truncated body framed as a complete 200; formats that truncate at a record boundary (CSV, NDJSON, a msgpack sequence) then parse as a valid shorter result.

Node gets this from `stream.pipeline` in `pipeBodyToResponse`, except for a body whose head is still unwritten when it reaches the sink (static's `send()`, an unknown-size `Blob`). A failure before its first byte still has a status to report, and `pipeline` would destroy the response instead, even after the error response was ended (a large error body is cut off). So `pipeBeforeHeaders` owns that pipe: a source `'error'` is answered with the error's own 4xx/5xx status (else 500) and its `error.headers` (never a `Content-Length`, which would not describe the replacement body), drops the entity headers the body staged, sets `Cache-Control: no-store`, and sends the message only of a `ClientError` or an error that sets `expose` (a blob or filesystem error can name a path); the connection aborts as above once the head is committed. For these bodies the response outcome is recorded on `'close'` from `nodeResponse.statusCode`, so an aborted request keeps the status it started with. uWS has no Writable to pipe into, so `streamResponse` wires the events itself and calls `res.close()`, which also runs `onAborted` and aborts the request signal. It also checks `source.destroyed`: the uWS handler resolves asynchronously, so a source can be destroyed, and its `'close'` already emitted, before the sink listens for it — the response would stay open forever. The `'error'` listener goes on before that check, because `destroy(error)` emits on a later tick and an `'error'` with no listener is thrown. Under Bun the main port is a `node:http` server and takes the `pipeBodyToResponse` path; the `Bun.serve` fetch handler buffers a stream body before it responds, so a failed source there is an ordinary error response.

This is the transport's fallback, not the error contract. SSE and NDJSON GETs hold their first step so an immediate failure is still an HTTP status, and they report later failures in-band ([Streaming startup errors](#streaming-startup-errors)). Every other format commits when the handler returns the stream, so a failure before its first chunk aborts the connection too. Pinned by `unitTests/server/serverHelpers/uwsServer.test.js` ("a response stream that does not end cleanly"), `unitTests/server/static.test.js` for the Node pre-header answer and, end to end on every runtime leg, by `integrationTests/server/response-compression.test.ts`.

## A static entry whose file is gone is a miss, not an error (`server/static.ts`)

`staticFiles`/`indexEntries` are watcher snapshots: a file can vanish before its unlink event, and a symlink target removed outside the watched tree (`followSymlinks: false`) never emits one. `resolveExisting` turns `ENOENT`/`ENOTDIR` from the handler's `realpathSync` into a miss, which takes the ordinary `fallthrough` / `notFound` / built-in-404 path. A throw there would reach `onError` as a 500 whose body names the absolute path. Other errnos still propagate (a request with deferred failed credentials still gets its 401 first). Entries are deliberately not evicted: a restored symlink target serves again with no event. The deferred credential rejection is settled only after resolution succeeds, so a miss that falls through leaves it for the downstream owner. A missing `notFound` file answers the built-in 404 (not its configured status) and warns once per path until the file reappears.

Not covered: only the finally selected candidate is resolved, so a vanished direct match does not retry `extensions`, and a stale index redirect still answers 301. A file removed after resolution fails inside `send`, where `pipeBeforeHeaders` handles it on the Node stack.

## A coarse uWS 413 drains a closing upload before ending the response

uWS force-closes a completed `Connection: close` response while an upload is still arriving, which can lose its status to EPIPE. `uwsServer.ts` flushes a non-empty coarse-limit 413 chunk before discarding bytes until body end or a one-second deadline; that absolute resource bound guarantees early status, not complete framing for a sender that ignores it. Destroying a paused Readable does not clear its queue, so teardown removes data listeners and reads out queued bytes in bounded chunks before retaining the response. Native abort disarms the finisher independently of handler cancellation. "uWS oversized TCP uploads" in `unitTests/server/serverHelpers/uwsServer.test.js` pins these paths and unchanged immediate keep-alive rejection. Other rejection sites, including downstream responses from `contentTypes.ts`'s default 10 MB limit, still end immediately and remain outside this coarse-cap correction.

## `request-time` starts at dispatch entry (`server/http.ts`)

`duration` starts at `requestHandler` entry, so the non-GET throttle queue is invisible to it. Every request that goes through the throttle, whether or not it waited, gets `receivedAt`, a `performance.now()` taken in `dispatchRequest` on the Node servers and in the uWS handler before it is queued, and `request-time` is recorded for it next to `duration` with the same key and `endTime`, by the HTTP response path or, for a request handed to Fastify, by `requestTimePlugin.ts`; a uWS request injected into Fastify keeps no stamp and records `duration` only. GET, HEAD and OPTIONS are handled in the same synchronous call, and Bun.serve has no queue, so neither records `request-time`: it would equal `duration`. The difference between the two metrics is the server-side wait before the handler: the throttle queue and, for a request cascaded to Fastify, the Harper chain that ran before the cascade, such as authentication for operations requests. The event-loop wait before a request is read is `event-loop-delay`'s, per thread, within a report window: the histogram resets when a window opens after an idle gap, so a stall during that gap, before any request of the window arrived, is not reported; a stamp taken from the HTTP parser cannot see it, because a consumed parser runs inside the socket read callback, and only adds the client's header-transmission time.

## HTTP request preconditions (`REST.ts`, `Table.ts`)

`preconditions.test.js` and `http-preconditions.test.ts` enforce RFC 9110 ordering: successful GET/HEAD responses use strong `If-Match`, weak `If-None-Match`, and whole-second HTTP dates; 304 retains validators, closes the producer and skips serialization when validators describe materialized data. Lazy GET and HEAD reads settle their startup authorization/error gate first. A lazy read's `ETag`/`Last-Modified` come from `context.lastModified` after that startup (a producer may set its version on its first step), set only where the resource supplied none; JSON, CBOR, msgpack, CSV and plain-text streams have no startup phase and start after headers (the last four open their source on the first read, through `openOnFirstStep`, and connect their CSV and brotli pipe hops then, `pipelineOnRead`, whose destroy reaches the source in the same turn, so a discard finds the source unopened: `REST-discard-cbor-csv.test.js`), and SSE is a CONNECT subscription rather than a read, so for those only a version known before serialization reaches the validators. Validators describe the read when headers commit, not rows streamed later. Every discarded read (HEAD, 304, 412) goes through `discardReadResponse` exactly once — HEAD evaluates deferred preconditions first and skips only a 304 a precondition check built after discarding (a resource's own 304 still gets discarded) — which closes the source: its `onDone()`, or else `return()` on a fresh, unstepped iterator unless the body is a startup stream (NDJSON, SSE), whose own `return()` closes the source opened or not (`closesSourceOnDiscard`). That fresh close is the only one a JSON/CBOR/msgpack HEAD's never-started serializer leaves, and how a `.map()` of search results releases their read snapshot. Cleanup failures it sees, thrown or rejected, are logged, never the response status; extended-iterable's `map().return()` drops its source's close promise, so a rejection there reaches the process handler instead. An async generator runs `return()` only after a pending first step settles — the same lifetime as a GET discarded after startup (`deferred-read-preconditions.test.ts`, `REST-deferred-reads.test.js`). Errors take precedence. The ETag encoding is unchanged. `rest.preconditions: false` leaves conditional handling to application code.

Conditional table PUT/PATCH/DELETE carries a transient `WRITE_CONDITION` on the request context. `Table.getResource` binds it to the parsed/coerced single-record target. Mutation authorization and body resolution precede `_writeUpdate`/`_writeDelete`. By default (`rest.preconditionLocks: true`), RocksDB acquires a default-scope **hold** lock (`table.lock(id, { hold: true })`), drops any pre-lock read snapshot when no prior writes are staged, reloads the record under the lock, and evaluates `If-Match` / `If-None-Match` / `If-Unmodified-Since` **once** before staging any write. A false predicate throws 412 immediately with no write staged or logged; an accepted write stages normally and any native commit retries proceed unconditionally. REST releases the hold after the transaction commits or aborts. Lock failures retain the existing 423 timeout, 409 expired-lease and 503 unavailable statuses. The lock takes the default scope, never a forced `scope: 'node'`. Among conditional contenders that saw the same validator there is one winner: cluster-wide when cluster record locks are available, node-local where no lock transport is registered. On `harper-pro` without `replication.recordLocks`, conditional writes to replicated tables take the unlocked pre-check below, not the lock's 503: that transport sets `ClusterLockTransport.disabled`, which `Table.getResource` reads at binding. There is deliberately no fallback to node scope there, since a node-local winner would silently weaken the guarantee on a cluster. Enabled locks with no home map still fail with 503. This is not a general compare-and-swap: plain writes are never gated and still resolve last-write-wins, and the version checked under a cluster lock is only as fresh as `lock()`'s exclusion-only contract promises ([`record-locks.md` §10](../resources/record-locks.md#10-cost-and-the-guarantee-decision)). The lock is taken through the target record's own `lock()`, but it changes only what the predicate needs: `lockConditionalWrite` marks the condition `acquiring`, and the same-key `#reloadLocked` it runs refreshes the entry and stores the handle; a pending tracked write keeps its changes and the record view it was made against (a full replacement's cleared one too), and the record does not become lock-writable. While the lock is pending, the deferred write holds the record's `#savingOperation` slot as a `ConditionLockWait`, so `save()` waits for it and `addTo()` treats it as the write in flight — a tracked `loadAsInstance` handler (`this.addTo(...); return this.save()`) behaves as on the unlocked path, closing after `save()` included (`preconditions.test.js` › "conditional writes through a tracked record instance").

Setting `rest.preconditionLocks: false` (or running on LMDB, which has no `lock()`) performs a best-effort single pre-check against the record at the start of the request without locking: if it passes, the write is staged as a plain write with no commit-time predicate, so concurrent requests that saw the same ETag both return 2xx and LWW picks the winner. Preconditions are evaluated at most once per request before the first native commit attempt and are never re-evaluated in `DatabaseTransaction` or `LMDBTransaction` retry loops — once a write reaches the transaction log, nothing aborts it on retry. A conditional no-op (`PATCH {}`) checks the predicate before `validate` drops the empty write, minting no version or audit entry. Write permission does not require read permission; dates have second precision, so use ETags for version-level concurrency.

Harper evaluates write preconditions for table classes only. A resource that is not a table, or a table class that sets `static preconditions = false`, receives `If-Match`/`If-None-Match` in its request headers and evaluates them itself, as on 5.3; one that ignores them gives no protection, as it never did. Answering those resources with 501 broke every application that implemented optimistic concurrency in its own resource (harper#3730). A table class that overrides the static PUT, PATCH or DELETE gets an _optional_ condition, bound to the request's record (its id parsed and coerced as `Resource` parses a target; an id that parse rejects leaves the condition unbound): when the verb's table operations reach that record — passing the target on or naming its id, directly or through a base table class — Harper locks and checks the write there, and lookups or batch writes of other records first do not claim it. If the verb never reaches the record, or the HTTP class's representation is one Harper cannot check (below), the condition is declined and the request proceeds with the headers unevaluated. An overriding static POST receives the headers unevaluated. Its cost: a table class that mints its own ETags and still delegates to the table gets Harper's 412 against the record version, so it must opt out. When the inherited table verb handles the request (the class does not override it), conditional mutations require the default whole-record table representation: a POST to that verb, collections, array bodies, property/projection paths, source-backed tables and custom GET representations return 501. A representation assembled from several records has no single stored version to validate atomically here; authorization hooks that load newer records can also produce composite GET validators, which cannot match the single-record write predicate. Such representations require an application-specific protocol through the explicit opt-out. A table verb that stages no matching write for its required (non-optional) condition aborts instead of ignoring it: any non-error reply it returns or throws becomes 501. A thrown `Response` is judged by its `status`, any other thrown value by the status the catch would send, and a rejected Response body is cancelled. Admission seals when dispatch settles, before the commit; the finished context keeps its condition as a tombstone, so deferred target writes cannot resume unconditionally. Predicates are never encoded into records or audit/replication entries. The read/search QUERY extension bypasses the conditional-mutation gate.
