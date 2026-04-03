---
id: configuration
title: MQTT Configuration
---

<!-- Source: versioned_docs/version-4.7/deployments/configuration.md (mqtt section - primary) -->
<!-- Source: versioned_docs/version-4.7/developers/real-time.md (mqtt configuration example) -->
<!-- Source: release-notes/v4-tucker/4.2.0.md (confirmed mqtt section added to config) -->
<!-- Source: release-notes/v4-tucker/4.3.0.md (confirmed mTLS support added) -->
<!-- Source: release-notes/v4-tucker/4.5.0.md (confirmed default replication port change - note: this is the replication port, not MQTT) -->

The `mqtt` section in `harperdb-config.yaml` controls Harper's built-in MQTT broker. MQTT is enabled by default.

Harper must be restarted for configuration changes to take effect.

## Minimal Example

```yaml
mqtt:
  network:
    port: 1883
    securePort: 8883
  webSocket: true
  requireAuthentication: true
```

## Ports

### `mqtt.network.port`

Type: `integer`

Default: `1883`

The port for plaintext (non-TLS) MQTT connections.

### `mqtt.network.securePort`

Type: `integer`

Default: `8883`

The port for secure MQTT connections (MQTTS). Uses the `tls` configuration for certificates. See [TLS Configuration](../http/tls.md) for certificate setup.

## WebSocket

### `mqtt.webSocket`

Type: `boolean`

Default: `true`

Enables MQTT over WebSockets. When enabled, Harper handles WebSocket connections on the HTTP port (default `9926`) that specify the `mqtt` sub-protocol (`Sec-WebSocket-Protocol: mqtt`). This is required by the MQTT specification and should be set by any conformant MQTT-over-WebSocket client.

```yaml
mqtt:
  webSocket: true
```

## Authentication

### `mqtt.requireAuthentication`

Type: `boolean`

Default: `true`

Controls whether credentials are required to establish an MQTT connection. When `true`, clients must authenticate with either a username/password or a valid mTLS client certificate.

When set to `false`, unauthenticated connections are allowed. Unauthenticated clients are still subject to authorization on each publish and subscribe operation — by default, tables and resources do not grant access to unauthenticated users, but this can be configured at the resource level.

```yaml
mqtt:
  requireAuthentication: true
```

## mTLS

### `mqtt.network.mtls`

<VersionBadge version="v4.3.0" />

Type: `boolean | object`

Default: `false`

Enables mutual TLS (mTLS) authentication for MQTT connections. When set to `true`, client certificates are verified against the CA specified in the root `tls.certificateAuthority` section. Authenticated connections use the `CN` (common name) from the client certificate's subject as the Harper username by default.

```yaml
mqtt:
  network:
    mtls: true
```

For granular control, specify an object with the following optional properties:

### `mqtt.network.mtls.user`

Type: `string | null`

Default: Common Name from client certificate

Specifies a fixed username to authenticate all mTLS connections as. When set, any connection that passes certificate verification authenticates as this user regardless of the certificate's CN.

Setting to `null` disables credential-based authentication for mTLS connections. When combined with `required: true`, this enforces that clients must have a valid certificate AND provide separate credential-based authentication.

### `mqtt.network.mtls.required`

Type: `boolean`

Default: `false`

When `true`, all incoming MQTT connections must provide a valid client certificate. Connections without a valid certificate are rejected. By default, clients can authenticate with either mTLS or standard username/password credentials.

### `mqtt.network.mtls.certificateAuthority`

Type: `string`

Default: Path from `tls.certificateAuthority`

Path to the certificate authority (CA) file used to verify MQTT client certificates. By default, uses the CA configured in the root `tls` section. Set this if MQTT clients should be verified against a different CA than the one used for HTTP/TLS.

### `mqtt.network.mtls.certificateVerification`

Type: `boolean | object`

Default: `true`

When mTLS is enabled, Harper verifies the revocation status of client certificates using OCSP (Online Certificate Status Protocol). This ensures revoked certificates cannot be used for authentication.

Set to `false` to disable revocation checking, or configure as an object:

| Property      | Type    | Default       | Description                                                                                            |
| ------------- | ------- | ------------- | ------------------------------------------------------------------------------------------------------ |
| `timeout`     | integer | `5000`        | Maximum milliseconds to wait for an OCSP response.                                                     |
| `cacheTtl`    | integer | `3600000`     | Milliseconds to cache successful verification results (default 1h).                                    |
| `failureMode` | string  | `'fail-open'` | Behavior when OCSP verification fails: `'fail-open'` (allow, log warning) or `'fail-closed'` (reject). |

```yaml
mqtt:
  network:
    mtls:
      required: true
      certificateVerification:
        failureMode: fail-closed
        timeout: 5000
        cacheTtl: 3600000
```

## mTLS Examples

```yaml
# Require client certificate + standard credentials (combined auth)
mqtt:
  network:
    mtls:
      user: null
      required: true

# Authenticate all mTLS connections as a fixed user
mqtt:
  network:
    mtls:
      user: mqtt-service-account
      required: true

# mTLS optional — clients can use mTLS or credentials
mqtt:
  network:
    mtls: true
```

## Logging

### `mqtt.logging`

Type: `object`

Default: disabled

Configures logging for MQTT activity. Accepts the standard logging configuration options.

```yaml
mqtt:
  logging:
    path: ~/hdb/log/mqtt.log
    level: warn
    stdStreams: false
```

| Option       | Description                                       |
| ------------ | ------------------------------------------------- |
| `path`       | File path for the MQTT log output.                |
| `root`       | Alternative to `path` — sets the log directory.   |
| `level`      | Log level: `error`, `warn`, `info`, `debug`, etc. |
| `tag`        | Custom tag to prefix log entries.                 |
| `stdStreams` | When `true`, also logs to stdout/stderr.          |

## Complete Example

```yaml
mqtt:
  network:
    port: 1883
    securePort: 8883
    mtls:
      required: false
      certificateAuthority: ~/hdb/keys/ca.pem
      certificateVerification:
        failureMode: fail-open
        timeout: 5000
        cacheTtl: 3600000
  webSocket: true
  requireAuthentication: true
  logging:
    level: warn
    path: ~/hdb/log/mqtt.log

# TLS is a top-level section, shared with HTTP
tls:
  certificate: ~/hdb/keys/certificate.pem
  certificateAuthority: ~/hdb/keys/ca.pem
  privateKey: ~/hdb/keys/privateKey.pem
```

## Related

- [MQTT Overview](./overview)
- [TLS Configuration](../http/tls.md)
- [Security Overview](../security/overview.md)
- [Configuration Overview](../configuration/overview.md)
