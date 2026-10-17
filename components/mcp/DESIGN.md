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

- **The application profile reads its own request body, so it enforces `http.maxRequestBodySize` itself.**
  `readBody` in `adapters/harperHttp.ts` shares `getMaxRequestBodySize()` with the REST reader, answers 413
  for a declared `Content-Length` over the limit or once the streamed bytes pass it, and keeps a discarding
  `'data'` listener on the body afterwards: a uWS body is a paused `Readable` that buffers the whole upload
  unless something reads it. Like REST, it does not close the connection or bound the discard. The
  operations profile is capped by Fastify's `bodyLimit` instead.
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
  SDK tolerates supersets; tightening per-override envelopes is sibling-issue work — see the `tools/schemas/derive.ts`
  envelope note).

- **Resource subscriptions are row-backed via the audit log.** `resources/subscribe` resolves the URI to a
  Resource and drives `Table.subscribe` off the audit-store `'committed'` path (same machinery as
  [Audit-store `'committed'` notification batching](../../resources/DESIGN.md#audit-store-committed-notification-batching-transactionbroadcastts)). The targeting is the subtle part:
  `getMatch` returns the matched Resource plus the remaining path on `relativeURL`, and `subscribeToResource`
  sets **both** `request.id` (the record key, or `undefined`) **and** `request.isCollection` from it. A record
  URI (`…/WorkItem/42`) watches that record; a collection URI (`…/WorkItem`, what `resources/list` advertises)
  watches the whole table. `new RequestTarget(path)` parses an id out of the path on its own, so _both_ fields
  must be overridden — otherwise a collection URI silently watches a phantom record named after the resource
  and receives nothing. `harper://*` pseudo-resources are **list-changed-only** (not row-backed). Subscriptions
  use `omitCurrent` (notify on change, not a retained snapshot — the notification just says "re-read this").

- **Custom resources subscribe through the read resolver (#3250).** `subscribeToResource` calls
  `matchCustomResource(profile, uri)` first, exactly as `readResource` does, so read and subscribe always resolve
  the same entry; an entry without `subscribe` stays `-32602`. The author's method runs in the read path's
  user-carrying transaction and the returned iterable is consumed after it ends, which is why generator methods
  are refused at registration (their body would run outside it). A stream with no `end()` is refused at
  subscribe when its iterator has no `return()`, or is an async generator (whose `return()` cannot interrupt a
  pending await): unsubscribe could not release its source. Custom values are opaque — only audit-log events get `acknowledge()`. Release is one idempotent `stop()` for both sources: `end()` if the stream has
  one, else the iterator's `return()`, also run when iteration ends or throws, and for a stream acquired by a
  transaction that then failed to commit (`acquireChangeStream`). A custom stream is also registered with
  `registerLiveSubscription` for identity lifetime only (token expiry, removed user or role), which
  `Resource.subscribe` already gives row-backed ones; an expired or stale principal is verified before admission.

- **Subscribe requires a live GET stream; teardown is asymmetric.** `resources/subscribe` rejects (`-32602`)
  if no GET SSE stream has registered the session — the audit-log iterator has nowhere to deliver, and there'd
  be no `RegisteredSession` close hook to stop it. The GET `'close'` handler drops **subscriptions only**
  (`dropSessionSubscriptions`), _not_ pending server requests: those ride the per-call POST stream, so a normal
  GET reconnect must not reject an in-flight `ctx.serverRequest`. A `DELETE` (explicit session teardown) drops
  **both**, because it may arrive with no open GET stream. The stream check is repeated at **admission**, after
  the subscribe await: `addResourceSubscription` binds each setup to the `RegisteredSession` record current when
  it started plus a per-`(session, uri)` pending token, and installs only if that record is still registered and
  no unsubscribe, re-subscribe or drop overtook the token — otherwise it releases the stream and throws
  `SubscriptionCancelledError`. Delivery starts only after admission and pushes only to that record. Restore
  reserves every URI before it starts, stops when its GET is superseded, and prunes only URIs a registered
  resource reported not subscribable — a thrown subscribe, and a URI nothing on the worker matches yet (its
  component may still be loading), stay. The prune is decided inside its queued write, against GET ownership
  and current subscription intent at that moment. Restore runs in the background after the GET returns its
  stream (an author's subscribe may do I/O), so its notifications queue on the record until the adapter
  attaches; registry teardown uses `queue.close()`, which latches `closed`, so `toSseStream` ends a stream
  whose queue closed before it attached. Subscribe, unsubscribe and restore change the durable list only through
  `updateSessionSubscriptions`, a load-and-save against the stored record that this worker serializes per session
  together with `deleteSession`. `touchSession`, `logging/setLevel` and other workers' writes are not ordered by
  it and still save whole records (harper#3255).

- **SSE resumability (`Last-Event-ID`).** Every GET-channel frame goes through `pushSessionFrame`, which
  assigns a monotonic event id and appends to a bounded per-session `replayBuffer`. On reconnect with a
  `Last-Event-ID` header, `replaySince` re-sends only the frames after that id. The event-id sequence **and**
  the buffer carry across a supersede (a fresh GET replacing the old one for the same session id), so ids stay
  monotonic and no frame is lost across a reconnect.

- **Test seams avoid loading thread/audit machinery in unit tests.** `_setSubscribeImplForTest`
  (`resources.ts`) and `_setItcForTest` (`serverRequests.ts`) inject fakes so the unit suite needn't spin up
  the audit log or ITC. Consequence: the subscribe **targeting** logic (`id`/`isCollection` derivation) is
  _bypassed_ by the seam and is therefore covered at the **integration** level (`integrationTests/mcp/sse-listchanged.test.ts` N3
  record / N4 collection), not in unit tests.

- **Discovery filtering must mirror dispatch's ORDER _and_ its name namespace.**
  `canRoleInvokeOperation` (`operationVisibility.ts`, shared by `tools/list` and the
  `harper://operations` catalog) answers only the role-level question; per-target schema/table
  checks still run at call time in `verifyPerms`. Three things it may **not** defer:

  1. **The `operations` allowlist.** `verifyOperationsAllowlist` runs _ahead of every privilege
     early-return_ in `verifyPerms` (harper#2176), super_user and structure_user included, so a
     helper that short-circuits on a privilege flag advertises tools that fail closed on call.
  2. **The `api_name` alias.** Dispatch tests the handler's canonical `api_name`, and eight ops are
     published under a different name — `create_schema`/`drop_schema` (handlers
     `createSchema`/`dropSchema`, api_names `create_database`/`drop_database`),
     `describe_database`→`describe_schema`, `search_by_id`→`search_by_hash`, and the legacy
     `add_`/`package_`/`deploy_custom_function_project` → `add_`/`package_`/`deploy_component`,
     `delete_records_before`→`delete_files_before`. Matching the raw tool name disagrees in BOTH
     directions. The alias table is hand-maintained because `OPERATION_FUNCTION_MAP` pulls in the
     server and cannot be imported here; `unitTests/utility/operation_authorization.test.js` compares
     discovery with gate 1 for every dispatched operation, so a drift fails there. Discovery still
     advertises `get_backup`, `read_transaction_log` and `catchup` to a role that lists them, while
     dispatch refuses them (their registrations deliberately carry a `null` `api_name`).
  3. **`structure_user` is not one grant.** `STRUCTURE_USER_OPS` holds only the four
     table/attribute ops; create/drop schema-or-database needs `structure_user === true`, so an
     array grant (and `[]`, which is truthy) is denied for those four.

  Group names resolve through `_expandedOperations ?? expandOperationsPerms` because the allowlist
  stores groups (`read_only`, `standard_user`) that dispatch expands — a raw `includes`
  under-advertises every op a role holds only via a group.

  This is the class of code that goes stale silently: it was correct when written and was
  invalidated by a change in a _different_ file, with no test failure to announce it. It lives in
  one module for that reason — it was duplicated across the two surfaces, and keeping two copies in
  step is how the original bug survived. Whenever `verifyPerms`' ordering, the `api_name` table, or
  `STRUCTURE_USER_OPS` changes, re-check it.

- **Operations-profile iterable results are collected before `wrapToolResult`.** Operation handlers
  that return non-array iterables or async iterables (`read_audit_log`'s `groupRecordsInHistory`
  generator, `get_analytics`'s async-mapped `ExtendedIterable`, full-text `search_by_conditions`,
  and `search_by_id` / `search_by_hash`'s `getRecords` cursor) rely on the caller to drain them,
  because `wrapToolResult` uses synchronous `JSON.stringify` (`tools/results.ts`). In
  `makeOperationToolHandler` (`tools/operations.ts`), `collectIterableResult` drains any non-array,
  non-`Readable`, non-`ArrayBufferView` iterable via `for await` (wiring `.mapError` when present,
  awaiting element promises, and checking `context.signal`) up to `MAX_OPERATION_ITERABLE_ITEMS`
  (10,000 items) and `MAX_OPERATION_ITERABLE_BYTES` (10 MiB), enforced by
  `unitTests/components/mcp/tools/operations.test.js` and
  `integrationTests/mcp/operations-iterable-results.test.ts`.
