---
section: 'Upgrade Notes'
---

### MCP Operation Contracts

MCP default and glob allow matches now require owned input schemas. If a custom glob previously exposed schema-less operations, add schemas at registration or name the needed operations literally in `mcp.operations.allow` to retain permissive discovery. A nonempty allow list replaces the defaults. Handler validation and authorization remain enforced, and conflicting worker contracts stay hidden.

Default visibility also requires a read-only classification; main-thread component registrations can declare `readOnly: true`, while worker-forwarded operations need explicit allow entries. `get_metrics` is no longer in the built-in default list. See [Operation metadata in 5.4](/reference/v5/mcp/migration#operation-metadata-in-54) and [Expose accurate MCP operation schemas across workers (#2532)](https://github.com/HarperFast/harper/pull/2532).
