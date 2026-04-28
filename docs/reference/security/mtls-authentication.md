---
id: mtls-authentication
title: mTLS Authentication
---

<!-- Source: versioned_docs/version-4.7/developers/security/mtls-auth.md (primary) -->
<!-- Source: release-notes/v4-tucker/4.3.0.md (confirmed mTLS introduction) -->

<VersionBadge version="v4.3.0" />

Harper supports Mutual TLS (mTLS) authentication for incoming HTTP connections. When enabled, the client must present a certificate signed by a trusted Certificate Authority (CA). If the certificate is valid and trusted, the connection is authenticated using the user whose username matches the `CN` (Common Name) from the client certificate's `subject`.

## How It Works

1. The client presents a TLS certificate during the handshake.
2. Harper validates the certificate against the configured CA (`tls.certificateAuthority`).
3. If valid, Harper extracts the `CN` from the certificate subject and uses it as the username for the request.
   1. Or it is configurable via the `http.mtls.user` option in the relevant configuration object.
4. Optionally, Harper checks whether the certificate has been revoked (see [Certificate Verification](./certificate-verification.md)).

## Configuration

mTLS is configured via the `http.mtls` section in `harper-config.yaml`.

**Require mTLS for all connections:**

```yaml
http:
  mtls:
    required: true
tls:
  certificateAuthority: ~/hdb/keys/ca.pem
```

**Make mTLS optional (accept both mTLS and non-mTLS connections):**

```yaml
http:
  mtls:
    required: false
tls:
  certificateAuthority: ~/hdb/keys/ca.pem
```

When `required` is `false`, clients that do not present a certificate will fall back to other authentication methods (Basic Auth or JWT).

For more configuration information see the [HTTP / Configuration](../http/configuration.md) and [HTTP / TLS](../http/tls.md) sections.

## Certificate Revocation Checking

When using mTLS, you can optionally enable certificate revocation checking to ensure that revoked certificates cannot authenticate, even if they are otherwise valid and trusted.

To enable:

```yaml
http:
  mtls:
    required: true
    certificateVerification: true
```

Certificate revocation checking is **disabled by default** and must be explicitly enabled. For full details on CRL and OCSP configuration, see [Certificate Verification](./certificate-verification.md).

## User Identity

The username for the mTLS-authenticated request is derived from the `CN` field of the client certificate's subject. Ensure the CN value matches an existing Harper user account. See [Users and Roles](../users-and-roles/overview.md) for managing user accounts.

## Setup Requirements

To use mTLS you need:

1. A Certificate Authority (CA) certificate configured in `tls.certificateAuthority`.
2. Client certificates signed by that CA, with a `CN` matching a Harper username.
3. The `http.mtls` configuration enabled.

For help generating and managing certificates, see [Certificate Management](./certificate-management.md).

## Replication

mTLS is always required for Harper replication and cannot be disabled. For replication-specific mTLS configuration, see [Replication Configuration](../replication/clustering.md).
