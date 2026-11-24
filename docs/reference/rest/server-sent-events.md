---
title: Server-Sent Events
sidebar_position: 60
sidebar_label: 'Server Sent Events'
---

<!-- Source: versioned_docs/version-4.7/developers/real-time.md (SSE section - primary) -->
<!-- Source: release-notes/v4-tucker/4.2.0.md (SSE support introduced) -->

# Server-Sent Events

<VersionBadge version="v4.2.0" />

Harper supports Server-Sent Events (SSE), a simple and efficient mechanism for browser-based applications to receive real-time updates from the server over a standard HTTP connection. SSE is a one-directional transport — the server pushes events to the client, and the client has no way to send messages back on the same connection.

## Connecting

SSE connections are made by targeting a resource URL. By default, connecting to a resource path subscribes to changes for that resource and streams events as they occur.

```javascript
let eventSource = new EventSource('https://server/my-resource/341', {
	withCredentials: true,
});

eventSource.onmessage = (event) => {
	let data = JSON.parse(event.data);
};
```

The URL path maps to the resource in the same way as REST and WebSocket connections. Connecting to `/my-resource/341` subscribes to updates for the record with id `341` in the `my-resource` table (or custom resource).

## Resuming a Dropped Stream

<VersionBadge version="v5.5.0" />

An `EventSource` reconnects by itself when its connection drops, and sends the last `id` it read in the `Last-Event-ID` header. A table's own event stream issues ids and resumes from them, so the events committed while the client was away are delivered after the reconnect. Nothing is needed in the client beyond the `EventSource` itself; a client that reads the stream another way sends the last `id` it read in that header.

```
GET /my-resource/ HTTP/1.1
Accept: text/event-stream
Last-Event-ID: eyJ2IjoxLCJzY29wZSI6...
```

Treat the id as opaque: store it and send it back unchanged. There are two kinds.

