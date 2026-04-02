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
- [Impersonation](./impersonation.md) — Execute operations as a different user or role.

## API

- [Security API](./api.md) — JavaScript globals for security operations (e.g. `auth()`).

## Default Behavior

Out of the box, Harper:

- Generates self-signed TLS certificates at `<ROOTPATH>/keys/` on first run.
- Runs with HTTPS disabled (HTTP only on port 9925 for the Operations API). It is recommended that you never directly expose Harper's HTTP interface through a publicly available port.
- Enables CORS for all origins (configurable).
- Supports Basic Auth and JWT Auth by default; mTLS must be explicitly configured.
