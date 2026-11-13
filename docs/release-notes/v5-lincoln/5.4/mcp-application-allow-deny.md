---
section: MCP
---

### Application-Profile Allow and Deny Lists Take Effect

`mcp.application.allow` and `mcp.application.deny` were documented and accepted by config validation, but the application profile ignored them, so every generated verb tool and custom `mcpTools` entry stayed exposed. They now filter application-profile tools by name with the operations profile's glob rules: a tool they exclude is neither listed nor callable. With `allow` unset or empty, the profile exposes every tool, as before. Review an application-profile `allow` or `deny` you set earlier, because it now applies.

The new `mcp.application.generatedTools: false` stops generating verb tools from exported Resources, so the only tools a component publishes are the `mcpTools` it declares; exported tables stay readable as MCP resources. See [`mcp.application.allow`](/reference/v5/mcp/configuration#mcpapplicationallow) and [`mcp.application.generatedTools`](/reference/v5/mcp/configuration#mcpapplicationgeneratedtools).
