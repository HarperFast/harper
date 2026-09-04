---
id: overview
title: Security
---

<!-- Source: versioned_docs/version-4.7/developers/security/index.md (primary) -->
<!-- Source: versioned_docs/version-4.7/developers/security/configuration.md (for CORS/SSL overview) -->

Harper uses role-based, attribute-level security to ensure that users can only gain access to the data they are supposed to be able to access. Granular permissions allow for unparalleled flexibility and control, and can lower the total cost of ownership compared to other database solutions, since you no longer need to replicate subsets of data to isolate use cases.

## Security Philosophy

Harper's security model has two distinct layers:

**Authentication** determines _who_ is making a request. Harper validates each request using one of the methods above, then resolves the caller to a known Harper user account.

**Authorization** determines _what_ the caller can do. Each Harper user is assigned a role. Roles carry a permissions set that grants or denies CRUD access at the table and attribute level, in addition to controlling access to system operations.

For details on how roles and permissions work, see [Users and Roles](../users-and-roles/overview.md).

## Authentication Methods

Harper supports three authentication methods:

- [Basic Authentication](./basic-authentication.md) — Username and password sent as a Base64-encoded `Authorization` header on every request.
- [JWT Authentication](./jwt-authentication.md) — Token-based authentication using JSON Web Tokens. Clients authenticate once and receive short-lived operation tokens and longer-lived refresh tokens.
- [mTLS Authentication](./mtls-authentication.md) — Mutual TLS certificate-based authentication.

## Authentication and Route Ownership

<VersionBadge type="changed" version="v5.3.0" />

On the application HTTP port, Harper attempts authentication before resolving which handler owns a request. A valid Harper credential establishes the Harper user as usual. When a Basic or Bearer credential is not recognized by Harper, Harper preserves the original `Authorization` header and defers the unauthorized response until a handler claims the request.

A Harper-owned route returns the normal unauthorized response before running its operation. If no Harper route claims the request, a later application handler receives the unchanged header and can apply its own authentication scheme. If no handler claims the request, the request ends as not found. Authentication infrastructure failures are not deferred and remain fail-closed.

When a request carries a deferred credential, Harper does not rewrite the unauthorized response that comes back. An application handler's own `401` — including its `WWW-Authenticate` challenge for its own scheme — is returned to the client as the handler wrote it, and Harper does not substitute its own challenge or redirect the request to a configured login page. A Harper-owned route settling the deferred credential answers exactly as it did before this behavior existed.

A WebSocket or MQTT-over-WebSocket upgrade carrying an unrecognized credential is closed with WebSocket close code `3000` rather than being established as an anonymous connection.

This behavior is automatic and has no configuration option. Application handlers that accept non-Harper credentials are responsible for validating those credentials before serving protected content. See [HTTP request handling](../http/overview.md#authentication-and-fallthrough) for the middleware ownership contract.

## Certificate Management

- [Certificate Management](./certificate-management.md) — Managing TLS certificates and Certificate Authorities for HTTPS and mTLS.
- [Certificate Verification](./certificate-verification.md) — Certificate revocation checking via CRL and OCSP.

## Access Control

- CORS — Cross-Origin Resource Sharing.
  - For HTTP server configuration see [HTTP / Configuration / CORS](../http/configuration.md#cors)
  - For Operations API configuration see [Operations API / Configuration](../configuration/operations.md)
- SSL & HTTPS — Enabling HTTPS and configuring TLS for the HTTP server.
  - For HTTP server configuration see [HTTP / Configuration / TLS](../http/tls.md)
  - For Operations API configuration see [Operations API / Configuration](../configuration/operations.md)
- [Users and Roles](../users-and-roles/overview.md) — Role-Based Access Control (RBAC): defining roles, assigning permissions, and managing users.
- [Web Application Firewall](../web-application-firewall/overview.md) — Rule-based filtering for HTTP requests before authentication and application routing.
- [Impersonation](./impersonation.md) — Execute operations as a different user or role.

## API

- [Security API](./api.md) — JavaScript globals for security operations (e.g. `auth()`).

## Default Behavior

Out of the box, Harper:

- Generates self-signed TLS certificates at `<ROOTPATH>/keys/` on first run.
- Runs with HTTPS disabled (HTTP only on port 9925 for the Operations API). It is recommended that you never directly expose Harper's HTTP interface through a publicly available port.
- Enables CORS for all origins (configurable).
- Supports Basic Auth and JWT Auth by default; mTLS must be explicitly configured.
