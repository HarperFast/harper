---
id: configuration
title: Logging Configuration
---

<!-- Source: versioned_docs/version-4.7/deployments/configuration.md (logging section, lines 858–1065 - primary) -->
<!-- Source: versioned_docs/version-4.7/administration/logging/standard-logging.md (rotation, stdStreams, clustering log level) -->
<!-- Source: release-notes/v4-tucker/4.2.0.md (confirmed auditAuthEvents.logFailed/logSuccessful added) -->
<!-- Source: release-notes/v4-tucker/4.6.0.md (confirmed per-component logging, dynamic reload, HTTP logging) -->

The `logging` section in `harperdb-config.yaml` controls standard log output. Many logging settings are applied dynamically without a restart (added in v4.6.0).

## Main Logger

### `logging.level`

Type: `string`

Default: `warn`

Controls the verbosity of logs. Levels from least to most severe: `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `notify`. Setting a level includes that level and all more-severe levels.

```yaml
logging:
  level: warn
```

For example, `level: warn` results in `warn`, `error`, `fatal`, and `notify` logs.

### `logging.path`

Type: `string`

Default: `<ROOTPATH>/log/hdb.log`

Full file path for the log file.

```yaml
logging:
  path: ~/hdb/log/hdb.log
```

### `logging.root`

Type: `string`

Default: `<ROOTPATH>/log`

Directory path where log files are written. Use `path` to specify the full filename; use `root` to specify only the directory (Harper determines the filename).

```yaml
logging:
  root: ~/hdb/log
```

### `logging.file`

Type: `boolean`

Default: `true`

Whether to write logs to a file. Disable if you want to use only standard streams.

```yaml
logging:
  file: true
```

### `logging.stdStreams`

Type: `boolean`

Default: `false`

Log to `stdout`/`stderr` in addition to (or instead of) the log file.

When enabled, run Harper in the foreground (`harper`, not `harper start`).

```yaml
logging:
  stdStreams: true
```

### `logging.console`

Type: `boolean`

Default: `false`

Controls whether `console.log` and other `console.*` calls (and anything writing to `process.stdout`/`process.stderr` from JS components) are captured to the log file.

```yaml
logging:
  console: true
```

### `logging.auditLog`

Type: `boolean`

Default: `false`

Enables audit (table transaction) logging. When enabled, Harper records every insert, update, and delete to a corresponding audit table. Audit log data is accessed via the `read_audit_log` operation.

See [Database / Transaction Logging](../database/transaction.md) for details on using audit logs.

```yaml
logging:
  auditLog: false
```

### `logging.auditRetention`

Type: `string | number`

Default: `3d`

How long audit log entries are retained before automatic eviction. Accepts duration strings (e.g., `3d`, `12h`) or milliseconds.

```yaml
logging:
  auditRetention: 3d
```

## Log Rotation

Rotation provides systematic management of the `hdb.log` file — compressing, archiving, and replacing it on a schedule or size threshold. Rotation is triggered when either `interval` or `maxSize` is set.

> `interval` and `maxSize` are approximates only. The log file may exceed these values slightly before rotation occurs.

### `logging.rotation.enabled`

Type: `boolean`

Default: `true`

Enables log rotation. Rotation only activates when `interval` or `maxSize` is also set.

### `logging.rotation.compress`

Type: `boolean`

Default: `false`

Compress rotated log files with gzip.

### `logging.rotation.interval`

Type: `string`

Default: `null`

Time between rotations. Accepted units: `D` (days), `H` (hours), `M` (minutes). Example: `1D`, `12H`.

### `logging.rotation.maxSize`

Type: `string`

Default: `null`

Maximum log file size before rotation. Accepted units: `K` (kilobytes), `M` (megabytes), `G` (gigabytes). Example: `100M`, `1G`.

### `logging.rotation.path`

Type: `string`

Default: `<ROOTPATH>/log`

Directory for storing rotated log files. Rotated files are named: `HDB-YYYY-MM-DDT-HH-MM-SSSZ.log`.

```yaml
logging:
  rotation:
    enabled: true
    compress: false
    interval: 1D
    maxSize: 100M
    path: ~/hdb/log
