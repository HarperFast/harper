# server/ — Navigation Guide

This layer accepts inbound traffic on every supported protocol (HTTP/1.1, HTTP/2, HTTPS, WebSockets, MQTT, NATS) and routes it through to the Resource layer.

**Read this when:** you're touching request/response, protocol handling, middleware ordering, or WebSocket upgrade behavior.

> **Navigation convention.** This guide references code by **symbol name** (function/const). Use your editor's go-to-symbol or `grep -n '<name>' server/<file>` to jump. Line numbers drift; symbols don't.

---

## Three HTTP stacks coexist — know which one

| Stack                         | File                  | Used for                                                                                                                                                                                        |
| ----------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Native**                    | `http.ts`             | Direct socket handling for application-level HTTP/1.1, HTTPS, HTTP/2, and WebSockets. Highest performance. This is the path most user requests take (REST, GraphQL, custom resource endpoints). |
| **Operations API**            | `operationsServer.ts` | Fastify-based JSON operations API (`{operation: 'create_table', ...}`). Internal/admin surface — not on the hot path for application data.                                                      |
| **Custom Functions (legacy)** | `fastifyRoutes.ts`    | Legacy custom functions only. Wraps Fastify with autoload. Don't add new code here.                                                                                                             |

A request entering `http.ts` does **not** go through Fastify. The two `handleApplication(scope)` functions (one in each Fastify file) load independently from component config.

---

## File overview

### Core dispatch

