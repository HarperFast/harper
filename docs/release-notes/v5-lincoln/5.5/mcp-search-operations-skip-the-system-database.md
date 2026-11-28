---
section: 'MCP'
---

### MCP Search Operations Skip the System Database

With the default `mcp.operations.allow` list, the `search_*` tools (`search_by_value`, `search_by_conditions`, `search_by_hash`, `search_by_id`) refuse a request whose `database` (or legacy `schema`) is `system`. Before, a super_user MCP session could read `system.hdb_user` through them and get every user's stored `password` hash into the model's context, although `list_users` removes that field. Use `list_users` for users. A deployment that sets `mcp.operations.allow` explicitly decides for itself and is not filtered. See [Default-allow list](/reference/v5/mcp/tools-and-resources#default-allow-list) ([harper#4017](https://github.com/HarperFast/harper/issues/4017)).
