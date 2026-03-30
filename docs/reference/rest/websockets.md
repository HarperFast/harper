---
title: WebSockets
---

<!-- Source: versioned_docs/version-4.7/developers/real-time.md (WebSockets and ordering sections - primary) -->
<!-- Source: release-notes/v4-tucker/4.2.0.md (WebSocket support introduced) -->
<!-- Source: release-notes/v4-tucker/4.3.0.md (CRDT support) -->

# WebSockets

Added in: v4.2.0

Harper supports WebSocket connections through the REST interface, enabling real-time bidirectional communication with resources. WebSocket connections target a resource URL path — by default, connecting to a resource subscribes to changes for that resource.

## Configuration

WebSocket support is enabled automatically when the `rest` plugin is enabled. To disable it:

```yaml
rest:
  webSocket: false
```

## Connecting

A WebSocket connection to a resource URL subscribes to that resource and streams change events:

```javascript
let ws = new WebSocket('wss://server/my-resource/341');
ws.onmessage = (event) => {
	let data = JSON.parse(event.data);
};
```

By default, `new WebSocket('wss://server/my-resource/341')` accesses the resource defined for `my-resource` with record id `341` and subscribes to it. When the record changes or a message is published to it, the WebSocket connection receives the update.

## Custom `connect()` Handler

WebSocket behavior is driven by the `connect(incomingMessages)` method on a resource class. The method must return an async iterable (or generator) that produces messages to send to the client. For more on implementing custom resources, see [Resource API](../resources/resource-api.md).

**Simple echo server**:

```javascript
export class Echo extends Resource {
	async *connect(incomingMessages) {
		for await (let message of incomingMessages) {
			yield message; // echo each message back
		}
	}
}
```

**Using the default connect with event-style access**:

The default `connect()` returns a convenient streaming iterable with:

- A `send(message)` method for pushing outgoing messages
- A `close` event for cleanup on disconnect

```javascript
export class Example extends Resource {
	connect(incomingMessages) {
		let outgoingMessages = super.connect();

		let timer = setInterval(() => {
			outgoingMessages.send({ greeting: 'hi again!' });
		}, 1000);

		incomingMessages.on('data', (message) => {
			outgoingMessages.send(message); // echo incoming messages
		});

		outgoingMessages.on('close', () => {
			clearInterval(timer);
		});

		return outgoingMessages;
	}
}
```

## MQTT over WebSockets

Harper also supports MQTT over WebSockets. The sub-protocol must be set to `mqtt` as required by the MQTT specification:

```http
Sec-WebSocket-Protocol: mqtt
```

See [MQTT Overview](../mqtt/overview.md) for full MQTT documentation.

## Message Ordering in Distributed Environments

Harper prioritizes low-latency delivery in distributed (multi-node) environments. Messages are delivered to local subscribers immediately upon arrival — Harper does not delay messages for inter-node coordination.

In a scenario where messages arrive out-of-order across nodes:

- **Non-retained messages** (published without a `retain` flag): Every message is delivered to subscribers in the order received, even if out-of-order relative to other nodes. Good for use cases like chat where every message must be delivered.
- **Retained messages** (published with `retain`, or PUT/updated in the database): Only the message with the latest timestamp is kept as the "winning" record. Out-of-order older messages are not re-delivered. This ensures eventual consistency of the most recent record state across the cluster. Good for use cases like sensor readings where only the latest value matters.

## See Also

- [Server-Sent Events](./server-sent-events.md) — One-way real-time streaming
- [MQTT Overview](../mqtt/overview.md) — Full MQTT pub/sub documentation
- [REST Overview](./overview.md) — HTTP methods and URL structure
- [Resources](../resources/overview.md) — Custom resource API including `connect()`
