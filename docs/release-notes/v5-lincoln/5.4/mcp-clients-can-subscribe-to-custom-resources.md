---
section: 'Subscriptions'
order: 30
---

### MCP Clients Can Subscribe to Custom Resources

A static `mcpResources` entry can now name a `subscribe` method, so MCP clients can watch a custom URI such as `memory:///{id}` with `resources/subscribe`. The method is called like the entry's read method, as the session's user, and returns an async iterable; each value it yields sends `notifications/resources/updated` with the URI. Harper releases the stream on unsubscribe, when the GET stream closes, on `DELETE /mcp`, and when the session's token expires or its user is dropped. A subscribe that fails now answers a JSON-RPC error instead of an HTTP 500, for row-backed resources too, and a reconnecting GET stream opens without waiting for its subscriptions to be restored. See [Subscribing to custom resources](/reference/v5/mcp/tools-and-resources#subscribing-to-custom-resources).
