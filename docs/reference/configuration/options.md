---
title: Configuration Options
---

<!-- Source: versioned_docs/version-4.7/deployments/configuration.md (primary — comprehensive options reference) -->
<!-- Source: release_notes/4.2.0.md (major config restructuring: http section, componentRoot) -->
<!-- Source: release_notes/4.3.0.md (configuration improvements) -->
<!-- Source: release_notes/4.4.0.md (developer/production mode) -->
<!-- Source: release_notes/4.5.0.md (HTTP/2 support) -->
<!-- Source: release_notes/4.7.2.md (HARPER_DEFAULT_CONFIG and HARPER_SET_CONFIG) -->

# Configuration Options

Quick reference for all `harper-config.yaml` top-level sections.

For how to apply configuration (YAML file, environment variables, CLI, Operations API), see [Configuration Overview](./overview.md).

---

## `http`

Configures the Harper component server (HTTP, REST API, WebSocket). See [HTTP Configuration](../http/configuration.md) for full details.

```yaml
http:
  port: 9926
  securePort: 4443
  cors: true
  timeout: 120000
  mtls: false
  logging:
    level: info
    path: ~/hdb/log/http.log
```

- `sessionAffinity` — Route requests from same client to same worker thread (`ip` or header name)
- `compressionThreshold` — Response size threshold for Brotli compression; _Default_: `1200` (bytes)
- `cors` — Enable CORS; _Default_: `true`
- `corsAccessList` — Allowed domains for CORS requests
- `corsAccessControlAllowHeaders` — `Access-Control-Allow-Headers` value for OPTIONS preflight
- `headersTimeout` — Max wait for complete HTTP headers (ms); _Default_: `60000`
- `maxHeaderSize` — Max HTTP header size (bytes); _Default_: `16394`
- `requestQueueLimit` — Max estimated request queue time (ms) before 503; _Default_: `20000`
- `keepAliveTimeout` — Inactivity before closing keep-alive connection (ms); _Default_: `30000`
- `port` — HTTP port; _Default_: `9926`
- `securePort` — HTTPS port; requires [TLS configuration](../http/tls.md); _Default_: `null`
- `http2` — Enable HTTP/2; _Default_: `false` (Added in: v4.5.0)
- `timeout` — Request timeout (ms); _Default_: `120000`
- `mtls` — Enable [mTLS authentication](../security/mtls-authentication.md) for incoming connections; sub-options: `user`, `required`, `certificateVerification` (see [Certificate Verification](../security/certificate-verification.md))
- `logging` — HTTP request logging (disabled by default, Added in: v4.6.0); sub-options: `level`, `path`, `timing`, `headers`, `id`. See [Logging Configuration](../logging/configuration.md)

---

## `threads`

Worker thread pool configuration.

```yaml
threads:
  count: 11
  maxHeapMemory: 300
```

