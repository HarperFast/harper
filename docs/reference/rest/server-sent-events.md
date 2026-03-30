---
title: Server-Sent Events
---

<!-- Source: versioned_docs/version-4.7/developers/real-time.md (SSE section - primary) -->
<!-- Source: release-notes/v4-tucker/4.2.0.md (SSE support introduced) -->

# Server-Sent Events

Added in: v4.2.0

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
