---
section: 'Authentication'
order: 20
---

### Component Bearer Validators

`server.registerBearerValidator()` lets a component accept `Authorization: Bearer` tokens Harper did not issue, such as access tokens from its own OAuth authorization server. A validator maps a token to a Harper username; Harper resolves that user through `server.getUser()` and applies its role on every Harper route on the application port, including REST, GraphQL, WebSocket, MQTT over WebSocket and MCP. See [`server.registerBearerValidator()`](/reference/v5/http/api#serverregisterbearervalidatorvalidator-options).