- **A checkpoint token** arrives as the `id` of an event named `harper-checkpoint`, whose `data` is an empty object. An `EventSource` records the id; the event fires no `message` event and needs no listener. The token marks a position in each node's transaction log, so another node of the cluster can resume it too, and it accounts for transactions that were still open when it was issued. Tokens are issued on RocksDB, by a database whose log positions are certified; the first usually arrives within ten seconds of connecting, and later ones as those positions advance. A stream that resumed from an id sends none until it has replayed what the client missed.
- **A log position** arrives on each change event until the stream has issued a token (the current records a collection's stream sends first carry none), and for the whole stream when it cannot issue one: on LMDB, and while a cluster node's history is not certified. It names a position in this node's log only. A transaction that commits after the event the id came from, but took its place in the log before it, is not delivered on resume. On RocksDB the id also names the database and the table, so another node, a restored database or a table that was dropped and created again refuses it. LMDB checks only that the history after the position is still retained, so it does not notice a restored database. A single record's stream that resumes from a log position does not notice another node's data having been copied into the database while it was away, which a collection's stream refuses with `410`.

Once a stream has issued a token, its events carry no id of their own, so the client keeps the token.

A resume replays the log from the position, so it does not send the current records again, and it can repeat events the client already has. Ignore an event whose `version` is older than the one held for that record `id`, and apply the rest: two events can carry the same `version` and differ, when a change that committed late was merged into the record. The rule also covers a write that commits while a collection's current records are being sent: its event can arrive after the record's newer state. For a record that changed more than once while the client was away, the replay delivers its current state rather than each change.

### When a Position Cannot Be Resumed

Harper never answers a reconnect it cannot resume by silently starting from now. What happens depends on when it finds out:

| When                     | Response                                                                                                                                                   | What an `EventSource` does                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Before the stream starts | `400` (not an id this resource issued), `409` (issued for another table, database or engine), `410` (the history after the position is no longer retained) | Stops reconnecting and fires `error` with `readyState` `CLOSED` |
| After the stream started | An `event: harper-error` event whose `data.status` is `409` or `410` and whose `id` is empty, then the stream ends                                         | Forgets its id and reconnects, which starts a new subscription  |

In both cases the events in between are lost to this client, so it must load the current state again rather than keep what it has: a new subscription to a collection sends each current record, but not the records deleted in the meantime.

```javascript
function subscribe() {
	const eventSource = new EventSource('https://server/my-resource/');
	// apply() ignores an event whose version is older than the record it holds
	eventSource.onmessage = (event) => apply(JSON.parse(event.data));
	// an empty id means the position is gone and the stream restarts from the current state
	eventSource.addEventListener('harper-error', (event) => {
		if (event.lastEventId === '') clearLocalState();
	});
	eventSource.onerror = () => {
		if (eventSource.readyState !== EventSource.CLOSED) return; // reconnecting by itself
		clearLocalState();
		subscribe();
	};
}
```

On RocksDB a stream also ends with `harper-error` and an empty `id` when another node's data is copied into the database underneath it, since the copied records have no events to resume from.

On LMDB retention is recorded for the whole database, so pruning another table's history can also refuse a position with `410`.

### In a Custom Resource

These ids belong to a table's own stream. A resource that defines its own `connect()` or `subscribe()`, including a class that extends a table, issues its own ids (the `id` of each event it yields) and reads the header itself, as `lastEventId` on the request:

```javascript
export class ConversationFeed extends Resource {
	static async *connect(target, incomingMessages, request) {
		for await (const turn of turnsAfter(target.id, request.lastEventId)) {
			yield { event: 'turn', data: turn, id: turn.id };
		}
	}
}
```

`request.lastEventId` is `undefined` when the client sent no `Last-Event-ID`.

### Upgrading a Cluster

A node running a version before v5.5.0 ignores `Last-Event-ID` and starts a new subscription. While a cluster runs both versions, a reconnect that reaches such a node is not resumed and is not refused.

## `connect()` Handler

SSE connections use the same `connect()` method as WebSockets on resource classes, with one key difference: since SSE is one-directional, `connect()` is called without an `incomingMessages` argument.

```javascript
export class MyResource extends Resource {
	async *connect() {
		// yield messages to send to the client
		while (true) {
			await someCondition();
			yield { event: 'update', data: { value: 42 } };
		}
	}
}
```

The default `connect()` behavior subscribes to the resource and streams changes automatically.

## Reading the request in `connect()`

To read the incoming request (query parameters, headers, the path), define `connect()` as a **`static`** method. Its first argument is the `RequestTarget`, which exposes the query string via `target.get()`. Because `target` is an ordinary argument, it is captured in the generator's scope — read it directly inside the `async *connect()` body:

```js
export class Search extends Resource {
	static async *connect(target) {
		const query = target.get('q'); // GET /Search?q=harper
		const apiKey = target.get('api_key');
		for (const hit of await runSearch(query)) yield { data: hit };
	}
}
```

This works even though the generator body doesn't begin executing until the first event is requested — the `target` argument is already bound when `connect()` is called.

> **Note:** the `RequestTarget` argument is only passed to a **`static`** `connect()`. An instance method's first argument is not the target, so define `connect()` as `static`.

### Doing synchronous work before streaming

If you must read the request and act on it _synchronously_ — before the stream starts — split `connect()` into a reader that returns a separate generator. This is also required when reading the request `context` via `getContext()`, which must be captured in the synchronous call frame: it is no longer available once the generator body is deferred to the first event.

```js
export class Search extends Resource {
	static connect(target) {
		const query = target.get('q');
		if (!query) throw new Error('q is required'); // reject before streaming starts
		return this.stream(query);
	}
	static async *stream(query) {
		for (const hit of await runSearch(query)) yield { data: hit };
	}
}
```

## When to Use SSE vs WebSockets

|                 | SSE                                   | WebSockets                       |
| --------------- | ------------------------------------- | -------------------------------- |
| Direction       | Server → Client only                  | Bidirectional                    |
| Transport       | Standard HTTP                         | HTTP upgrade                     |
| Browser support | Native `EventSource` API              | Native `WebSocket` API           |
| Use case        | Live feeds, dashboards, notifications | Interactive real-time apps, MQTT |

SSE is simpler to implement and has built-in reconnection in browsers. For scenarios requiring bidirectional communication, use [WebSockets](./websockets.md).

## See Also

- [WebSockets](./websockets.md) — Bidirectional real-time connections
- [MQTT Overview](../mqtt/overview.md) — Full MQTT pub/sub documentation
- [REST Overview](./overview.md) — HTTP methods and URL structure
- [Resources](../resources/overview.md) — Custom resource API including `connect()`
