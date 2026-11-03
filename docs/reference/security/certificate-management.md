---
id: certificate-management
title: Certificate Management
---

<!-- Source: versioned_docs/version-4.7/developers/security/certificate-management.md (primary) -->
<!-- Source: release-notes/v4-tucker/4.4.0.md (dynamic certificate management added) -->
<!-- Source: release-notes/v4-tucker/4.5.0.md (certificate revocation added) -->

This page covers certificate management for Harper's external-facing HTTP and Operations APIs. For replication certificate management, see [Replication Certificate Management](../replication/clustering.md).

## Default Behavior

On first run, Harper automatically generates self-signed TLS certificates at `<ROOTPATH>/keys/`:

- `certificate.pem` — The server certificate
- `privateKey.pem` — The server private key
- `ca.pem` — A self-signed Certificate Authority

These certificates have a valid Common Name (CN), but they are not signed by a root authority. HTTPS can be used with them, but clients must be configured to accept the invalid certificate.

## Development Setup

By default, HTTPS is disabled. HTTP is suitable for local development and trusted private networks. If you are developing on a remote server with requests traversing the Internet, enable HTTPS.

To enable HTTPS, set `http.securePort` in `harper-config.yaml` and restart Harper:

```yaml
http:
  securePort: 9926
```

Harper will use the auto-generated certificates from `<ROOTPATH>/keys/`.

## Production Setup

For production, use certificates from your own CA or a public CA, with CNs that match the Fully Qualified Domain Name (FQDN) of your Harper node.

### Option 1: Replace Harper Certificates

Enable HTTPS and replace the certificate files:

```yaml
http:
  securePort: 9926
tls:
  certificate: ~/hdb/keys/certificate.pem
  privateKey: ~/hdb/keys/privateKey.pem
```

Either replace the files at `<ROOTPATH>/keys/` in place, or update `tls.certificate` and `tls.privateKey` to point to your new files and restart Harper.

The `operationsApi.tls` section is optional. If not set, Harper uses the values from the top-level `tls` section. You can specify different certificates for the Operations API:

```yaml
operationsApi:
  tls:
    certificate: ~/hdb/keys/certificate.pem
    privateKey: ~/hdb/keys/privateKey.pem
```

### Option 2: Nginx Reverse Proxy

Instead of enabling HTTPS directly on Harper, use Nginx as a reverse proxy. Configure Nginx to handle HTTPS with certificates from your own CA or a public CA, then forward HTTP requests to Harper.

This approach keeps Harper's HTTP interface internal while Nginx handles TLS termination.

### Option 3: External Reverse Proxy / Load Balancer

External services such as an AWS Elastic Load Balancer or Google Cloud Load Balancing can act as TLS-terminating reverse proxies. Configure the service to accept HTTPS connections and forward over a private network to Harper as HTTP.

These services typically include integrated certificate management.

## mTLS Setup

Mutual TLS (mTLS) requires both client and server to present certificates. To enable mTLS, provide a CA certificate that Harper will use to verify client certificates:

```yaml
http:
  mtls:
    required: true
tls:
  certificateAuthority: ~/hdb/keys/ca.pem
```

For full mTLS authentication details, see [mTLS Authentication](./mtls-authentication.md).

## Certificate Verification

<VersionBadge version="v4.5.0" /> (certificate revocation); v4.7.0 (OCSP support)

When using mTLS, enable certificate verification to ensure revoked certificates cannot authenticate even if still within their validity period:

```yaml
http:
  mtls:
    required: true
    certificateVerification: true
```

Harper supports two industry-standard methods:

**CRL (Certificate Revocation List)**

- Downloaded and cached locally (24 hours by default)
- Fast verification after first download (no network requests)
- Best for high-volume verification and offline scenarios

**OCSP (Online Certificate Status Protocol)**

- Real-time query to the CA's OCSP responder
- Best for certificates without CRL distribution points
- Responses cached (1 hour by default)

**Harper's approach: CRL-first with OCSP fallback**

1. Checks CRL if available (fast, cached locally)
2. Falls back to OCSP if CRL is unavailable or fails
3. Applies the configured failure mode if both methods fail

For full configuration options and troubleshooting, see [Certificate Verification](./certificate-verification.md).

## Dynamic Certificate Management

<VersionBadge version="v4.4.0" />

Certificates — including CAs and private keys — can be dynamically managed without restarting Harper.

## Multiple Certificate Authorities

It is possible to use different certificates for the Operations API and the HTTP (custom application) API. For example, in scenarios where only your application endpoints need to be exposed to the Internet and the Operations API is reserved for administration, you may use a private CA for the Operations API and a public CA for your application certificates.

Configure each separately:

```yaml
# Top-level tls: used by HTTP/application endpoints
tls:
  certificate: ~/hdb/keys/app-certificate.pem
  privateKey: ~/hdb/keys/app-privateKey.pem

# Operations API can use a separate cert
operationsApi:
  tls:
    certificate: ~/hdb/keys/ops-certificate.pem
    privateKey: ~/hdb/keys/ops-privateKey.pem
```

## Renewing Certificates

The `harper renew-certs` CLI command renews the auto-generated Harper certificates. See [CLI Commands](../cli/commands.md) for details.

**Changes to TLS settings require a restart**, except where dynamic certificate management is used.
