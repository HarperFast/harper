---
title: MCP Resource Subscriptions
---

# MCP Resource Subscriptions

<VersionBadge version="v5.1.10" />

Beyond the `notifications/*/list_changed` events that tell a client _what tools and resources exist_, Harper can push a notification whenever the _contents_ of a specific application resource change. A client subscribes to a resource URI with `resources/subscribe`; Harper watches that record (or table) through its audit-log change feed and emits `notifications/resources/updated` on every commit.

This page covers `resources/subscribe` / `resources/unsubscribe`, the `notifications/resources/updated` push, which URIs are subscribable, and `Last-Event-ID` stream resumability. The `list_changed` events themselves are documented in [MCP Tools and Resources](./tools-and-resources.md#notificationslist_changed).

Harper advertises the capability on `initialize`:

```json
{
	"capabilities": {
		"tools": { "listChanged": true },
		"resources": { "listChanged": true, "subscribe": true },
		"prompts": { "listChanged": true },
		"completions": {},
		"logging": {}
	}
}
```

## Prerequisites

A subscription delivers its updates over the session's GET-SSE channel, so the client **must open `GET /mcp` before calling `resources/subscribe`**. Subscribing without a live stream returns `-32602`:

```json
{ "error": { "code": -32602, "message": "open the GET SSE stream before subscribing to resources" } }
```

The open stream is also the subscription's lifecycle boundary: when it closes (by any of the paths in [Unsubscribing](#unsubscribing)), the subscription's underlying change iterator is released. This is why Harper rejects a stream-less subscribe rather than letting the iterator leak with nowhere to deliver.

## Subscribing

Send `resources/subscribe` with the resource URI:

```json
{
	"jsonrpc": "2.0",
	"id": 7,
	"method": "resources/subscribe",
	"params": { "uri": "https://node.example.com:9926/Product/42" }
}
```

A successful subscribe returns an empty result:

```json
{ "jsonrpc": "2.0", "id": 7, "result": {} }
```

- `params.uri` is required and must be a string — otherwise `-32602` (`resources/subscribe requires params.uri`).
- Re-subscribing to the same URI is idempotent: the prior subscription is stopped and replaced.
- The URI is persisted on the durable `mcp_session` record so it can be restored after an SSE reconnect (see [Resuming a dropped stream](#resuming-a-dropped-stream)).

### Which URIs are subscribable

Only **row-backed application resources** can be subscribed to — the `https://` / `http://` URIs that mirror an exported `Resource` (the same ones `resources/list` advertises on the application profile). The URI's path is matched against the `Resources` registry, and the resource is subscribable only if its class implements `subscribe`. Anything else returns `-32602`:

```json
{ "error": { "code": -32602, "message": "resource is not subscribable: harper://schema/data/product" } }
```

Synthetic `harper://*` metadata URIs (`harper://about`, `harper://openapi`, `harper://schema/...`, `harper://operations`) have no change source and are **not** subscribable. They participate in `notifications/resources/list_changed` only.

### Record vs. collection URIs

The granularity of a subscription is determined by the path:

| URI form                       | Watches                                                      |
| ------------------------------ | ------------------------------------------------------------ |
| `https://host:port/Product/42` | The single record with primary key `42`.                     |
| `https://host:port/Product`    | The whole `Product` table (any record insert/update/delete). |

A collection URI (no record key — the form `resources/list` advertises) subscribes to the entire table; a record URI narrows the watch to one primary key.

Subscriptions use `omitCurrent` semantics: Harper does **not** replay the current value at subscribe time. You only receive notifications for changes that commit _after_ the subscription is established. The notification carries no snapshot — re-read the resource (or call the corresponding `get_*` tool) to fetch the new state.

## The `notifications/resources/updated` push

On each committed change to a subscribed resource, Harper pushes a notification onto the session's GET-SSE channel:

```json
{
	"jsonrpc": "2.0",
	"method": "notifications/resources/updated",
	"params": { "uri": "https://node.example.com:9926/Product/42" }
}
```

There is no diff payload — `params.uri` is the only field. The client decides whether and how to re-read.

## Unsubscribing

Send `resources/unsubscribe` with the same URI:

```json
{
	"jsonrpc": "2.0",
	"id": 8,
	"method": "resources/unsubscribe",
	"params": { "uri": "https://node.example.com:9926/Product/42" }
}
```

- `params.uri` is required and must be a string — otherwise `-32602` (`resources/unsubscribe requires params.uri`).
- Unsubscribing a URI that was never subscribed is a no-op and still returns `{}`.

Subscriptions are also torn down automatically when the session's GET-SSE stream closes — via explicit `DELETE /mcp`, idle-timeout eviction from `system.mcp_session`, a dropped TCP connection, or an idle-prune sweep.

## Scope and durability

Subscriptions are **per-worker**: a subscription is bound to the worker that holds the session's SSE stream, and the audit-log change feed delivers commits locally on that worker. The live subscription objects can't be persisted, but the durable list of subscribed URIs lives on the `mcp_session` record, which is how they survive a reconnect.

## Resuming a dropped stream

Every frame Harper sends on the GET-SSE channel carries a monotonic SSE event id (the `id:` field). Harper keeps a bounded per-session **replay buffer** of the most recent 100 frames. When a dropped connection reconnects, the client sends the id of the last frame it saw in the standard `Last-Event-ID` header:

```
GET /mcp HTTP/1.1
Mcp-Session-Id: 0c8f...
Last-Event-ID: 137
```

Harper replays every buffered frame with a higher id (exclusive) before live frames resume, so a brief network blip doesn't drop `notifications/resources/updated` or `list_changed` events. On reconnect, Harper also restores the session's persisted subscriptions from the `mcp_session` record (best-effort — a URI that is no longer subscribable is dropped).

Caveats, all best-effort by design:

- **Buffer bound.** Only the last 100 frames are retained; a client that was disconnected long enough to miss more than 100 frames will not get the older ones. A non-numeric `Last-Event-ID` replays the entire buffer.
- **Per-worker.** The replay buffer and event-id sequence live on the worker that served the original stream. If the reconnecting `GET` lands on a different worker (one that never held the prior stream), its buffer is empty and there is nothing to replay. This is the same per-worker binding that scopes sessions and subscriptions.

## Not yet supported

See [the v1 out-of-scope list](./overview.md#out-of-scope-for-v1). Notably, cross-worker session sharing is deferred, so subscription delivery and `Last-Event-ID` replay are both best-effort across a reconnect that changes workers.
