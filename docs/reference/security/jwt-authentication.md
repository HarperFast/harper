---
id: jwt-authentication
title: JWT Authentication
---

<!-- Source: versioned_docs/version-4.7/developers/security/jwt-auth.md (primary) -->s

Available since: v4.1.0

Harper supports token-based authentication using JSON Web Tokens (JWTs). Rather than sending credentials on every request, a client authenticates once and receives tokens that are used for subsequent requests.

## Tokens

JWT authentication uses two token types:

- **`operation_token`** — Used to authenticate all Harper operations via a `Bearer` token `Authorization` header. Default expiry: 1 day.
- **`refresh_token`** — Used to obtain a new `operation_token` when the current one expires. Default expiry: 30 days.

## Create Authentication Tokens

Call `create_authentication_tokens` with your Harper credentials. When the request carries a `username` and `password` in the body, no `Authorization` header is required — the operation authenticates from the body. Other shapes of this operation do need an authenticated caller: sending no credentials at all mints tokens for the user the request is already authenticated as, and [minting a scoped token](#scoped-tokens-inline-role) requires an authenticated `super_user`.

```json
{
	"operation": "create_authentication_tokens",
	"username": "username",
	"password": "password"
}
```

cURL example:

```bash
curl --location --request POST 'http://localhost:9925' \
  --header 'Content-Type: application/json' \
  --data-raw '{
      "operation": "create_authentication_tokens",
      "username": "username",
      "password": "password"
  }'
```

Response:

```json
{
	"operation_token": "<jwt-operation-token>",
	"refresh_token": "<jwt-refresh-token>"
}
```

## Using the Operation Token

Pass the `operation_token` as a `Bearer` token in the `Authorization` header on subsequent requests:

```bash
curl --location --request POST 'http://localhost:9925' \
  --header 'Content-Type: application/json' \
  --header 'Authorization: Bearer <operation_token>' \
  --data-raw '{
      "operation": "search_by_hash",
      "schema": "dev",
      "table": "dog",
      "hash_values": [1],
      "get_attributes": ["*"]
  }'
```

## Refreshing the Operation Token

When the `operation_token` expires, use the `refresh_token` to obtain a new one. Pass the `refresh_token` as the `Bearer` token:

```bash
curl --location --request POST 'http://localhost:9925' \
  --header 'Content-Type: application/json' \
  --header 'Authorization: Bearer <refresh_token>' \
  --data-raw '{
    "operation": "refresh_operation_token"
  }'
```

Response:

```json
{
	"operation_token": "<new-jwt-operation-token>"
}
```

When both tokens have expired, call `create_authentication_tokens` again with your username and password.

## Scoped Tokens (Inline Role)

Available since: v5.2.0

A super user can mint a **scoped token**: a single JWT whose permissions are embedded in the token itself, so the bearer needs no pre-existing user or role record. This is useful for handing a limited credential (for example, read-only access) to an external service or script without provisioning it in `hdb_user`.

Pass `role` as an inline role-shaped object (the same `permission` structure used by [`add_role`](../users-and-roles/overview.md), including the `operations` allowlist). Unlike the username/password flow above, this shape carries no credentials of its own — the **minter** must be authenticated as a `super_user`, and no `password` may be included in the body:

```json
{
	"operation": "create_authentication_tokens",
	"username": "reporting-service",
	"role": {
		"permission": {
			"operations": ["read_only"],
			"dev": {
				"tables": {
					"dog": { "read": true, "insert": false, "update": false, "delete": false, "attribute_permissions": [] }
				}
			}
		}
	},
	"expires_in": "7d"
}
```

Authenticate that request the way you would any other privileged operation — Basic Auth with a `super_user`'s credentials, or a `Bearer` `operation_token` already held by one:

```bash
curl --location --request POST 'http://localhost:9925' \
  --header 'Content-Type: application/json' \
  --header 'Authorization: Basic <base64 of super_user:password>' \
  --data-raw '{
      "operation": "create_authentication_tokens",
      "username": "reporting-service",
      "role": { "permission": { "operations": ["read_only"] } },
      "expires_in": "7d"
  }'
```

Without an authenticated `super_user` the mint is rejected with `403 Only super_user can create a token with an inline role`. From inside a component, pass the request context and `authorize: true` to [`server.operation()`](../http/api.md#serveroperationoperation-context-authorize) so the mint is attributed to — and permission-checked against — the calling user.

Response:

```json
{
	"operation_token": "<jwt-scoped-token>"
}
```

Behavior and constraints:

- **`username` is attribution only, and must not name an existing user.** It appears in audit logs and `user_info` for requests made with the token; a name that collides with a real `hdb_user` is rejected at mint. It defaults to `scoped:<minting user>`.
- **Permissions are enforced as embedded.** The `operations` allowlist limits which Operations API operations the bearer can call (including `sql`). Application/REST endpoints are governed by the embedded database/table permissions only — a token meant to be read-only on REST must set restrictive table permissions, not just a read-only `operations` list. `super_user` and `cluster_user` are always forced to `false` in the embedded role.
- **No refresh token is issued**, and no user record is created or modified.
- **Scoped tokens cannot be revoked before they expire.** They are not tied to a user row, so dropping or altering users has no effect on them; only expiry (or rotating the instance's JWT keys, which invalidates _all_ tokens) ends their validity. Choose `expires_in` accordingly — prefer short lifetimes.
- The permission object is validated at mint time (unknown operations, malformed shapes, and references to nonexistent databases/tables are rejected), and the resulting token must fit in an `Authorization` header (12KB limit).
- In mixed-version clusters, only nodes running a version with scoped-token support accept these tokens; older nodes reject them with a 401.

## Issuing Tokens from a Custom Resource

Custom Resources can mint tokens programmatically by invoking the same operations via [`server.operation()`](../http/api.md#serveroperationoperation-context-authorize). This is useful when you want a Resource-style endpoint (e.g., `POST /IssueTokens`) instead of (or in addition to) the raw Operations API.

```typescript
import { Resource, server } from 'harper';

export class IssueTokens extends Resource {
	static async get(_target, context) {
		// Caller is already authenticated (Basic Auth or an existing JWT) — issue
		// tokens for the current user.
		const { operation_token, refresh_token } = await server.operation(
			{ operation: 'create_authentication_tokens' },
			context,
			true
		);
		return { operation_token, refresh_token };
	}

	static async post(_target, data) {
		// Caller provides credentials in the body — issue tokens directly.
		const { username, password } = await data;
		if (!username || !password) {
			return new Response('username and password required', { status: 400 });
		}
		const { operation_token, refresh_token } = await server.operation({
			operation: 'create_authentication_tokens',
			username,
			password,
		});
		return { operation_token, refresh_token };
	}
}

export class RefreshJWT extends Resource {
	static async post(_target, data) {
		const { refresh_token } = await data;
		if (!refresh_token) {
			return new Response('refresh_token required', { status: 400 });
		}
		const { operation_token } = await server.operation({
			operation: 'refresh_operation_token',
			refresh_token,
		});
		return { operation_token };
	}
}
```

Pass `authorize: true` (third argument) when the operation should run as the current authenticated user; omit it (or pass `false`) when the operation supplies its own credentials.

## Token Expiry Configuration

Token timeouts are configurable in `harper-config.yaml` under the top-level `authentication` section:

```yaml
authentication:
  operationTokenTimeout: 1d # Default: 1 day
  refreshTokenTimeout: 30d # Default: 30 days
```

Valid duration string values follow the [`jsonwebtoken` package format](https://github.com/auth0/node-jsonwebtoken#token-expiration-exp-claim) (e.g., `1d`, `12h`, `60m`). See [Security / Configuration](./configuration.md) for the full authentication config reference.

## When to Use JWT Auth

JWT authentication is preferred over Basic Auth when:

- You want to avoid sending credentials on every request
- Your client can store and manage tokens
- You have multiple sequential requests and want to avoid repeated credential encoding

For simple or server-to-server scenarios, see [Basic Authentication](./basic-authentication.md).

## Security Notes

- Always use HTTPS in production to protect tokens in transit. See [HTTP / TLS](../http/tls.md).
- Store tokens securely; treat them like passwords.
- If a token is compromised, it will remain valid until it expires. Consider setting shorter `operationTokenTimeout` values in high-security environments.
