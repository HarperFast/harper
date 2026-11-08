---
section: 'Subscriptions'
order: 30
---

### MCP Clients Can Subscribe to Custom Resources

A static `mcpResources` entry can now name a `subscribe` method, so MCP clients can watch a custom URI such as `memory:///{id}` with `resources/subscribe`. The method is called like the entry's read method, as the session's user, and returns an async iterable. Each value it yields sends `notifications/resources/updated` with the URI. Harper releases the stream on unsubscribe, when the GET stream closes, and on `DELETE /mcp`. For subscriptions tied to a stored user, delivery also stops if that user is dropped or no longer has a role. Updates also stop at the earlier POST/GET bearer expiry. A subscribe that fails now answers a JSON-RPC error instead of an HTTP 500, for row-backed resources too. See [Subscribing to custom resources](/reference/v5/mcp/tools-and-resources#subscribing-to-custom-resources).
