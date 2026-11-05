---
id: configuration
title: Authentication Configuration
sidebar_position: 20
sidebar_label: 'Configuration'
---

<!-- Source: versioned_docs/version-4.7/deployments/configuration.md (authentication section, primary) -->

Harper's authentication system is configured via the top-level `authentication` section of `harper-config.yaml`.

```yaml
authentication:
  authorizeLocal: true
  cacheTTL: 30000
  enableSessions: true
  operationTokenTimeout: 1d
  refreshTokenTimeout: 30d
  hashFunction: sha256
```

## Options

### `authorizeLocal`

_Type: boolean — Default: `true`_

Automatically authorizes requests from a loopback IP address (such as `127.0.0.1` or `::1`) as a super user, without requiring credentials. This also applies to raw-TCP MQTT connections from loopback when no credentials are supplied. Disable this for any Harper server that may be accessed by untrusted users from the same instance — for example, when using a local proxy or for general server hardening.

Three things to know before relying on either setting:

- **It is read once at startup.** Changing it does not affect a running instance; restart Harper for the new value to take effect.
- **A same-host reverse proxy makes remote traffic look local.** If a proxy on the Harper node forwards to Harper, requests arrive from `127.0.0.1` however remote the original client was, so leaving this enabled authorizes those clients as superuser. Choosing a non-loopback target URL does not avoid this.
- **It does not gate the operations API domain socket.** A connection arriving on that socket is authorized as superuser regardless of this setting, which is what lets local `harper` CLI commands work without credentials. Disabling this option therefore does not protect a proxy whose upstream is the socket — do not expose the socket through a proxy, and treat filesystem permissions on it as the access control.

For why this matters to a CI pipeline whose token has expired, see [Token credentials for CI/CD](../cli/authentication.md#token-credentials-for-cicd).

#### Local request identity

<VersionBadge type="changed" version="v5.4.0" />

Requests trusted by `authorizeLocal` or the operations API domain socket run as a built-in super user named `local`, with no record in `system.hdb_user`. Previously, they ran as the first stored user whose role was named `super_user`. Local socket and CLI access now work even when no users exist or the administrator's role has another name. Explicit credentials still authenticate as the supplied user.

For these requests, `user_info` returns `username: "local"`, and audit-log entries, job owners, and other user attribution read `local`. [Creating authentication tokens](../operations-api/operations.md#create_authentication_tokens) selects a stored user instead.

Local trust is never saved as session authentication: a cookie created during a locally trusted request does not authenticate anyone when used from elsewhere. Logging in with real credentials over a local connection still creates a normal session for that user.

### `cacheTTL`

_Type: number — Default: `30000`_

How long (in milliseconds) an authentication result — a particular `Authorization` header or token — can be cached. Increasing this improves performance at the cost of slower revocation.

### `enableSessions`

_Type: boolean — Default: `true`_

<VersionBadge version="v4.2.0" />

Enables cookie-based sessions to maintain an authenticated session across requests. This is the preferred authentication mechanism for web browsers: cookies hold the token securely without exposing it to JavaScript, reducing XSS vulnerability risk.

See [Local request identity](#local-request-identity) for why transport trust does not authenticate a session.

### `operationTokenTimeout`

_Type: string — Default: `1d`_

How long a JWT operation token remains valid before expiring. Accepts [`jsonwebtoken`-compatible](https://github.com/auth0/node-jsonwebtoken#token-expiration-exp-claim) duration strings (e.g., `1d`, `12h`, `60m`). See [JWT Authentication](./jwt-authentication.md).

### `refreshTokenTimeout`

_Type: string — Default: `30d`_

How long a JWT refresh token remains valid before expiring. Accepts [`jsonwebtoken`-compatible](https://github.com/auth0/node-jsonwebtoken#token-expiration-exp-claim) duration strings. See [JWT Authentication](./jwt-authentication.md).

### `hashFunction`

_Type: string — Default: `sha256`_

<VersionBadge version="v4.5.0" />

Password hashing algorithm used when storing user passwords. Replaced the previous MD5 hashing. Options:

- **`sha256`** — Default. Good security and excellent performance.
- **`argon2id`** — Highest security. More CPU-intensive; recommended for environments that do not require frequent password verifications.

## Related

- [Response Header Hardening](./response-headers.md) — Setting browser security headers (`X-Content-Type-Options`, CSP, etc.) and cache-control on Harper responses.
- [JWT Authentication](./jwt-authentication.md)
- [Basic Authentication](./basic-authentication.md)
- [Users & Roles / Configuration](../users-and-roles/configuration.md)