```

## Authentication Logging

### `logging.auditAuthEvents.logFailed`

<VersionBadge version="v4.2.0" />

Type: `boolean`

Default: `false`

Log all failed authentication attempts.

Example log entry:

```
[error] [auth-event]: {"username":"admin","status":"failure","type":"authentication","originating_ip":"127.0.0.1","request_method":"POST","path":"/","auth_strategy":"Basic"}
```

### `logging.auditAuthEvents.logSuccessful`

<VersionBadge version="v4.2.0" />

Type: `boolean`

Default: `false`

Log all successful authentication events.

Example log entry:

```
[notify] [auth-event]: {"username":"admin","status":"success","type":"authentication","originating_ip":"127.0.0.1","request_method":"POST","path":"/","auth_strategy":"Basic"}
```

```yaml
logging:
  auditAuthEvents:
    logFailed: false
    logSuccessful: false
```

## Per-Component Logging

<VersionBadge version="v4.6.0" />

Harper supports independent logging configurations for different components. Each component logger can have its own `path`, `root`, `level`, `tag`, and `stdStreams` settings. All components default to the main `logging` configuration unless overridden.

### `logging.external`

Logging configuration for all external components that use the [`logger` API](./api).

```yaml
logging:
  external:
    level: warn
    path: ~/hdb/log/apps.log
```

### `http.logging`

HTTP request logging. Disabled by default — defining this section enables it.

```yaml
http:
  logging:
    level: info # info = all requests, warn = 4xx+, error = 5xx
    path: ~/hdb/log/http.log
    timing: true # log request duration
    headers: false # log request headers (verbose)
    id: true # assign and log a unique request ID per request
```

See [HTTP Configuration](../http/configuration.md) for full details.

### `mqtt.logging`

MQTT logging configuration. Accepts standard logging options.

```yaml
mqtt:
  logging:
    level: warn
    path: ~/hdb/log/mqtt.log
    stdStreams: false
```

### `authentication.logging`

Authentication subsystem logging. Accepts standard logging options.

```yaml
authentication:
  logging:
    level: warn
    path: ~/hdb/log/auth.log
```

### `replication.logging`

Replication subsystem logging. Accepts standard logging options.

```yaml
replication:
  logging:
    level: warn
    path: ~/hdb/log/replication.log
```

### `tls.logging`

TLS subsystem logging. Accepts standard logging options.

```yaml
tls:
  logging:
    level: warn
    path: ~/hdb/log/tls.log
```

### `storage.logging`

Database storage subsystem logging. Accepts standard logging options.

```yaml
storage:
  logging:
    level: warn
    path: ~/hdb/log/storage.log
```

### `analytics.logging`

Analytics subsystem logging. Accepts standard logging options.

```yaml
analytics:
  logging:
    level: warn
    path: ~/hdb/log/analytics.log
```

## Clustering Log Level

Clustering has a separate log level due to its verbosity. Configure with `clustering.logLevel`.

Valid levels from least verbose: `error`, `warn`, `info`, `debug`, `trace`.

```yaml
clustering:
  logLevel: warn
```

## Complete Example

```yaml
logging:
  level: warn
  path: ~/hdb/log/hdb.log
  file: true
  stdStreams: false
  console: false
  auditLog: false
  auditRetention: 3d
  rotation:
    enabled: true
    compress: false
    interval: 1D
    maxSize: 100M
    path: ~/hdb/log
  auditAuthEvents:
    logFailed: false
    logSuccessful: false
  external:
    level: warn
    path: ~/hdb/log/apps.log

http:
  logging:
    level: warn
    path: ~/hdb/log/http.log
    timing: true
```

## Related

- [Logging Overview](./overview)
- [Logging API](./api)
- [Logging Operations](./operations)
- [Database / Transaction Logging](../database/transaction.md)
- [Configuration Overview](../configuration/overview.md)
