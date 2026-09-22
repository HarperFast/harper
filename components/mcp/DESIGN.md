# components/mcp/ — Design notes

The MCP Streamable-HTTP surface.

**Read this when:** adding or changing an MCP method, tool, prompt or profile.

Index of every design note: [DESIGN.md](../../DESIGN.md).

---

## MCP protocol surface (`components/mcp/`)

The MCP Streamable-HTTP transport (spec `2025-06-18`) is served at `/mcp` under **two profiles**: an
_operations_ profile (mounted on the Fastify operations server) and an _application_ profile (mounted on
the Harper application HTTP server). Both share `transport.ts` (the JSON-RPC dispatcher) but differ in what
they expose — operations surfaces management operations as tools; application surfaces exported
Resources/tables. Profile gating runs throughout (`completeResourceArgument`, prompt visibility, tool
`visibleTo`), so when adding a method, decide which profile(s) it belongs to rather than assuming both.

A handful of design points are non-obvious and easy to break:

- **Per-call POST SSE streaming has a close-before-subscribe race.** A `tools/call` that opts into streaming
  (`Accept: text/event-stream`) gets an `IterableEventQueue` whose frames the adapter consumes via the event
  API (`on('data')` / `once('close')`), **not** `for await` — the async iterator does not terminate on
  `'close'`. The streaming tool handler is therefore dispatched inside a `setImmediate` (a _detached_,
  deferred task) so the adapter's consumer attaches **before** any frame is produced. Without the defer, a
  fast handler emits its final frame + `close` synchronously; the queue buffers `'data'` but not `'close'`,
  and the stream hangs. Any handler on this path must check `signal.aborted` first (cancellation can land
  before the deferred task runs).

- **Server→client requests are correlated across workers.** `serverRequests.ts` lets a streaming `tools/call`
  call _back_ into the client (`sampling/createMessage`, `elicitation/create`, `roots/list`) and await the
  reply. The request frame rides **the call's POST SSE stream**; the client's response is a _fresh POST_ that
  can land on **any worker**. The pending-promise registry is per-worker, so a response with no local match
  is fanned out over ITC (`MCP_CLIENT_RESPONSE`) and the worker holding the promise resolves it (mirrors
  `components/status/crossThread.ts`). Request ids are `srv-${randomUUID()}` — **not** a per-worker counter,
  which would collide on `(sessionId, id)` across workers and misroute responses. Methods are capability-gated
  (`METHOD_CAPABILITY`) against the client capabilities captured at `initialize`; the registry is bounded
  (timeout + high-water-mark) so a non-responding client can't leak promises.

