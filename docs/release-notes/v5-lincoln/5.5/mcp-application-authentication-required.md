---
section: 'MCP'
---

### Requiring Authentication on the Application MCP Endpoint

`mcp.application.authentication.required: true` makes the application-profile `/mcp` serve only authenticated requests. A request with no principal gets `401` with `WWW-Authenticate: Bearer resource_metadata="…"` (RFC 9728) instead of an anonymous session, which is what OAuth MCP clients such as Claude's connectors need before they start signing in. The metadata URL comes from `mcp.application.authentication.resourceMetadata`, or from the new `challenge.resourceMetadata` option of [`server.registerBearerValidator()`](/reference/v5/http/api#serverregisterbearervalidatorvalidator-options), which an OAuth plugin can set. A rejected Bearer token on `/mcp` now also names that URL, with `error="invalid_token"`, when one is known. Anonymous access stays the default. See [`mcp.application.authentication.required`](/reference/v5/mcp/configuration#mcpapplicationauthenticationrequired).
