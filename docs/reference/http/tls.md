---
id: tls
title: TLS Configuration
---

<!-- Source: versioned_docs/version-4.7/deployments/configuration.md (tls section - primary) -->
<!-- Source: release-notes/v4-tucker/4.2.0.md (confirmed top-level tls section added) -->

Harper uses a top-level `tls` section in `harper-config.yaml` to configure Transport Layer Security. This configuration is shared by the HTTP server (HTTPS), the MQTT broker (secure MQTT), and any TLS socket servers created via the [HTTP API](./api#serversocketlistener-options).

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

Colon-separated list of allowed TLS cipher suites, optionally ending with an OpenSSL security level command such as `@SECLEVEL=0`. When omitted everywhere, Node.js [default ciphers](https://nodejs.org/api/crypto.html#nodejs-crypto-constants) are used. See Node.js [Modifying the default TLS cipher suite](https://nodejs.org/api/tls.html#modifying-the-default-tls-cipher-suite) for more information.

`ciphers` may be set at the top level, on individual `tls` array entries, or on certificates added through the operations API. A TLS listener has exactly one effective cipher string, so Harper composes these sources — see [Cipher Suites and Security Level](#cipher-suites-and-security-level).

## Cipher Suites and Security Level

<VersionBadge type="changed" version="v5.2.0" />

Every configured `ciphers` source is now honored on the Node.js (OpenSSL) TLS path; previously only `tls.ciphers` (or the first array entry's) took effect and all others were silently ignored. TLS listeners on the Bun runtime (BoringSSL) do not apply this resolution — BoringSSL has no `@SECLEVEL` concept.

A TLS listener has a single effective cipher string: OpenSSL applies the cipher list — and any `@SECLEVEL` command in it — from the configuration the listener was created with. The security level is connection-wide: it constrains cipher algorithms, curves, signature algorithms, DH sizes, and certificate key and signature strength for every connection on the listener, including client-certificate chain verification. A per-certificate value cannot take effect on its own, so Harper resolves one effective string per listener from every relevant source:

- The listener's own `tls` section, in priority order: `operationsApi.tls` for the Operations API listener, then the root `tls` section — an object's `ciphers` directly, and an array's relevant entries. The same relevance rules as certificate records apply to array entries (matching `uses`, no `uses`, or the legacy generic `https`; certificate-authority entries only for mTLS-verifying listeners), so an entry scoped to another listener — for example an Operations-API-only entry — does not alter the application listener.
- Certificate records (including certificates added with the `add_certificate` operation) whose `uses` matches the listener, plus records with no `uses` and the legacy generic `https` use.
- Certificate authority entries and records participate only for listeners that verify client certificates (mTLS) — a CA's required security level matters exactly when its chains are being verified, and does not relax listeners without mTLS.

The resolution composes two separable parts:

- **Cipher suites** come from the highest-priority source that specifies any — a CA entry cannot replace or broaden the listener's configured suite list.
- **Security level** is the minimum explicit `@SECLEVEL` across all relevant sources. Sources without an explicit `@SECLEVEL` keep the runtime default. Because the level is connection-wide, composing in a low level (for example `@SECLEVEL=0` required by one legacy CA) relaxes the strength requirements for every connection on that listener, not just the chains that needed it.

For example, a listener configured with strict suites plus a legacy client CA whose chain requires a relaxed level:

```yaml
http:
  securePort: 9927
  mtls: true

tls:
  - certificate: ~/hdb/keys/certificate.pem
    privateKey: ~/hdb/keys/privateKey.pem
    ciphers: HIGH:!aNULL
  - certificateAuthority: ~/hdb/keys/legacy-client-ca.pem
    ciphers: DEFAULT@SECLEVEL=0
```

resolves to `HIGH:!aNULL@SECLEVEL=0` — the configured suites are preserved while the relaxed security level lets legacy chains verify, for example client certificate chains containing SHA-1 signatures on a leaf or intermediate certificate, which otherwise fail verification on modern OpenSSL. A directly trusted root's own self-signature is not checked, so a SHA-1-self-signed root alone does not require a relaxed level.

Whenever values are composed across sources or a suite list cannot be applied, Harper logs a warning describing what was used and what was ignored. The effective cipher string is fixed when the listener starts: if a later certificate change (such as `add_certificate` with a `ciphers` value) alters the resolved value, Harper logs a warning that a restart is required to apply it.

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