- **Application tools must be rebuilt after JS resources register, not just on schema changes.** The
  application-profile tool scan (`registerApplicationTools`) runs at MCP component boot and on schema-change
  ITC events — both of which fire while the `@table` classes register, **before** the `jsResource` plugin
  registers the component's exported `class X extends tables.X` subclass. That subclass is the object the
  registry ends up holding (REST routes to it) and the only place author opt-ins (`static mcpTools`/
  `mcpPrompts`) live, so a scan that ran earlier sees only the base table class and misses them (#1448). The
  fix: `jsResource` fires `signalResourcesRegistered()` (a deliberately **local-only**, non-ITC signal in
  `utility/signalling.ts`, backed by `resourceHandler` in `server/itc/serverHandlers.js` — each worker
  registers its own JS resources, so the rebuild belongs in that worker) after registration; `listChanged`
  subscribes and re-runs the scan. Consequence: the verb tools (`create_*` etc.) now bind to the subclass and
  honor its `post`/`patch` overrides, matching REST — previously they bound to the base table class and
  silently bypassed those overrides. Advertised CRUD output schemas are still table-derived, so an overridden
  write verb whose return diverges from `{ id }`/`{ ok }`/`{ deleted }` advertises a subset shape (the in-use
  SDK tolerates supersets; tightening per-override envelopes is sibling-issue work — see the `derive.ts`
  envelope note).

- **Resource subscriptions are row-backed via the audit log.** `resources/subscribe` resolves the URI to a
  Resource and drives `Table.subscribe` off the audit-store `'committed'` path (same machinery as the
  "Audit-store `'committed'` notification batching" section above). The targeting is the subtle part:
  `getMatch` returns the matched Resource plus the remaining path on `relativeURL`, and `subscribeToResource`
  sets **both** `request.id` (the record key, or `undefined`) **and** `request.isCollection` from it. A record
  URI (`…/WorkItem/42`) watches that record; a collection URI (`…/WorkItem`, what `resources/list` advertises)
  watches the whole table. `new RequestTarget(path)` parses an id out of the path on its own, so _both_ fields
  must be overridden — otherwise a collection URI silently watches a phantom record named after the resource
  and receives nothing. `harper://*` pseudo-resources are **list-changed-only** (not row-backed). Subscriptions
  use `omitCurrent` (notify on change, not a retained snapshot — the notification just says "re-read this").

- **Subscribe requires a live GET stream; teardown is asymmetric.** `resources/subscribe` rejects (`-32602`)
  if no GET SSE stream has registered the session — the audit-log iterator has nowhere to deliver, and there'd
  be no `RegisteredSession` close hook to stop it. The GET `'close'` handler drops **subscriptions only**
  (`dropSessionSubscriptions`), _not_ pending server requests: those ride the per-call POST stream, so a normal
  GET reconnect must not reject an in-flight `ctx.serverRequest`. A `DELETE` (explicit session teardown) drops
  **both**, because it may arrive with no open GET stream.

- **SSE resumability (`Last-Event-ID`).** Every GET-channel frame goes through `pushSessionFrame`, which
  assigns a monotonic event id and appends to a bounded per-session `replayBuffer`. On reconnect with a
  `Last-Event-ID` header, `replaySince` re-sends only the frames after that id. The event-id sequence **and**
  the buffer carry across a supersede (a fresh GET replacing the old one for the same session id), so ids stay
  monotonic and no frame is lost across a reconnect.

- **Test seams avoid loading thread/audit machinery in unit tests.** `_setSubscribeImplForTest`
  (`resources.ts`) and `_setItcForTest` (`serverRequests.ts`) inject fakes so the unit suite needn't spin up
  the audit log or ITC. Consequence: the subscribe **targeting** logic (`id`/`isCollection` derivation) is
  _bypassed_ by the seam and is therefore covered at the **integration** level (`sse-listchanged.test.ts` N3
  record / N4 collection), not in unit tests.

Two related traps: the create/schema-update path's exclusive `update-attributes` lock is a
synchronous bounded wait (`acquireUpdateAttributesLock` in `Table.ts`: brief hot spin, then
`Atomics.wait` backoff, retryable `ServerError` after the 10s `UPDATE_ATTRIBUTES_LOCK_TIMEOUT` — harper#2251; it used to be
an unbounded `while (!tryLock()) {}` spin that pinned a worker core forever if the holder never
released). Release is structural — `table()` releases in a single `finally` and `dropTable` uses
`withUpdateAttributesLock` — so a throw inside the locked window cannot leak the lock (regression
suite: `unitTests/resources/updateAttributesLock.test.js`). Because the acquire can now throw,
`table()` takes the RocksDB lock _before_ it mutates the live `Table` (attributes, class metadata,
index handles): losing the race then leaves this worker's in-memory schema exactly as it found it,
and moving any mutation above that acquire reintroduces schema drift the catalog never saw. LMDB
keeps the lazy acquire — its `exclusiveLock()` is an environment-wide write transaction that cannot
time out, so taking it eagerly would stall every write to the database on an unchanged reload. A
successful acquire that waited past `UPDATE_ATTRIBUTES_LOCK_SLOW_WAIT` (1s) warns once, since
contention is otherwise invisible until it becomes a timeout. The locked
sections MUST stay synchronous: the wait blocks the event loop, so an awaited operation inside
one would stall a concurrent acquirer to its deadline. And dropping then recreating a
same-named table within one process requires @harperfast/rocksdb-js >= the column-family
eviction fix (1.4.3 / rocksdb-js#<main PR>): older bindings keep the dropped column family's
by-name registry entry alive whenever other worker threads hold handles, so the recreate
silently reuses a dangling handle and every write fails with "Invalid column family specified
in write batch", poisoning the whole database env until restart. The regression suite for all
of this is `unitTests/resources/dropTableGhost.test.js` (it fails by design on pre-fix
bindings).