- `count` — Number of worker threads; _Default_: CPU count minus one
- `maxHeapMemory` — Heap limit per thread (MB)
- `heapSnapshotNearLimit` — Write a `.heapsnapshot` file when a thread nears its heap limit (loadable in Chrome DevTools Memory tab); _Default_: `false`. See [Worker Thread Debugging](./debugging.md#heap-snapshots-near-the-limit)
- `debug` — Enable Node.js inspector; sub-options: `port`, `startingPort`, `host`, `waitForDebugger`. See [Worker Thread Debugging](./debugging.md)

---

## `authentication`

Authentication and session configuration. Added in: v4.1.0; `enableSessions` added in v4.2.0. See [Authentication Configuration](../security/configuration.md).

```yaml
authentication:
  authorizeLocal: true
  cacheTTL: 30000
  enableSessions: true
  operationTokenTimeout: 1d
  refreshTokenTimeout: 30d
```

- `authorizeLocal` — Auto-authorize loopback requests as superuser; _Default_: `true`
- `cacheTTL` — Session cache duration (ms); _Default_: `30000`
- `enableSessions` — Cookie-based sessions; _Default_: `true`
- `operationTokenTimeout` — Access token lifetime; _Default_: `1d`
- `refreshTokenTimeout` — Refresh token lifetime; _Default_: `1d`
- `logging` — Authentication event logging (Added in: v4.6.0); sub-options: `path`, `level`, `tag`, `stdStreams`. See [Logging Configuration](../logging/configuration.md)

---

## `operationsApi`

Harper Operations API endpoint configuration. See [Operations API Overview](../operations-api/overview.md).

```yaml
operationsApi:
  network:
    port: 9925
    cors: true
  tls:
    certificate: ~/hdb/keys/certificate.pem
    privateKey: ~/hdb/keys/privateKey.pem
```

- `componentFile.maxSize` — Maximum file size in bytes returned by `get_component_file`. Requests for files larger than this limit are rejected with HTTP 413. _Default_: `5242880` (5 MB)
- `network.cors` / `network.corsAccessList` — CORS settings
- `network.domainSocket` — Unix socket path for CLI communication; _Default_: `<rootPath>/hdb/operations-server`
- `network.headersTimeout` / `network.keepAliveTimeout` / `network.timeout` — Timeout settings (ms)
- `network.port` — Operations API port; _Default_: `9925`
- `network.securePort` — HTTPS port; _Default_: `null`
- `tls` — TLS override for the Operations API; sub-options: `certificate`, `certificateAuthority`, `privateKey`. See [`tls`](#tls)

---

## `tls`

Global TLS configuration for HTTPS and TLS sockets (used by HTTP and MQTT). Can be a single object or an array for SNI. See [TLS](../http/tls.md) and [Certificate Management](../security/certificate-management.md).

```yaml
tls:
  certificate: ~/hdb/keys/certificate.pem
  certificateAuthority: ~/hdb/keys/ca.pem
  privateKey: ~/hdb/keys/privateKey.pem
```

- `certificate` — Path to TLS certificate; _Default_: `<rootPath>/keys/certificate.pem`
- `certificateAuthority` — Path to CA file; _Default_: `<rootPath>/keys/ca.pem`
- `privateKey` — Path to private key; _Default_: `<rootPath>/keys/privateKey.pem`
- `ciphers` — Allowed TLS cipher suites

---

## `mqtt`

MQTT protocol configuration. Added in: v4.2.0. See [MQTT Configuration](../mqtt/configuration.md).

```yaml
mqtt:
  network:
    port: 1883
    securePort: 8883
  webSocket: true
  requireAuthentication: true
```

- `network.port` — Insecure MQTT port; _Default_: `1883`
- `network.securePort` — Secure MQTT port; _Default_: `8883`
- `network.mtls` — Enable [mTLS](../security/mtls-authentication.md) for MQTT connections; sub-options: `user`, `required`, `certificateAuthority`, `certificateVerification`
- `webSocket` — Enable MQTT over WebSocket on HTTP port; _Default_: `true`
- `requireAuthentication` — Require credentials or mTLS; _Default_: `true`
- `logging` — MQTT event logging (Added in: v4.6.0); sub-options: `path`, `level`, `tag`, `stdStreams`. See [Logging Configuration](../logging/configuration.md)

---

## `logging`

Application logging. Added in: v4.1.0; per-component logging added in v4.6.0. See [Logging Configuration](../logging/configuration.md).

```yaml
logging:
  level: warn
  root: ~/hdb/log
  stdStreams: false
  auditLog: false
  rotation:
    interval: 1D
    maxSize: 100M
```

- `level` — Log verbosity (`trace` → `debug` → `info` → `warn` → `error` → `fatal` → `notify`); _Default_: `warn`
- `file` — Write to file; _Default_: `true`
- `root` — Log directory; _Default_: `<rootPath>/log`
- `path` — Explicit log file path (overrides `root`)
- `stdStreams` — Write to stdout/stderr; _Default_: `false`
- `console` — Include `console.*` output; _Default_: `true`
- `auditLog` — Enable table transaction audit logging; _Default_: `false`
- `auditRetention` — Audit log retention duration; _Default_: `3d`
- `external` — Logging for components using the logger API; sub-options: `level`, `path`
- `rotation.enabled` / `rotation.compress` / `rotation.interval` / `rotation.maxSize` / `rotation.path` — Log file rotation (activates when `interval` or `maxSize` is set)
- `auditAuthEvents.logFailed` / `auditAuthEvents.logSuccessful` — Log failed/successful authentication events; _Default_: `false`

---

## `replication`

Native WebSocket-based replication (Plexus). Added in: v4.4.0. See [Replication](../replication/overview.md) and [Clustering](../replication/clustering.md).

```yaml
replication:
  hostname: server-one
  url: wss://server-one:9933
  databases: '*'
  routes:
    - wss://server-two:9933
```

- `hostname` — This instance's hostname within the cluster
- `url` — WebSocket URL peers use to connect to this instance
- `databases` — Databases to replicate; _Default_: `"*"` (all). Each entry supports `name` and `sharded`
- `routes` — Peer nodes; URL strings or `{hostname, port, startTime, revokedCertificates}` objects
- `port` — Replication port
- `securePort` — Secure replication port; _Default_: `9933` (changed from `9925` in v4.5.0)
- `enableRootCAs` — Verify against Node.js Mozilla CA store; _Default_: `true`
- `blobTimeout` — Blob transfer timeout (ms); _Default_: `120000`
- `failOver` — Failover to alternate node if peer unreachable; _Default_: `true`
- `shard` — Shard ID for traffic routing; see [Sharding](../replication/sharding.md)
- `mtls.certificateVerification` — Certificate revocation checking (CRL/OCSP) for replication connections; see [Certificate Verification](../security/certificate-verification.md)
- `logging` — Replication event logging; sub-options: `path`, `level`, `tag`, `stdStreams`. See [Logging Configuration](../logging/configuration.md)

---

## `storage`

Database storage configuration. See [Storage Tuning](../database/storage-tuning.md) for guidance on tuning these options for production workloads, [Database Overview](../database/overview.md) for general database concepts, and [Compaction](../database/compaction.md) for reclaiming space inside existing files.

```yaml
storage:
  path: ~/hdb/database
  caching: true
  compression: true
  compactOnStart: false
  engine: rocksdb
```

- `engine` — The database storage engine to use for new databases. Currently supported engines are `rocksdb` and `lmdb`. The default is `rocksdb`. Existing databases will use the engine that was used when they were created.
- `writeAsync` — Disable disk sync for higher throughput (**disables durability guarantees**); _Default_: `false`
- `caching` — In-memory record caching; _Default_: `true`
- `compression` — LZ4 record compression; _Default_: `true` (enabled by default since v4.3.0). Sub-options: `dictionary`, `threshold`
- `compactOnStart` — Compact all non-system databases on startup; _Default_: `false` (Added in: v4.3.0)
- `compactOnStartKeepBackup` — Retain compaction backups; _Default_: `false`
- `maxTransactionQueueTime` — Max write queue time before 503; _Default_: `45s`
- `noReadAhead` — Advise OS against read-ahead; _Default_: `false`
- `prefetchWrites` — Prefetch before write transactions; _Default_: `true`
- `path` — Database files directory; _Default_: `<rootPath>/database`
- `blobPaths` — Blob storage directory or directories; _Default_: `<rootPath>/blobs` (Added in: v4.5.0)
- `pageSize` — Database page size (bytes); _Default_: OS default
- `reclamation.threshold` — Free-space ratio below which reclamation begins evicting from caching tables; _Default_: `0.4` (Added in: v4.5.0)
- `reclamation.interval` — Free-space check interval; _Default_: `1h`
- `reclamation.evictionFactor` — Heuristic factor for early eviction under disk pressure; _Default_: `100000`. See [Storage Tuning — Reclamation](../database/storage-tuning.md#storage-reclamation)
- `rocks.blockCacheSize` — RocksDB shared block cache size in bytes; _Default_: 25% of constrained memory. See [Storage Tuning — RocksDB Memory](../database/storage-tuning.md#rocksdb-memory) (Added in: v5.1.0)
- `rocks.writeBufferManagerSize` — Process-wide cap (bytes) on RocksDB memtable memory across all databases. `0` disables; _Default_: `0`. See [Storage Tuning — RocksDB Memory](../database/storage-tuning.md#rocksdb-memory) (Added in: v5.1.0)
- `rocks.writeBufferManagerCostToCache` — Charge memtable memory against the block cache so both share a single accounting pool; _Default_: `false`. Has no effect when `writeBufferManagerSize` is `0`. (Added in: v5.1.0)
- `rocks.writeBufferManagerAllowStall` — Stall writes when memtable memory exceeds `writeBufferManagerSize` (hard cap) instead of allowing brief overshoot with more aggressive flushing (soft cap); _Default_: `false`. (Added in: v5.1.0)

---

## `databases`

Per-database and per-table file path overrides. Must be set before the database/table is created. See [Database Overview](../database/overview.md).

```yaml
databases:
  myDatabase:
    path: /data/myDatabase
    auditPath: /data/myDatabase-audit
    tables:
      myTable:
        path: /data/myTable
```

- `<dbName>.path` — Database files directory
- `<dbName>.auditPath` — Audit log directory for this database
- `<dbName>.tables.<tableName>.path` — Table files directory

---

## `analytics`

Analytics aggregation configuration. See [Analytics Overview](../analytics/overview.md).

```yaml
analytics:
  aggregatePeriod: 60
  replicate: false
```

- `aggregatePeriod` — Aggregation interval (seconds); _Default_: `60` (Added in: v4.5.0)
- `storageInterval` — Aggregation cycles between storage-volume measurements (`0` disables); _Default_: `10`
- `replicate` — Replicate analytics data across cluster; _Default_: `false`
- `logging` — Per-subsystem logger override for analytics writes. See [Logging Configuration](../logging/configuration.md#analyticslogging)

---

## `localStudio`

Local Harper Studio GUI. See [Studio](../studio/overview.md).

```yaml
localStudio:
  enabled: true
```

- `enabled` — Enable local Studio at `http://localhost:<port>`; _Default_: `false`

---

## `componentsRoot`

Path to local component files. Added in: v4.2.0 (previously `customFunctionsRoot`). See [Components](../components/overview.md).

```yaml
componentsRoot: ~/hdb/components
```

---

## `rootPath`

Root directory for all Harper persistent data, config, logs, and components.

```yaml
rootPath: /var/lib/harper
```

---

## `applications`

Added in: v5.0.0

```yaml
applications:
  lockdown: freeze
  moduleLoader: vm
  dependencyLoader: auto
  allowedSpawnCommands:
    - npm
    - node
```

- `lockdown` — Indicates if intrinsic/built-in objects should be locked down/frozen. This provides additional security and protection against prototype pollution attacks. The options can be `freeze` (default, which freezes the important built-in objects, without interfering with most packages), 'none', or 'ses' (lockdown provided by `ses` package, which is more strict).
- `moduleLoader` — The method used to load modules (and isolate the application). The default is `vm`, which uses Node's VM to load modules. This can also be set to `native` (use standard Node module loader), or `compartment`, which uses the `ses` implementation of the proposed `Compartment` functionality.
- `dependencyLoader` — The application module loader can be used to load packages/dependencies (installed as `dependencies` from the package.json). The default is 'auto', which only use the VM module loader if the package specifies `harper` as a dependency. This can also be set to `app` to always use the application module loader or `native` to always native module loader for packages.
- `allowedSpawnCommands` - This lists the specific commands that can be spawned by the application (using `child_process`'s `spawn()`, `exec()`, and `execFile()` functions). You can add commands that you are application will need to launch (this is to protect against malicious code spawning processes).

## Component Configuration

Installed components are configured directly at the root of `harper-config.yaml` using the component name as the key — not nested under a `components:` section. See [Components](../components/overview.md).

```yaml
my-component:
  package: 'HarperDB-Add-Ons/my-component'
  port: 4321
```

- `<component-name>.package` — NPM package name, GitHub repo (`user/repo`), or local path
- `<component-name>.port` — Port for the component; _Default_: value of `http.port`
