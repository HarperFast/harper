---
section: 'MCP'
order: 10
---

### Session Creation Is Rate-Limited by Default

MCP `initialize` is now limited per client identity, on both profiles, by the new `mcp.<profile>.rateLimit.initializePerSecond` (default `10`) and `initializeBurst` (default `50`). Each session is a stored row kept for the idle timeout, and the application profile accepts anonymous `initialize`, so this limit is on by default; set `initializePerSecond: 0` to turn it off. A denied `initialize` gets HTTP `429` with a `Retry-After` header and a JSON-RPC error, and no session is created. Clients that open sessions in bursts, such as a test suite or a pool of agents behind one IP address, may now see that `429` after upgrading. `initialize` also stores only the names of the client capabilities Harper checks (`sampling`, `elicitation`, `roots`), not the capabilities object the client sent. See [`initializePerSecond`](/reference/v5/mcp/configuration#mcpprofileratelimitinitializepersecond) ([harper#3537](https://github.com/HarperFast/harper/pull/3537)).