| File                             | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Server.ts`                      | Defines the `Server` interface — the contract that protocol plugins use to register listeners. Has `socket()`, `http()`, `ws()`, `upgrade()`, `contentTypes`, `getUser()`, `operation()`, `replication`, etc.                                                                                                                                                                                                                       |
| `http.ts`                        | Native HTTP/WS server. Registration entry points (`onRequest`, `onUpgrade`, `onWebSocket`), per-port middleware chains, UDS support, PROXY protocol. **See section map below.**                                                                                                                                                                                                                                                     |
| `middlewareChain.ts`             | Topological sort respecting `before`/`after` constraints on listener registrations (`topoSort`). Falls back to registration order on cycle. Also `urlPath`/`host` sub-route dispatch: a mount is a prefix with a segment boundary, the mount prefix is stripped from `request.pathname` before the sub-chain runs, and the root mount `'/'` normalizes to _no_ path constraint (joins the default chain, nothing stripped — #1766). |
| `REST.ts`                        | Resource-routed REST handler: URL → `Resource.getResource()` → method dispatch + content negotiation.                                                                                                                                                                                                                                                                                                                               |
| `graphqlQuerying.ts`             | GraphQL query/mutation/subscription execution against Resources.                                                                                                                                                                                                                                                                                                                                                                    |
| `mqtt.ts`                        | MQTT broker (connect/sub/pub mapped onto Resource interface).                                                                                                                                                                                                                                                                                                                                                                       |
| `DurableSubscriptionsSession.ts` | Persistent subscription state (resume across reconnects).                                                                                                                                                                                                                                                                                                                                                                           |

### Operations & Fastify

| File                  | Purpose                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `operationsServer.ts` | Boots Fastify for operations API. `buildServer()` constructs the server; `handler()` parses `{operation: ...}` and dispatches. |
| `fastifyRoutes.ts`    | Legacy custom functions. Discovers routes from each component's `routes/` folder.                                              |

### Helpers

| File                                       | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `serverHelpers/Request.ts`                 | Wraps `IncomingMessage` with Harper-specific fields (user, response, headers).                                                                                                                                                                                                                                                                                                                                                                         |
| `serverHelpers/Headers.ts`                 | Header mutation/merge utilities.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `serverHelpers/contentTypes.ts`            | (de)serialization registry; `serialize`, `serializeMessage`, `getMessageSerializer`, `getDeserializer`.                                                                                                                                                                                                                                                                                                                                                |
| `serverHelpers/sharedMessageEncoding.ts`   | Per-message encoding shared across the subscribers of a topic — one serialization per (message, content type) and, for MQTT QoS 0, one PUBLISH packet per (payload, topic, protocol version). Keyed on the message object, which `transactionBroadcast` dispatches by identity to every subscription of a key. **Identity contract:** see below.                                                                                                       |
| `serverHelpers/serverUtilities.ts`         | `OperationDefinition` and shared helpers.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `serverHelpers/OperationFunctionObject.ts` | Wraps an operation handler with metadata.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `serverHelpers/JSONStream.ts`              | Streaming JSON output for large responses.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `nodeName.ts`                              | Resolves this node's name (config → hostname).                                                                                                                                                                                                                                                                                                                                                                                                         |
| `static.ts`                                | Static file serving for component-bundled assets.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `throttle.ts`                              | Event-loop backpressure: queues non-GET request handling one call per `setImmediate` cycle and sheds with 503 once queue depth × average cycle time passes the limit.                                                                                                                                                                                                                                                                                  |
| `storageReclamation.ts`                    | Disk-pressure signals to downstream consumers; `getStorageSpaceStats()` is the shared quota-aware (falls back to `statfs`) source of available/free/size storage numbers — used by `Table.getStorageStats()` (#1976). NOT used for blob storage path weighting (`resources/blob.ts`): quota-status.json is a single instance-wide figure, so it can't distinguish between multiple `STORAGE_BLOBPATHS` disks — that still needs raw per-path `statfs`. |
| `serverRegistry.ts`                        | Trivial registry export.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `status/`                                  | Server status reporting (cluster status, per-port info).                                                                                                                                                                                                                                                                                                                                                                                               |

> **Subscription message identity contract.** `sharedMessageEncoding.ts` encodes a message once and
> reuses the bytes for every subscriber of the topic, keyed on the message object's identity. That is
> sound for every internal producer because each yields a fresh object per version — `transactionBroadcast`
> hands one `auditRecord` to every subscription, `auditStore`'s `getValue` memoizes the decode in its
> closure, and `primaryStore.getEntry` is version-guarded — so identity implies equal content. Pinned by
> `unitTests/resources/subscriptionValueIdentity.test.js`.
>
> Rather than leave that as a rule custom Resources have to know, the event's record `version` is part
> of the cache key: `DurableSubscriptionsSession` forwards it to the delivery listener, and an entry
> whose version does not match is re-encoded. A Resource that reuses one envelope but advances the
> version is therefore correct, not merely disallowed; one that supplies no version is not shared at
> all. Only mutating an object _without_ changing its version can serve stale bytes, and that is
> indistinguishable from re-sending the same message.

### Threads

| File                       | Purpose                                                  |
| -------------------------- | -------------------------------------------------------- |
| `threads/socketRouter.ts`  | Routes accepted sockets to worker threads based on port. |
| `threads/manageThreads.js` | Thread pool lifecycle.                                   |
| `threads/threadServer.js`  | Worker entry point — receives sockets via IPC.           |
| `threads/itc.js`           | Inter-thread comms primitives.                           |
| `transactionLogCooling.ts` | Main-thread timer that cools transaction-log mmaps.      |

Process-wide shutdown begins by calling `beginProcessShutdown()` in `threads/manageThreads.js`.
Once set, this terminal state prevents every worker replacement path and makes new `startWorker()`
calls fail with `ERR_HARPER_PROCESS_SHUTTING_DOWN`; scoped worker-type restarts do not set it.
`shutdownWorkersNow()` remains an immediate teardown: its worker shutdown messages are best-effort,
and it force-terminates the remaining worker set rather than waiting for application drain hooks.

A rolling restart serves the _old_ code until each worker is replaced, and where the OS grants
`SO_REUSEPORT` the not-yet-replaced workers keep accepting connections for the whole restart — so a
component deploy is not live pool-wide until `restartWorkers()` resolves. For the overlapping types
(HTTP) it waits for each replacement to report `CHILD_STARTED` — including the ones that can only be
started after their predecessor releases its exclusive ports (Windows/macOS/Bun) — and reports how
many workers it left on the old code because a replacement never came up, versus how many
replacements never started after their predecessor was already gone. Other thread types start their
replacement without being awaited. Each wait is bounded by a per-worker startup backstop, so
resolution means "the restart finished", not "every worker is new". A caller that treats its own success as
"the component is live" must await it (see `deployComponent` in `components/operations.js`).

> Workers receive `workerData.noServerStart = true` — never start the server inside a worker.
>
> `threadServer.listenOnDomainSocket()` skips a listener only when its path exceeds the platform's
> `sockaddr_un.sun_path` byte limit (some Node versions reject it; others silently truncate it).
> Every actual `listen()` error rejects startup, and the temporary bind-error listener is removed
> once the socket is listening.

### Where periodic maintenance runs (main thread vs last worker)

Single-instance background tasks pick their thread by what state they touch:

- **Last worker** (`getWorkerIndex() === getWorkerCount() - 1`) — for tasks that operate on **worker-resident JS state**: audit cleanup (`resources/auditStore.ts`) and disk reclamation (`storageReclamation.ts`) walk per-store objects that only exist in a worker.
- **Main thread** (`isMainThread`) — for tasks that drive a **process-global native singleton** and need no JS state. `transactionLogCooling.ts` is the example: rocksdb-js's transaction-log registry is one C++ static shared across all worker threads, so any thread cools every log. The main thread is chosen because it is the only thread that lives for the whole process — a worker-driven timer would stall whenever that worker is recycled.

---

## `http.ts` — symbol map

Every entry is a top-level function or named const. Jump via go-to-symbol or `grep -n 'function <name>' server/http.ts`.

| Symbol                                                                                                                                   | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registerUdsCleanupPaths`, `recordUdsBindSuccess`, `cleanupUdsFiles`, `markUdsBindFailed`, `writeUdsMetadata`, `cleanupSocketsDirectory` | UDS socket / metadata file lifecycle. Ownership-aware: `recordUdsBindSuccess` captures the inode a worker's own bind confirmed; `cleanupUdsFiles`/`markUdsBindFailed` only unlink a path when the inode on disk still matches, so an overlapping restart's outgoing worker can never delete the replacement that already rebound the same path (see restartWorkers() in manageThreads.js). `cleanupSocketsDirectory` is the separate crash-path sweep, run once from `socketRouter.ts`'s `startHTTPThreads` on main-thread startup, before any worker can bind.                                                                                                                                                                                                                                     |
| `handleApplication(scope)`                                                                                                               | Component entry point — captures `httpOptions` for the scope.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `getHttpOptions()`                                                                                                                       | Returns the current scope's `HttpOptions`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `deliverSocket()`                                                                                                                        | IPC-delivered socket handoff from `socketRouter`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `proxyRequest()`                                                                                                                         | Cross-port request routing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `registerServer()`                                                                                                                       | Records a server for a port in the `SERVERS` map.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `getPorts()`                                                                                                                             | Resolves listener options → list of `{port, secure}`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `httpServer()`                                                                                                                           | Main listener registration entry point.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `getHTTPServer(port, secure, options)`                                                                                                   | **The largest function in the file.** Creates/retrieves the underlying Node HTTP/HTTPS server. Wires `request`, `upgrade`, error handlers, TLS context, and the per-port middleware chain.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `makeCallbackChain()`                                                                                                                    | Builds the per-port handler chain via `middlewareChain.topoSort`, and records its resolved order for `get_status`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `buildChains()`                                                                                                                          | Stores a built chain, and rebuilds every other already-built chain of that kind when the registration is on the `'all'` pseudo-port. See "Middleware ordering" below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `unhandled()`                                                                                                                            | Terminal 404 handler.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `onRequest()`                                                                                                                            | Thin alias of `httpServer({requestOnly: true})`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `onUpgrade()` / `upgradeListeners` (const)                                                                                               | Register HTTP upgrade listener; underlying list.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `onWebSocket()` / `websocketListeners` (const)                                                                                           | Register WebSocket listener; auto-adds default upgrade handler the first time it runs for a port. Underlying list of registrations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `enableProxyProtocol()`                                                                                                                  | PROXY v1/v2 stripping on UDS mirrors (Node 24+-compatible workaround). Decoding lives in `serverHelpers/proxyProtocol.ts`; v2 TLVs forward the client source address plus the connection's TLS facts a fronting proxy (symphony) observed — ALPN, SNI authority, TLS version/cipher, JA3/JA4 fingerprints, and the mTLS client cert chain. These are surfaced on `request.connectionInfo` (see below); the verified cert chain is additionally exposed with TLSSocket semantics (`authorized`, `getPeerCertificate()`) so HTTP/MQTT mTLS auth works unchanged, and the SSL TLV lets `request.protocol` report `https` on the plaintext UDS mirror. A peer that stalls mid-header is destroyed after `prehandoffTimeout` (default 10s), matching `withProxyProtocol`'s guard on the raw-socket path. |
| `defaultNotFound()`                                                                                                                      | Default 404 response.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `logRequest()`                                                                                                                           | Per-request access log line.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `getRequestId()`                                                                                                                         | Generates the per-request correlation ID.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

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
- A plugin registering per-mount state must key it on `Scope.routeFor()`'s resolved route, not on the parts it composes from — distinct `(mount, pluginUrlPath)` pairs can flatten to the same string (`/a`+`bc` and `/ab`+`c`). `REST.ts`'s `startedMounts` does this; it replaced a process-global `started` flag that silently 404'd the second mounted application's REST API. `handleApplication` also closes over `resources`/`httpOptions` per call rather than a module-level var, and skips deploy pre-flight validation scopes (`scope.isTransientValidation`) entirely — registering handlers from a throwaway validation scope would splice a validation run into the live request path and permanently mark that mount started, silently skipping the real scope's later registration.
- A mount is routing, **not** isolation: exported resources stay instance-wide, and a `host` mount cannot constrain legacy fastify routes — `fastifyRoutes.ts` refuses to load (throws) rather than warn when a `host` mount is configured, since the fallback really is reachable on every host.
- An invalid mount (unparseable `host`/`urlPath`) fails the application **closed**: `componentLoader.tryRootConfigMount` skips loading it entirely rather than falling back to unmounted access — loading unconstrained would silently drop the isolation the operator asked for, which is worse than not loading at all.
- Two applications mounted at different routes can register same-named middleware (e.g. both enable `rest`) without colliding: `middlewareChain.resolveRoutedChains` resolves `before`/`after` name references against a registry scoped to that route's own group, falling back to a _global_ registry that only holds genuinely unmounted entries (e.g. `authentication`) — never another mounted route's entries.
- `host` matching reads `request.host` (Harper's `Request.host` getter), not the raw `Host` header — HTTP/2 clients send `:authority`, never `Host`, so reading the header directly silently 404s every host-mounted app under h2 while h1 keeps working. `hostnameFromHeader` also strips a trailing dot (`api.example.com.`, the absolute-FQDN form some resolvers emit) since it names the same origin.
- `scopeMount.normalizeMountHost` validates against the same grammar as the `deploy_component` operation's `host` field (bare DNS hostname or IPv6 literal) and throws otherwise, so a hand-typed root-config `host` with a port/scheme/path fails the application closed too, instead of loading it unreachably. `nestScopeMount` logs a warning when a child's `host` is discarded by the parent-authority rule, so that isn't silent.

---

## Operations authorization boundary

Operations request bodies are untrusted data. `serverHandlers.js → handlePostRequest()` rejects
prototype-mutating property names and strips the legacy `bypass_auth` property before dispatch.
`serverUtilities.ts → chooseOperation()` never reads authorization control from the body: trusted
internal callers pass bypass state as a separate argument and expose it to operation handlers only
through `operationAuthorizationState.ts`'s async context. When an operation registered by a component
must run on a worker, `registeredOperations.ts` carries that state in the same-process ITC envelope,
separately from the structured-cloned body. Never attach trusted dispatch state to an operation
payload.

`server.registerOperation()` runs per-worker, so anything the **main** thread must later know about a
registered op has to ride the OPERATION_REGISTERED announcement — a module-local registry populated
during registration exists only in the worker that registered. The bridge carries two such facts
today: name→thread routing (for execution forwarding) and `grantable` (so `validateOperations` on
main will accept the name in a role's `operations` allowlist, for add_role/alter_role, impersonation,
and OIDC trust policies). Adding a third main-thread consumer of a worker-registered fact means
extending that message, not reading a registry that main never populated. Grantability is safe to
mirror because it only widens what an allowlist may _name_; enforcement stays on the worker's
`chooseOperation`.

## Resource ↔ HTTP boundary

`REST.ts → http(request, nextHandler)` is the chief integration point: it takes a `Request`, asks the `Resources` registry for a match, builds a `RequestTarget`, and dispatches into the Resource class's static method. Cache headers are translated to `request.expiresAt` / `onlyIfCached` / `noCache` flags within the same function.

### Streaming startup errors

SSE and NDJSON serializers eagerly take and hold their first iterator step for GET requests. `REST.ts` waits through the next event-loop turn for that step: an immediate rejection remains an HTTP error rendered as Problem Details, while a first item or the cutoff commits the stream. Mutating requests do not use the startup-status gate because their transaction has already committed by this point; all of their stream failures use the in-band form. Later GET failures are terminal, format-valid records (`event: harper-error` for SSE and a reserved control record for NDJSON). Keep the decision in the serializer/REST boundary so Node, uWS, Bun, compression, and injection share one contract; transports must not independently prefetch the iterator.

SSE terminal event data uses `{ error: <code-or-class>, message: <message>, status?: <status> }`; NDJSON wraps the same object as `{ "$harperStreamError": { ... } }` so it cannot be mistaken for an ordinary row with an `error` field.
Sources with `mapError` remain unmapped for these two formats so their failures reach this single contract instead of becoming legacy data records.
generic JSON-array streaming retains its older `{ error: "<name>: <message>" }` element shape.
The `error` value is the stable programmatic discriminator; `message` is diagnostic and follows the same thrown-message exposure policy as pre-commit Problem Details.

Clean stream completion does not prove completeness; clients must inspect SSE for the `harper-error` event and NDJSON for the `$harperStreamError` control record.

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

| Tagged rejection                                                   | Where                                      |
| ------------------------------------------------------------------ | ------------------------------------------ |
| unknown user, inactive user, bad password                          | `security/user.ts → findAndValidateUser()` |
| JWT syntax, signature, expiry, not-before, subject/claim rejection | `tokenAuthentication.ts → validateToken()` |
| refresh-token hash mismatch, malformed scoped-token claims         | `tokenAuthentication.ts`                   |
| an `Authorization` scheme Harper does not implement                | `security/auth.ts`                         |

`validateToken()` separates the two in the same catch: `jsonwebtoken` reports unusable key material
through the very same `JsonWebTokenError` type it uses for a forged token, so the public key is
validated as key material before `jwt.verify()` runs and a residual key-material message is treated
as a fault. An untagged error propagates unmasked.

The Bearer path's refresh-token probe follows the same rule. When operation-token validation says
`invalid token`, authentication retries the credential as a refresh token; a fault raised by that
retry propagates, and only an ordinary _tagged_ refresh rejection restores the original
operation-token rejection for deferral. An in-line fail-closed response logs the original fault
server-side and returns the same generic authentication failure a rejected credential gets, so
internal detail never reaches an unauthenticated client.

Any layer that establishes Harper owns the route then settles the deferred state before doing work:

| Layer                                   | Where                                                              |
| --------------------------------------- | ------------------------------------------------------------------ |
| `REST.ts → http()`                      | after `resources.getMatch` succeeds (and for the OpenAPI document) |
| `REST.ts` WebSocket handler             | after `resources.getMatch(url, 'ws')` succeeds                     |
| `graphqlQuerying.ts`                    | after the `/graphql` prefix match, ahead of its error mapping      |
| `static.ts`                             | after a static file entry matches                                  |
| `mqtt.ts` WebSocket handler             | once the pending HTTP chain settles, before the first packet       |
| `components/mcp/adapters/harperHttp.ts` | after the WebSocket hand-off, before the body is read              |

**Every Harper-owned handler registered `after: 'authentication'` owes this settlement**, because
declining to call `nextHandler` is precisely the moment ownership is settled. A handler that skips
it serves an unrecognized credential as anonymous — the MCP application mount did exactly that, and
returned 200 for an `initialize` the base revision answered with 401.

Settlement goes through `settleDeferredCredentialRejection()`, which returns the response descriptor
`security/auth.ts` used to return in line: status 401 and `serializeMessage({error: message}, request)`
in the request's negotiated content type. That matters because an owner's own error mapping is not
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

**Authentication does not re-decorate a 401 it did not raise.** `security/auth.ts` post-processes any
401 coming back up the chain — overwriting `WWW-Authenticate` with `Basic`, or rewriting the status to
a 302 at `resources.loginPath` for a browser. The in-line rejection deferral replaced returned before
that code, so a settled rejection must skip it to stay wire-identical; and a 401 an application
catch-all raised for its own scheme (a WooCommerce or Bearer challenge) is that application's to make.
Both cases are keyed on the deferred state, so a request that deferred nothing keeps the existing
behavior exactly. The #1565 identity floor still applies either way — it is stamped in
`applyResponseHeaders`, not in the challenge rewriting.

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

### Response Cache-Control / Vary policy (#1518, #1565)

Three tiers, applied in two places:

1. **App/resource explicit** — a `Cache-Control` set by the resource (or `@table(cacheControl: "...")` for anonymous reads, emitted in `REST.ts → http()`) always wins. The declaration is required: anonymous readability alone never emits shared-cache headers, because a request-attribute-gated `allowRead` (IP, headers) would make inferred `public` unsound.
2. **Identity floor** — `security/auth.ts → applyResponseHeaders` stamps `Cache-Control: private, no-cache` + `Vary: Authorization` (+ `Cookie` when sessions are on) on any response where a principal was resolved, credentials were rejected (401), or a credential rejection was deferred (#2418 — the application answered using the header Harper passed through, so the response is credential-dependent at a plain 200), _unless_ the app opted into shared caching with `public`/`s-maxage` (the RFC 9111 opt-in).
3. **CORS partitioning** — when CORS is enabled, every response gets `Vary: Origin` (the ACAO header is reflected per-origin, and its absence on no-Origin requests is origin-dependent too).

The `@table(cacheControl:)` value is persisted on the primary-key attribute (like `expiration`), so all threads and future boots see it; `resources/databases.ts → table()` treats `null` as "schema explicitly has none" (clears on reload) and `undefined` as "caller is not schema-defining" (no clobber from `add_attribute`/cluster schema events).

---

## "Where is X" cheat sheet

| Question                                                                   | Where                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where do I register a new HTTP handler?                                    | `http.ts → httpServer()` (or `onRequest()` for the request-only form)                                                                                                                                                                                                                                                                                                                                                  |
| Where do I register a WebSocket handler?                                   | `http.ts → onWebSocket()`                                                                                                                                                                                                                                                                                                                                                                                              |
| How does `before`/`after` middleware ordering work?                        | `middlewareChain.ts → topoSort`                                                                                                                                                                                                                                                                                                                                                                                        |
| Where does PROXY protocol get parsed?                                      | `serverHelpers/proxyProtocol.ts` (applied by `http.ts → enableProxyProtocol` / `createH2CProxyFront`)                                                                                                                                                                                                                                                                                                                  |
| How does an app read forwarded TLS facts (JA3/JA4, ALPN, SNI, mTLS cert)?  | `request.connectionInfo` (`ConnectionInfo` from `serverHelpers/proxyProtocol.ts`); only set from a trusted PROXY v2 header on the UDS mirror, never from a request header                                                                                                                                                                                                                                              |
| Why does mTLS revocation checking look up the client cert's issuer itself? | `security/certificateVerification/trustedIssuers.ts` — Node only completes a peer chain from the _listener_ context's store, but Harper's client CAs live on SNI contexts (`security/keys.ts → createTLSSelector`), so a resumed TLS session (and Node 26.8.0/26.8.1, nodejs/node#65579) exposes the leaf alone; `verifyCertificate` recovers the issuer from the published CA set and otherwise applies `failureMode` |
| Where is the REST request → Resource dispatch?                             | `REST.ts → http()`                                                                                                                                                                                                                                                                                                                                                                                                     |
| Where is the operations API request handled?                               | `operationsServer.ts → handler`                                                                                                                                                                                                                                                                                                                                                                                        |
| How are content types (de)serialized?                                      | `serverHelpers/contentTypes.ts`                                                                                                                                                                                                                                                                                                                                                                                        |
| Why doesn't every MQTT subscriber re-serialize the message it receives?    | `serverHelpers/sharedMessageEncoding.ts` (memoized on the message object the fan-out shares); consumed by the outbound listener in `mqtt.ts`                                                                                                                                                                                                                                                                           |
| Where do durable subscriptions live?                                       | `DurableSubscriptionsSession.ts`                                                                                                                                                                                                                                                                                                                                                                                       |
| How are sockets dispatched to worker threads?                              | `threads/socketRouter.ts`                                                                                                                                                                                                                                                                                                                                                                                              |
| Where is the Operations API wired into Fastify?                            | `operationsServer.ts → buildServer`                                                                                                                                                                                                                                                                                                                                                                                    |

---

## Conventions

- Don't add new code to `fastifyRoutes.ts` — it's the legacy custom-functions path.
- New protocol plugins implement the `Server` interface (in `Server.ts`) and register via `onRequest`/`onUpgrade`/`onWebSocket`.
- Always pass `name` when registering a listener with `before`/`after` — anonymous entries can't be ordered against.
- Tests live in `../unitTests/server/`.

---

## The dispatched API operation is carried on async context, never on the request (`server/serverHelpers/operationAuthorizationState.ts`)

`verifyPermsAST`'s token-scope check has to be told which top-level API operation the caller
invoked, because the scope is written in that namespace (`sql`, `export_local`, ...). Two things
make that awkward:

1. On the **direct-SQL** path, the object handed to `checkASTPermissions` _is_ the client's request
   body, and this check is the only gate there (`chooseOperation`'s `sql` branch is mutually
   exclusive with its `verifyPerms` call). Any field read off that object is therefore a way to
   name whichever operation the caller's scope happens to allow and run arbitrary SQL under it.
   `jsonMessage.operation` is safe only because dispatch already routed on that same field, so it
   cannot disagree with the operation running. Never add another.
2. A **job** re-parses its SQL from the nested `search_operation` in a _different_ async context —
   `executeJob` persists the request and hands off to the job runner, and `jobProcess.ts` re-enters
   from the `hdb_job` record. So a store established around the originating request cannot reach
   it, and the re-parse would be judged as `sql` rather than as the job's own operation.

The carrier is therefore established **in the job worker**, by `runWithDispatchedOperation`, from
the same `request.operation` that `getOperationFunction` just resolved the handler from. That
identity is the whole basis for trusting it: the value naming the operation and the value selecting
the code cannot diverge. A new carrier must preserve that property — an added request property, a
`search_operation` field, or a persisted `parsed_sql_object` would not.

This lives in the same `AsyncLocalStorage` as the auth bypass rather than a second store, so
`processAST` reads the state once. `runWithOperationAuthorizationBypass` **preserves** an existing
carrier on both branches. That is deliberate and was initially got wrong: its enforced branch is not
a bypass, so a job handler dispatching a nested _authorized_ operation lands there, and dropping the
carrier would judge that job's re-parsed SQL as the inner `sql` and refuse it partway through its own
work. The consequence to know is the other direction — a nested dispatch inside a job is judged
against the **outer** job's operation for any `evaluateSQL` that does not pass through
`chooseOperation`. It allocates only when a carrier is present; with none, two shared frozen objects
serve the common path. All four stores are frozen, so `getOperationAuthorizationState()` cannot hand
a mutable one to a caller.

It has four call sites, and they are not all dispatch wrappers: `server.operation()`
(`serverUtilities.ts`), the ITC path (`registeredOperations.ts`), the legacy SQL engine
(`sqlEngine/diff/differential.ts`), and Harper's own `hdb_job` query (`server/jobs/jobs.ts`) — that
last one **is** reached from the ops-API dispatch, via `search_jobs_by_start_date` →
`handleGetJobsByStartDate` → `getJobsInDateRange`.

Harper's own internal SQL takes the bypass, not the carrier. `getJobsInDateRange` runs a fixed
`system.hdb_job` query through `evaluateSQL` beneath a handler the caller was already authorized for,
and `SqlSearchObject` hardcodes `operation: 'sql'` — so the same mismatch applies, but the answer
differs, and the reason is easy to get backwards. `verifyPermsAST`'s super_user early return is
`isSuperUser && !isSuSystemOperation`, so a `system` schema is **exempt** from it and the table check
genuinely runs. A carrier would therefore put Harper's own query through `hasPermissions` on
`system.hdb_job`, which passes only because `appendSystemTablesToRole` grants `system.*.read` to a
hydrated super_user — a super_user principal without an appended `permission.system` (an
impersonation payload, or any user not resolved through `security/user.ts`) would start getting 403s on an
operation it is entitled to. The bypass also states the actual intent: the statement is Harper's, not
the caller's. Wrap the individual statement, not the function — a later caller-dependent statement
must not inherit it.

A second body field has to be neutralized for any of this to hold: `evaluateSQL` trusts a supplied
`parsed_sql_object` verbatim and skips parsing, `chooseOperation` overwrites only the **top-level**
one, and `dataLayer/export.ts` hands the nested `search_operation` straight to `evaluateSQL`. So a
body-supplied `search_operation.parsed_sql_object` carrying `permissions_checked: true` would run an
arbitrary AST with the check skipped. `chooseOperation` deletes it, forcing the worker to re-parse
from the `sql` string that dispatch authorized — the nested object is never overwritten the way the
top-level one is, because nothing downstream should read one at all.

What is untestable is not the carrier's contract — unit tests cover that by calling
`runWithDispatchedOperation` directly — but that `jobProcess` is what establishes it. Delete that call
and those tests stay green. The carrier only changes an outcome through `tokenScopeDenial`, which is
inert unless the principal carries `tokenOperations`, and that property has exactly one origin: an
OIDC trust-policy exchange, for which there is no integration harness.

Three different mechanisms are easy to conflate here. `tokenOperations` above is the **OIDC token
operation scope** (#2174). An **inline-role scoped token** (`create_authentication_tokens` with a
`role` object) is not the same thing and cannot substitute, because `createScopedToken` mints it
`super_user: false`, so it cannot invoke a `requires_su` operation such as `export_local` at all.
**Table permissions** are a third, and also cannot substitute — see the system-schema exemption
above. See #2298.

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
  and is fixed alongside it in `harper-1568-fix2`.

**Why the operations API doesn't get these headers in normal mode**: ops requests _do_ flow
through the Harper-native `requestHandler` (`httpServer()` calls `getServer()` for every
registration, including Fastify's non-function listener) and cascade to Fastify via the
`status === -1` branch, which copies `response.headers` onto `nodeResponse`. But the ops API runs
on the **main thread**, and the main thread loads components with `resources.isWorker = false`
(`server/loadRootComponents.js`), so the componentLoader's `resources.isWorker &&
extensionModule.handleApplication` gate (`components/componentLoader.ts`) means http's
`handleApplication` never runs there — the main thread's `universalHeaders` array stays empty.
`universalHeaders` is per-thread module state, populated only where the http component loads.
Corollary: with `threads: 0` the ops API shares the worker where `handleApplication` _did_ run,
so ops responses **will** carry the headers there (benign).

## Under Bun, the main HTTP port is served by `node:http`, not `Bun.serve`

Worth knowing before debugging anything Bun-specific on the HTTP path: `getBunHTTPServer()` builds
the `Bun.serve()` fetch config, but `onWebSocket()` calls `getHTTPServer()` unconditionally — it has
a uWS branch and no Bun branch, because Bun native WebSockets are unimplemented (nothing ever sets
`config.websocket`, so WS relies on the Node `ws` server attached to an `http.Server`). MQTT's
`handleApplication` registers WS on the default port before REST's `httpServer()` call for that same
port, so `httpServers[port]` is already a Node server by then and `getBunHTTPServer` early-returns
without registering a serve config. The port is bound by `registerServer()`'s Node server via
`listenOnPortsBun`'s trailing "non-HTTP servers" loop, and the fetch handler is never invoked for it
(only the exclusive operations port reaches `Bun.serve`). Consequence: on Bun the `Request`/`Response`
fetch path is dead code for the main port, and its divergences show up as `node:http`-emulation
divergences instead.

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
`Content-Length` (`body.size` on a blob, `server/http.ts:698-709`) is left open, which is again what
Node does and what Bun then handles correctly.

`pipeBodyToResponse()` therefore ends `request.socket` itself for those shapes
(`endConnectionIfClientExpectsClose`, `isBun`-gated, HTTP/1 only, clean path only — the error path
already closes because `pipeline()` destroys the response with the stream error). Ending the
_request's_ socket is the only remedy that works after a clean stream end on Bun: a `Connection:
close` response header, `response.socket.end()` and `response.destroy()` were all measured as no-ops
there. `socket.end()` is graceful, so it does not truncate — 8 MB over plain TCP and 6 MB over TLS to
a deliberately slow reader each arrive whole. The
`Content-Length` check reads `response.hasHeader()`, which Bun populates from the `writeHead(status,
headers)` fast path this file uses (Node does not, but the branch is Bun-only). A
keep-alive arm pins the other direction (such a client keeps its connection and reuses it); the two
HTTP/1.0 arms are Node/Bun-only, because uWS does not route an HTTP/1.0 request to the resource at
all.

## Per-worker UDS mirrors are separate server instances — port-keyed wiring does not reach them (`server/http.ts`)

With `tls.unixDomainSockets: true`, every secure port gets a per-worker cleartext mirror
(`<worker>-<port>.sock`) so a fronting proxy (symphony) can terminate TLS and route to a specific
worker. The mirror is a **separate** `http.Server` instance registered in `SERVERS[udsPath]` — it is
_not_ `httpServers[port]` — so anything wired by port key (upgrade listeners, uWS `wsHandler`,
mTLS flags, socket options) must be explicitly propagated to it. `getHTTPServer()` exposes the
mirror as `server.udsMirror` (Node) / `server.udsMirrorUwsConfig` (HARPER_UWS_UDS) for exactly this;
`onWebSocket()` uses those to attach the `'upgrade'` dispatch and uWS `wsHandler`. Two lessons paid
for in production (WS handshakes died with a zero-byte close on the mirrors while SSE worked):

- A Node HTTP server with **no** `'upgrade'` listener destroys upgrade sockets with no response and
  no log — a silent per-server default that makes a missing listener look like a network problem.
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

## A worker that misses an ITC ack gets its OS thread state logged (`server/threads/manageThreads.js`)

`broadcastWithAcknowledgement` already times out (30 s) on a worker whose port stays open but never acks, and that shape is almost always a blocked event loop — a native lock, a runaway synchronous call — which nothing inside the worker can report (harper-pro#788: a restarted node's single http worker went byte-silent while main kept serving `cluster_status`, and the app log only said "not acknowledged by worker thread(s) 2"). So each worker posts its Linux thread id (`readlink /proc/thread-self`) to main once at startup, before anything else runs on it, and the timeout branch reads that thread's kernel state from `/proc/self/task/<tid>`: state, `wchan`, the syscall number (the first token only — the rest of that file is argument registers and stack/instruction pointers), CPU ticks, and context-switch counts, plus two cross-platform signals main already has, `worker.performance.eventLoopUtilization()` and the age of the last 1 s resource report. It samples again a second later and logs the deltas: no CPU ticks, no context switches and `event loop active +1000ms` is "parked on a lock"; ticks climbing with state `R` is "spinning". It is deliberately main-thread-only and best-effort: `workers` and the tid live on the main thread's `Worker` objects, every `/proc` field is reported individually (a hardened container may deny `wchan`/`syscall` while `stat` stays readable), a follow-up sample whose `starttime` differs from the first is discarded (the tid may have been recycled), one diagnostic runs per worker with a 30 s cooldown so concurrent timeouts on the same worker don't multiply reads, and nothing here runs when acks arrive on time. It does not name the lock owner; that still needs a native stack from the next occurrence.

## `chooseOperation` authorizes the invoked operation against the authenticated principal (`server/serverHelpers/serverUtilities.ts`)

`verifyPerms` takes a request-shaped object and reads _both_ halves of the permission question off it: the principal from `hdb_user`, and the tables from `schema`/`database`/`table`/`records`. `chooseOperation` used to hand it `json.search_operation` — a caller-supplied field — which made both halves body-controlled. Fixing one half and not the other is not a fix: with an empty `search_operation` the table map is empty, and `hasPermissions` iterating nothing authorizes everything. Regression cover: `integrationTests/security/choose-operation-authz.test.ts`.

Four rules hold this together, and all four are load-bearing:

**The principal comes from authentication.** Authentication sets only the _top-level_ `hdb_user`, and `validateRequestBodyProperties` inspects only top-level keys, so a nested `hdb_user` must be overwritten, never backfilled `if (!...)`. All four callers of `chooseOperation` (`serverHandlers`, `serverUtilities.operation`, `registeredOperations` worker forwarding, MCP) set the top-level principal before dispatch, which is why this belongs here rather than only at the HTTP boundary.

**`search_operation` is the permission subject only for the operations that consume it.** `dataLayer/export.ts` is its sole consumer (`export_local`, `export_to_s3`); for any other operation the substitution checks the nested tables while the handler runs against the top-level ones, so it is gated on the operation name. It must also be an object naming one of export's supported operations (`search_by_value`/`search_by_hash`/`search_by_conditions`/`sql`) — a primitive, `{}`, or an unsupported operation is a request-time 400, not a wrapped 500 or an asynchronously-failed job.

**One check cannot authorize both the outer export and its nested query.** The outer op's own `verifyPerms` returns before any table check — `export_local`/`export_to_s3` are `requires_su`, and a role that lists the operation in `operations` is granted at gate 2 (an explicit listing of an SU-only operation is a deliberate grant). The job worker then runs `search_operation` through `searchByValue`/`searchByHash`/`searchByConditions`, none of which check permissions. So the outer invocation is authorized first, and then the nested search is authorized additively against its _real_ search handler (`getOperationFunction(search_operation)`) and the authenticated principal — otherwise a role granted `export_local` could export a table it holds no grant on. A nested `sql` search takes the SQL branch instead, but the same two-part shape holds: the outer export op runs through `verifyPerms` (so its `requires_su` gate, the `operations` allowlist, and the export token scope all apply, exactly as on the non-SQL path — SQL must not be a way around the requires_su gate), the statement must be a `SELECT` because export is read-only, and `checkASTPermissions` then covers the statement's tables. A direct `sql` call has no outer job op, so there the `operations` allowlist alone is the operation-invocation check.

**`parsed_sql_object` is dispatch state, never client input.** The export worker re-reads it off the same caller-supplied nested object (`evaluateSQL`), and it carries `permissions_checked`, so a body-supplied one runs an AST no check ever saw. It is deleted from the nested object at dispatch, and stripped from the top-level object before this dispatch's own parse is assigned. Only the direct-SQL path consumes the top-level `parsed_sql_object`; a job re-parses off `search_operation`, so setting it for a job would be inert. The bypass/`apiOperation` decision is carried on async-context state (`getOperationAuthorizationState`), not on the request body, and `processAST` honors the denial `checkASTPermissions` computes — a `PermissionResponseObject` has no `length`, so the guard tests the object itself rather than `.length` (which always refused nothing).

The SQL and job paths are additive rather than exclusive: `verifyPermsAST` validates only the statement's tables and attributes, never the `operations` allowlist or `requires_su`, and a table-free statement gives it nothing to validate — so the allowlist check and the AST check both run for a SQL-carrying request, and the nested-search check runs alongside the outer export check for a job.

## `withNodeAdapter()`'s response is the body `PassThrough` it resolves with (`server/serverHelpers/NodeAdapterResponse.ts`)

`Request.withNodeAdapter(handler)` gives third-party Node middleware an `IncomingMessage`/`ServerResponse` pair and resolves `{ status, headers, body }` once headers are committed. The response is `NodeAdapterResponse extends PassThrough`, and that same stream is the resolved `body`: `write()`'s return value, `'drain'`, `'finish'`, `'close'`, `writableEnded`/`writableFinished` and destroy propagation are Node's own rather than events forwarded from a second stream, which is what `Readable.pipe`, `compression`'s buffered `res.on('drain')` and Next.js's response writer depend on past the high-water mark (#2527). Invariants that middleware exercises and the unit test `unitTests/server/serverHelpers/nodeAdapterMiddleware.test.js` pins against the real `compression` (1.8 and the 1.7.4 Next.js vendors), `send`, `on-finished` and `on-headers`:

- **Headers commit exactly once, through `this.writeHead`.** `write()`, `end()`, `flushHeaders()` and `_implicitHeader()` all reach `this.writeHead(this.statusCode)` by property lookup, so a `writeHead` that `on-headers` replaced on the instance runs its listeners (the ones that set `Content-Encoding` and remove `Content-Length`) before the promise resolves. After commit, `setHeader`/`appendHeader`/`removeHeader` and a second `writeHead` throw `ERR_HTTP_HEADERS_SENT` as Node's do; `_header` (which `compression` ≤ 1.7 tests instead of `headersSent`) and `finished` (which `on-finished` tests) derive from that state.
- **The adapter owns the `'error'` listener.** A `destroy(err)` right after `writeHead()` emits before the awaiting caller can attach one; the error stays in the stream's `errored` state for `pipeline()`, `finished()` or async iteration. Client disconnect (`Request.signal`) destroys the response without an error after headers (a plain premature close, which `pipeBodyToResponse` treats as routine) and rejects the promise with the abort reason before them; a handler that throws or rejects before ending the response destroys it, and one that fails after `end()` is logged at warn.
- **Header names are case-insensitive on removal too.** `Headers.delete` lowercases like `set`/`get`/`has`; the inherited `Map.delete` silently left `send`'s `Content-Length` on a gzip body (truncated transfers).
- **Express is not a target.** `express`'s `app.handle()` replaces the response's prototype with one rooted at `http.ServerResponse.prototype`, which no Writable-derived response survives, and would do the same to the request `Proxy`'s target, Harper's real `IncomingMessage`. Middleware that duck-types the response (Next.js, `compression`, `send`, `serve-static`, `finalhandler`, h3, fastify) is the supported surface.

## `manageThreads` has two different `workerCount`s (`server/threads/manageThreads.js`)

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

## A WebSocket close reason must be bounded to 123 bytes (`server/serverHelpers/webSocketCloseReason.ts`)

`ws` throws a `RangeError` when a close reason exceeds 123 bytes — the control-frame payload minus the
status code — and every close site Harper has reaches it from a rejection handler, where that throw
surfaces as an unhandled rejection rather than a failed close. Two of the reasons are outside Harper's
control: a `server.getUser` override's rejection text, and `request.pathname` in REST's no-resource
close. So every `ws.close()` carrying a dynamic reason goes through `toCloseReason()`, which truncates
on a code-point boundary (harper#2703).

The `ClassName: message` in a close reason is deliberate and not something to sanitize: the class name is
Harper's error code, and `errorToString` is the correct renderer for client-visible error text — see
AGENTS.md, "An error's class name is its error code". Only an internal fault's _message_ is replaced, by
`AUTHENTICATION_ERROR_MSGS.GENERIC_AUTH_FAIL`. The three terminal HTTP handlers (Node and Bun in
`server/http.ts`, uWS in `server/serverHelpers/uwsServer.ts`) must agree on that rendering; uWS rendered
the bare message until harper#2703, so the same error carried an error code on two runtimes and not the third.

REST settles a credential rejection _before_ its route lookup, so a rejected client gets the unauthorized
close rather than `1011 No resource was found` — which would otherwise disclose whether the resource exists.

## A request-queue shed is a 503 the server never logged (`server/throttle.ts`)

`throttle()` sheds a queued call once `queuedCalls.length × averageEventCycleTime` exceeds the limit (20s
by default). `server/http.ts` answers it directly with `Service unavailable, exceeded request queue limit`
and records only an analytics action; nothing is thrown, so the HTTP error path that logs every thrown
status (`info` for a 503, `warn` for a 500) never runs, and the `DatabaseTransaction` write-queue and
conflict 503s log at `error` before they throw. A 503 with that exact body and no log line of any level
behind it is therefore the throttle, which now writes a rate-limited `warn` per throttle instance naming
the queue; `resources/Table.ts`'s cache-resolution throttle throws its own 503 under the same warn. The
gate is per instance on purpose: a shared one let a cache-fill shed silence the HTTP shed that followed.
Reproduce with a large concurrent non-GET burst on one CPU-starved worker
(`integrationTests/resources/sourcedfrom-eav-cache-coherence.test.ts` P1 under Bun pinned to a contended
core).
