---
id: configuration
title: MQTT Configuration
sidebar_position: 20
sidebar_label: 'Configuration'
---

<!-- Source: versioned_docs/version-4.7/deployments/configuration.md (mqtt section - primary) -->
<!-- Source: versioned_docs/version-4.7/developers/real-time.md (mqtt configuration example) -->
<!-- Source: release-notes/v4-tucker/4.2.0.md (confirmed mqtt section added to config) -->
<!-- Source: release-notes/v4-tucker/4.3.0.md (confirmed mTLS support added) -->
<!-- Source: release-notes/v4-tucker/4.5.0.md (confirmed default replication port change - note: this is the replication port, not MQTT) -->

The `mqtt` section in `harper-config.yaml` controls Harper's built-in MQTT broker. MQTT is enabled by default.

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

## Connection Rate Limit

### `mqtt.network.connectionRateLimit`

<VersionBadge version="v5.5.0" />

Type: `object`

Default: none (no limit)

Limits how fast one source address can open new MQTT connections on `mqtt.network.port` and `mqtt.network.securePort`. A connection over the limit is reset as soon as it is accepted: on `securePort` that is before the TLS handshake, and on both ports it is before any MQTT packet is read or logged. Use it to keep a flood of connections from a few addresses, such as bots that are refused at authentication anyway, from consuming the CPU each handshake and rejection costs.

| Property    | Type   | Default     | Description                                                                                                  |
| ----------- | ------ | ----------- | ------------------------------------------------------------------------------------------------------------ |
| `perSecond` | number | `0`         | New connections per second admitted from one source address once its burst is spent. `0` disables the limit. |
| `burst`     | number | `perSecond` | Connections one source address can open back to back before `perSecond` applies. Never less than `1`.        |

```yaml
mqtt:
  network:
    connectionRateLimit:
      perSecond: 5
      burst: 20
```

- **Per source address.** IPv4 addresses are limited individually, an IPv4-mapped IPv6 address counts as its IPv4 address, and IPv6 addresses share one limit per `/64`. The TCP and TLS ports share one allowance.
- **Per worker thread.** Each thread keeps its own counts. Where every thread accepts on the MQTT ports (Linux), one address's connections are spread across threads, so the node-wide limit is up to `perSecond` (and `burst`) times the thread count.
- **Behind a proxy.** On the Unix domain socket mirror a fronting proxy connects to (`tls.unixDomainSockets`), the limit applies to the client address the proxy forwards in its PROXY protocol header. The proxy has already completed TLS there, so the limit saves the MQTT and authentication work, not the handshake. A connection with no forwarded address is not limited.
- **Many clients behind one address.** Devices behind one NAT share an address and so share its allowance. Set `burst` high enough for them to reconnect together after an outage.
- **Not covered.** MQTT over WebSockets (`mqtt.webSocket`) is served by the HTTP port and is not limited by this setting.

Dropped connections are not logged one by one; each thread logs a warning with the count at most once a minute.

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

Controls whether credentials are required to establish an MQTT connection. When `true`, clients must authenticate with either a username/password or a valid mTLS client certificate, except that [`authentication.authorizeLocal`](../security/configuration.md#authorizelocal) permits raw-TCP loopback connections without CONNECT credentials. From v5.4.0, that transport trust uses the built-in [`local` super user](../security/configuration.md#local-request-identity).

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
