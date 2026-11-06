---
section: 'MCP'
order: 20
---

### Operations-Profile MCP Clients Are Identified by Address on Bun

Under Bun, the operations-profile MCP endpoint identified every client as `127.0.0.1`, so all clients shared one `initialize` limit and one [`perClientPerSecond`](/reference/v5/mcp/configuration#mcpprofileratelimitperclientpersecond) bucket. Each client is now identified by its own address, as on Node.
