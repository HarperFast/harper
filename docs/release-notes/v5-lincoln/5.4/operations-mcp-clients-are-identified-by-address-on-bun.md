---
section: 'MCP'
order: 20
---

### Operations-Profile MCP Clients Are Identified by Address on Bun

Under Bun, the operations-profile MCP endpoint identified every client as `127.0.0.1`, so all clients shared one `initialize` limit and one [`perClientPerSecond`](/reference/v5/mcp/configuration#mcpprofileratelimitperclientpersecond) bucket, and a [quota handler](/reference/v5/mcp/configuration#serversetmcpquotahandlerhandler) received `127.0.0.1` as every client's `identity`. Each client is now identified by its own address, as on Node, so a quota handler that counted under `127.0.0.1` starts a fresh count for each client.
