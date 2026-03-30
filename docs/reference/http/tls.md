---
id: tls
title: TLS Configuration
---

<!-- Source: versioned_docs/version-4.7/deployments/configuration.md (tls section - primary) -->
<!-- Source: release-notes/v4-tucker/4.2.0.md (confirmed top-level tls section added) -->

Harper uses a top-level `tls` section in `harperdb-config.yaml` to configure Transport Layer Security. This configuration is shared by the HTTP server (HTTPS), the MQTT broker (secure MQTT), and any TLS socket servers created via the [HTTP API](./api#serversocketlistener-options).

The `operationsApi` section can optionally define its own `tls` block, which overrides the root `tls` for Operations API traffic only. See the [Operations API Configuration](../configuration/operations.md) for more details.

Harper must be restarted for TLS configuration changes to take effect.

## TLS Configuration

```yaml
tls:
  certificate: ~/hdb/keys/certificate.pem
  certificateAuthority: ~/hdb/keys/ca.pem
  privateKey: ~/hdb/keys/privateKey.pem
```

### `tls.certificate`

Type: `string`

Default: `"<rootPath>/keys/certificate.pem"`

Path to the PEM-encoded certificate file.

### `tls.certificateAuthority`

Type: `string`

Default: `"<rootPath>/keys/ca.pem"`

Path to the PEM-encoded certificate authority (CA) file. Used to verify client certificates when mTLS is enabled.

### `tls.privateKey`

Type: `string`

Default: `"<rootPath>/keys/privateKey.pem"`

Path to the PEM-encoded private key file.

### `tls.host`

Type: `string | undefined`

The domain name this certificate entry applies to, used for SNI (Server Name Indication) matching. Only relevant when `tls` is defined as an array. When omitted, the certificate's common name (CN) is used as the host name.

### `tls.ciphers`

Type: `string | undefined`

Default: `crypto.defaultCipherList`

Colon-separated list of allowed TLS cipher suites. When omitted, Node.js [default ciphers](https://nodejs.org/api/crypto.html#nodejs-crypto-constants) are used. See Node.js [Modifying the default TLS cipher suite](https://nodejs.org/api/tls.html#modifying-the-default-tls-cipher-suite) for more information.

## Enabling HTTPS

To enable HTTPS, set `http.securePort` in addition to the `tls` section:

```yaml
http:
  securePort: 9927

tls:
  certificate: ~/hdb/keys/certificate.pem
  certificateAuthority: ~/hdb/keys/ca.pem
  privateKey: ~/hdb/keys/privateKey.pem
```

When `http.securePort` is set, Harper accepts plaintext connections on `http.port` and TLS connections on `http.securePort` simultaneously.

## Multi-Domain Certificates (SNI)

To serve different certificates for different domains using Server Name Indication (SNI), define `tls` as an array of configuration objects. Each entry can optionally include a `host` property specifying which domain it applies to. If `host` is omitted, the certificate's common name and subject alternate names (SANs) are used.

```yaml
tls:
  - certificate: ~/hdb/keys/certificate1.pem
    certificateAuthority: ~/hdb/keys/ca1.pem
    privateKey: ~/hdb/keys/privateKey1.pem
    host: example.com
  - certificate: ~/hdb/keys/certificate2.pem
    certificateAuthority: ~/hdb/keys/ca2.pem
    privateKey: ~/hdb/keys/privateKey2.pem
    # host omitted: certificate's CN is used
```

## Operations API Override

The `operationsApi` section can define its own `tls` block to use a separate certificate for the Operations API:

```yaml
tls:
  certificate: ~/hdb/keys/certificate.pem
  certificateAuthority: ~/hdb/keys/ca.pem
  privateKey: ~/hdb/keys/privateKey.pem

operationsApi:
  network:
    securePort: 9924
  tls:
    certificate: ~/hdb/keys/ops-certificate.pem
    certificateAuthority: ~/hdb/keys/ops-ca.pem
    privateKey: ~/hdb/keys/ops-privateKey.pem
```

See the [Operations API Configuration](../configuration/operations.md) for more details.

## Related

- [HTTP Configuration](./configuration) — `http.securePort`, `http.http2`, `http.mtls`
- [HTTP Overview](./overview)
- [Security mTLS Authentication](../security/mtls-authentication.md)
