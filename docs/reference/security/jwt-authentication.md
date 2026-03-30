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

Call `create_authentication_tokens` with your Harper credentials. No `Authorization` header is required for this operation.

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

## Token Expiry Configuration

Token timeouts are configurable in `harperdb-config.yaml` under the top-level `authentication` section:

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
