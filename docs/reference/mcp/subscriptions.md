---
title: MCP Resource Subscriptions
sidebar_position: 50
sidebar_label: 'Resource Subscriptions'
---

# MCP Resource Subscriptions

<VersionBadge version="v5.1.10" />

Beyond the `notifications/*/list_changed` events that tell a client _what tools and resources exist_, Harper can push a notification whenever the _contents_ of a specific application resource change. A client subscribes to a resource URI with `resources/subscribe`; Harper watches that record (or table) through its audit-log change feed, or, for a [custom resource](./tools-and-resources.md#subscribing-to-custom-resources), the stream its `subscribe` method returns, and emits `notifications/resources/updated` on every change.

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

The open stream is also a subscription lifecycle boundary: when it closes (by any of the paths in [Unsubscribing](#unsubscribing)), the subscription's underlying change iterator is released. Credential expiry also stops delivery; see [Subscription lifetime and credential rotation](#subscription-lifetime-and-credential-rotation).

## Subscribing

Send `resources/subscribe` with the resource URI:

```json
{
	"jsonrpc": "2.0",
	"id": 7,
	"method": "resources/subscribe",
	"params": { "uri": "harper+rest://node.example.com:9926/Product/42" }
}
```

A successful subscribe means the current GET worker has installed the subscription, and returns an empty result:

```json
{ "jsonrpc": "2.0", "id": 7, "result": {} }
```

- `params.uri` is required and must be a string — otherwise `-32602` (`resources/subscribe requires params.uri`).
- Re-subscribing to the same URI is idempotent: the prior subscription is stopped and replaced.
- The URI is persisted on the durable `mcp_session` record so it can be restored after an SSE reconnect (see [Resuming a dropped stream](#resuming-a-dropped-stream)).

### Which URIs are subscribable

Two kinds of URI can be subscribed to:

- **Row-backed application resources** — the `harper+rest://` URIs that mirror an exported `Resource` (the same ones `resources/list` advertises on the application profile). The URI's path is matched against the `Resources` registry. A table exported with [`@export`](../database/schema.md#export) is subscribable with no code of yours, and so is a class that extends one, such as `export class Product extends tables.Product`: both use the table's `subscribe`, which watches the audit-log change feed. A `Resource` class that does not extend a table sends notifications only if it implements `subscribe`; the base class's default returns a stream that stays empty.
- **Custom resources that declare `subscribe`** (Added in: v5.4.0) — URIs published through a static `mcpResources` entry. The URI is matched exactly as `resources/read` matches it, and the entry's `subscribe` method supplies the changes. See [Subscribing to custom resources](./tools-and-resources.md#subscribing-to-custom-resources).

Anything else returns `-32602`:

```json
{ "error": { "code": -32602, "message": "resource is not subscribable: harper://schema/data/product" } }
```

Synthetic `harper://*` metadata URIs (`harper://about`, `harper://openapi`, `harper://schema/...`, `harper://operations`) have no change source and are **not** subscribable. They participate in `notifications/resources/list_changed` only.

A refused subscribe, row-backed or custom, answers a JSON-RPC error rather than an HTTP 500 (Changed in: v5.4.0):

| Answer                                                      | When                                                                                      |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `-32602 permission denied: <uri>`                           | The credentials used for this subscription do not permit reading the resource.            |
| `-32603 resource subscription timed out; retry the request` | The GET worker did not acknowledge installation within the 30-second acknowledgment wait. |
| `-32603 resource subscription failed; retry the request`    | Installation failed, or another request for the same URI replaced this request.           |

A missing or expired session returns HTTP `404`. If requests for the same URI overlap, let them settle and retry with the current credential only if that subscription is still wanted. For other `-32603` failures, retry only transient causes, with backoff. If failures repeat, have the server operator investigate the installation failure and fix its cause before retrying. An invalid custom stream or a consistently failing custom gate will not be repaired by retries. The same failure response also covers the per-worker limit of 100 pending subscribe/unsubscribe requests, including at most 25 per session on that worker. Limit concurrent requests and use backoff; the response does not distinguish this limit from installation failures.

A failed or timed-out subscribe attempts to remove the state written by that request without removing a later request for the same URI. The error response does not report whether cleanup succeeded. If you no longer want that URI subscribed after any failed or timed-out request, send `resources/unsubscribe` to confirm removal, following the transient-error retry guidance above. If the GET closes during setup, a waiting POST can complete after reconnect, or return the timeout error if no reconnect acknowledges it. A POST already pending when a new GET claims ownership is checked under that GET's grant and can be denied even if its own credential allowed access. Open a replacement GET before retrying.

`resources/list` advertised these URIs under `http(s)://` before 5.1.18 <VersionBadge type="changed" version="v5.1.18" />. A legacy `http://` or `https://` URI is still accepted by `resources/subscribe` and `resources/unsubscribe`, so a client holding an older listing keeps working; new clients should use the `harper+rest://` form the current listing returns.

### Record vs. collection URIs

The granularity of a subscription is determined by the path:

| URI form                             | Watches                                                      |
| ------------------------------------ | ------------------------------------------------------------ |
| `harper+rest://host:port/Product/42` | The single record with primary key `42`.                     |
| `harper+rest://host:port/Product`    | The whole `Product` table (any record insert/update/delete). |

A collection URI (no record key — the form `resources/list` advertises) subscribes to the entire table; a record URI narrows the watch to one primary key.

Row-backed subscriptions use `omitCurrent` semantics: Harper does **not** replay the current value at subscribe time. You only receive notifications for changes that commit _after_ the subscription is established. A custom resource's stream decides this itself: every value it yields sends a notification, including one it yields at once. The notification carries no snapshot — re-read the resource (or call the corresponding `get_*` tool) to fetch the new state.

## The `notifications/resources/updated` push

On each committed change to a subscribed row-backed resource, and on each value a custom resource's stream yields, Harper pushes a notification onto the session's GET-SSE channel:

```json
{
	"jsonrpc": "2.0",
	"method": "notifications/resources/updated",
	"params": { "uri": "harper+rest://node.example.com:9926/Product/42" }
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
	"params": { "uri": "harper+rest://node.example.com:9926/Product/42" }
}
```

- `params.uri` is required and must be a string — otherwise `-32602` (`resources/unsubscribe requires params.uri`).
- Unsubscribing a URI that was never subscribed is a no-op and still returns `{}`.

Subscriptions are also torn down automatically when the session's GET-SSE stream closes — via explicit `DELETE /mcp`, idle-timeout eviction from `system.mcp_session`, a dropped TCP connection, or an idle-prune sweep. Credential expiry stops delivery too; see [Subscription lifetime and credential rotation](#subscription-lifetime-and-credential-rotation).

## Scope and durability

A live subscription runs on the worker holding the session's GET-SSE stream. The subscribe POST may reach another HTTP worker: it updates the durable desired URI set, and succeeds after the current GET worker acknowledges installation. The durable state survives worker changes and a server restart. A custom resource's stream still needs to deliver changes originating on other workers, as Harper table subscriptions do.

## Subscription lifetime and credential rotation

<VersionBadge type="changed" version="v5.4.0" />

Resource updates stop when either the subscribing POST's bearer credential or the receiving GET's bearer credential expires, whichever comes first. Harper keeps the GET credential's expiry when it re-reads the user's permissions after a role change. Reconnecting can restore an unexpired subscription under the current GET permissions, but cannot extend the original POST credential's expiry. A reconnect after a network interruption does not require re-subscribing while the original subscribing POST credential remains valid and the GET can restore its grant. A scoped subscription requires a matching scoped GET, as described below. Component bearer validators that omit `authExpiresAt` default to five minutes, capped by a JWT's `exp`. Return the verified token expiry as described in [Bearer validators](../http/api.md#serverregisterbearervalidatorvalidator-options).

MCP does not return the effective subscription expiry. Obtain credential lifetime from the issuer, such as `expires_in` or a JWT's `exp`, and renew before the earlier POST/GET expiry. For component bearer validators, the service must also communicate any shorter `authExpiresAt` lifetime, including the five-minute default; clients cannot discover that server-side cap through MCP.

A subscription created with a scoped token restores only when the GET presents a scoped token with the same username and role permissions. A newly issued scoped token may have a later expiry, but restoring does not extend the original subscription expiry. An ordinary credential with the same username, such as a user created after the scoped token was issued, cannot inherit that scoped subscription; reconnecting with it removes the stored scoped entry while retaining valid ordinary subscriptions. An explicit new `resources/subscribe` POST can use its own scoped credential.

To renew subscriptions after rotating credentials:

1. Close the old GET stream and open `GET /mcp` for the same session with the replacement credential.
2. Send `resources/subscribe` for each URI you want to keep watching, using the replacement credential on each POST too.
3. Re-read each resource to catch changes made while its subscription was inactive; re-subscribing does not replay those changes.

An open GET alone does not mean that updates are still being delivered. A table or custom iterator can end at expiry while the GET stays open. Harper can also close the GET when it detects an expired credential during delivery. Renew before expiry rather than waiting for the connection to close. Re-subscribing with the replacement credential establishes a new subscription lifetime.

## Resuming a dropped stream

Every frame Harper sends on the GET-SSE channel carries a monotonic SSE event id (the `id:` field). Harper keeps a bounded per-session **replay buffer** of the most recent 100 frames. When a dropped connection reconnects, the client sends the id of the last frame it saw in the standard `Last-Event-ID` header:

```
GET /mcp HTTP/1.1
Mcp-Session-Id: 0c8f...
Last-Event-ID: 137
```

Harper replays buffered frames with a higher id (exclusive) before live frames resume, subject to the per-worker limits below. On reconnect, Harper restores persisted subscriptions under the current GET permissions, bounded by the original subscribing POST expiry and the current GET expiry. The GET response waits for restoration before returning HTTP `200`. Expired, denied, or no-longer-subscribable entries are removed. A transient restoration failure retains the URI and returns HTTP `503` with `Retry-After: 1` (Changed in: v5.4.0). Resend `GET /mcp` with the same `Mcp-Session-Id`, `Mcp-Protocol-Version` and, if used, `Last-Event-ID` headers, using valid authorization. A `503` alone does not require repeating `initialize` or the subscribe POSTs. An absent session returns HTTP `404`.

Caveats, all best-effort by design:

- **Buffer bound.** Only the last 100 frames are retained; a client that was disconnected long enough to miss more than 100 frames will not get the older ones. A non-numeric `Last-Event-ID` replays the entire buffer.
- **Per-worker.** The replay buffer and event-id sequence live on the worker that served the original stream. If the reconnecting `GET` lands on a different worker (one that never held the prior stream), its buffer is empty and there is nothing to replay. Persisted subscription state can restore on the new worker, but the old notification history cannot.

## Not yet supported

See [the v1 out-of-scope list](./overview.md#out-of-scope-for-v1). Notification replay history is not shared between workers; restoring a subscription on another worker does not recover updates missed during the disconnection.
