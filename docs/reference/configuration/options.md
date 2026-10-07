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
- `compressionThreshold` — Response size threshold (bytes) for Brotli compression; `0` disables compression; _Default_: `0`
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
- `maxHeapMemory` — Heap limit per thread (MB). When unset, each thread's limit is derived from available memory and the number of HTTP worker threads, including isolated applications' threads
- `maxIsolated` <VersionBadge version="v5.3.0" /> — How many [isolated applications](../components/applications.md#isolated-applications) may run, each in a dedicated worker thread; _Default_: `8`. An isolated application past this limit is not loaded anywhere, and a `deploy_component` that would exceed it is refused with a `409`. `0` admits none. Dedicated threads are added to `count`, not taken from it, so a node runs up to `count` + `maxIsolated` HTTP worker threads. When `maxHeapMemory` is unset, they all count when Harper divides available memory into each thread's default heap limit. Each one lowers that limit until it reaches its 512 MB floor, after which more threads add to the total heap the node may use
- `heapSnapshotNearLimit` — Write a `.heapsnapshot` file when a thread nears its heap limit (loadable in Chrome DevTools Memory tab); _Default_: `false`. See [Worker Thread Debugging](./debugging.md#heap-snapshots-near-the-limit)
- `debug` — Enable Node.js inspector; sub-options: `port`, `startingPort`, `host`, `waitForDebugger`. See [Worker Thread Debugging](./debugging.md)
- `preload` <VersionBadge version="v5.2.0" /> — Module, or list of modules, to load via Node's `--import` before any Harper or application module on each worker thread. Intended for instrumentation and APM agents. Worker threads only (not under Bun).
- `preloadRequire` <VersionBadge version="v5.2.0" /> — The same, but via Node's `--require` (CommonJS). Worker threads only (not under Bun).

### Preloading an instrumentation agent

An APM or instrumentation agent has to load before the code it instruments. These two keys put a module on each worker thread's startup, ahead of Harper's own modules and your application's.

The two keys differ in how the module is loaded, and that determines what it can do. `--import` evaluates the module as ESM, which is how an agent installs Node's module loader hooks so modules loaded later by `import` can be instrumented. `--require` runs the module's body, which is how an agent's initialization entry starts it.

Installing loader hooks and starting an agent are separate jobs, and which of an agent's entry points does which is specific to that agent. Some ship a single entry that does both; others split them across an `--import` entry and a `--require` entry. When they are split, set both keys.

Bare specifiers resolve against the `node_modules` of your installed [components](../components/overview.md), so an agent can ship as a dependency of a deployed component. Absolute paths also work.

Follow your agent's own documentation for worker-thread setup, and confirm the telemetry you expect actually reaches your collector.

#### Example: a split-entry agent

dd-trace is a split-entry agent, which makes it a useful illustration. On dd-trace 6.x, `dd-trace/register.js` installs the ESM loader hooks but never calls `init()`, so `preload` on its own leaves the tracer uninitialized — it still hands out spans with plausible trace ids, but they are no-ops and nothing is exported. `dd-trace/init` is the entry that calls `init()`. Setting both keys covers both jobs:

```yaml
threads:
  preloadRequire: dd-trace/init # the entry that calls init()
  preload: dd-trace/register.js # ESM loader hooks for automatic instrumentation
```

`dd-trace/initialize.mjs` looks like a single-entry shortcut around that pairing, but it is not one on a worker thread: it gates both its `init()` call and its loader-hook registration behind `isMainThread`, so under `--import` on a worker it starts nothing and registers nothing.

An agent that is one of several preloaded modules still needs its own pairing:

```yaml
threads:
  preloadRequire: dd-trace/init # the entry that calls init()
  preload:
    - dd-trace/register.js
    - /opt/instrumentation/agent.mjs
```

The dd-trace behavior described here was observed on 6.x. Check your agent's current documentation, and confirm your spans arrive at your collector.

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
- `refreshTokenTimeout` — Refresh token lifetime; _Default_: `30d`
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
- `unixDomainSockets` — `true` makes each HTTP worker thread also listen on a Unix domain socket under `<rootPath>/sockets` for each secure port, for a proxy on the same host to forward to. [Isolated applications](../components/applications.md#isolated-applications) are reachable only this way, so they require it; _Default_: `false`

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

## `node`

This node's identity within the cluster. See [Replication](../replication/overview.md).

```yaml
node:
  hostname: server-one
```

- `hostname` <VersionBadge type="changed" version="v5.3.0" /> — This node's identity: it becomes the node's TLS certificate common name and the host that replication advertises to peers and dials to reach this node. Must be a **bare hostname or IP literal** (e.g. `server-one`, `10.0.0.5`, or the unbracketed IPv6 form `::1`) — **not** a URL and **not** `host:port`. Harper **fails to start** if the value carries a scheme, port, path, credentials, query string, or fragment, is a bracketed IPv6 literal (`[::1]`), or is not a string; the startup error names the offending value and the reason. Earlier versions accepted such values and silently corrupted certificate matching and replication — a node configured as `http://host:9926` advertised and dialed a host literally named `http`. The same requirement applies to [`replication.hostname`](#replication). If unset, Harper uses the first valid bare host among `replication.hostname`, the host in `replication.url`, the TLS certificate common name, and the Operations API host, falling back to `127.0.0.1`.

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

- `hostname` <VersionBadge type="changed" version="v5.3.0" /> — This instance's hostname within the cluster. Subject to the same bare hostname or IP literal requirement as [`node.hostname`](#node) — a URL, `host:port`, or non-string value fails startup. When both are set, `node.hostname` wins.
- `url` — WebSocket URL peers use to connect to this instance
- `databases` — Databases to replicate; _Default_: `"*"` (all). Each entry supports `name` and `sharded`
- `routes` — Peer nodes; URL strings or `{hostname, port, startTime, revokedCertificates}` objects
- `port` — Replication port
- `securePort` — Secure replication port; _Default_: `9933` (changed from `9925` in v4.5.0)
- `enableRootCAs` — Verify against Node.js Mozilla CA store; _Default_: `true`
- `blobTimeout` — Blob transfer timeout (ms); _Default_: `120000`
- `blobGapReconnectMs` — Interval (ms) for the blob-gap watchdog: when a transient blob save failure pins a replication resume cursor, the connection is forced to reconnect on this cadence so the gapped blob is re-streamed and, during a bulk copy, the copy resumes from the last banked cursor. Lower values heal gaps faster at the cost of more reconnects on a link whose faults never heal; _Default_: the `blobTimeout` value
- `copyCursorFlushBytes` — Bytes of applied bulk-copy data between durable flushes of the copy resume cursor (RocksDB); _Default_: `67108864`
- `copyCursorFlushIntervalMs` — Maximum time (ms) between durable flushes of the bulk-copy resume cursor (RocksDB); _Default_: `5000`
- `blobSendDrainTimeout` — Maximum time (ms) a worker waits for in-flight replication blob **sends** to finish before shutting down during a restart, so a rolling restart (e.g., a component deploy reload) doesn't interrupt a transfer in progress. Only sends that are still making progress are waited on; `0` disables draining; _Default_: `600000`
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
- `maxTransactionQueueTime` — Per-thread write-commit duration threshold for HTTP 503 backpressure; see [Storage Tuning](../database/storage-tuning.md#storagemaxtransactionqueuetime); _Default_: `45s`
- `noReadAhead` — Advise OS against read-ahead; _Default_: `false`
- `prefetchWrites` — Prefetch before write transactions; _Default_: `true`
- `randomAccessFields` <VersionBadge version="v5.1.0" /> — Encode records as typed random-access structures, so a single field can be read without decoding the whole record. Best for tables whose records have a stable set of fields with stable types; leave off for wide, sparse, or variably typed schemas. Read by each table when its store opens, so a change applies to existing tables on restart, and ignored entirely by tables declaring the [`@table(randomAccessFields:)`](../database/schema.md#randomaccessfields) directive; _Default_: `false`. See [Storage Tuning — Record Encoding](../database/storage-tuning.md#storagerandomaccessfields)
- `path` — Database files directory; _Default_: `<rootPath>/database`
- `backupPath` — Directory for managed database backups (created by [`create_backup`](../backups/operations.md#create_backup)), one subdirectory per database; _Default_: `<rootPath>/backup` (Added in: v5.2.0)
- `blobPaths` — Blob storage directory or directories; _Default_: `<rootPath>/blobs` (Added in: v4.5.0)
- `pageSize` — Database page size (bytes); _Default_: OS default
- `reclamation.threshold` — Free-space ratio below which reclamation begins evicting from caching tables; _Default_: `0.4` (Added in: v4.5.0)
- `reclamation.interval` — Free-space check interval; _Default_: `1h`
- `reclamation.evictionFactor` — Heuristic factor for early eviction under disk pressure; _Default_: `100000`. See [Storage Tuning — Reclamation](../database/storage-tuning.md#storage-reclamation)
- `rocks.blockCacheSize` — RocksDB shared block cache size in bytes; _Default_: 25% of constrained memory. See [Storage Tuning — RocksDB Memory](../database/storage-tuning.md#rocksdb-memory) (Added in: v5.1.0)
- `rocks.writeBufferManagerSize` — Process-wide cap (bytes) on RocksDB memtable memory across all databases. `0` disables; _Default_: one third of `blockCacheSize` (enabled). See [Storage Tuning — RocksDB Memory](../database/storage-tuning.md#rocksdb-memory) (Added in: v5.1.0)
- `rocks.writeBufferManagerCostToCache` — When enabled, memtable memory and the block cache share a single, unified memory pool. During heavy write bursts, the block cache dynamically shrinks to give memtables more room. Once those memtables flush to disk, the block cache automatically reclaims that memory space. _Default_: `true`. Has no effect when `writeBufferManagerSize` is `0`. (Added in: v5.1.0)
- `rocks.writeBufferManagerAllowStall` — Stall writes when memtable memory exceeds `writeBufferManagerSize` (hard cap) instead of allowing brief overshoot with more aggressive flushing (soft cap); _Default_: `true`. (Added in: v5.1.0)

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

## `agent`

Added in: v5.2.0

Built-in Harper agent — an LLM loop that operates this instance through Harper's own operations, scoped filesystem access, followup scheduling, the V8 inspector, and outbound HTTP. Disabled by default, so it never incurs LLM cost unless you turn it on. Driven through the [Agent operations](../operations-api/operations.md#agent), which also describe the privilege boundary before you enable it.

```yaml
agent:
  enabled: true
  model: default
  maxTurns: 50
  autoApprove: false
  allowDestructive: false
  user: hdb_agent
```

- `enabled` — Enable the agent component; _Default_: `false`
- `provider` — Recorded on the session but **not yet used to route the model call** — only `model` reaches the provider. Set the provider through the [`models`](../models/overview.md#configuration) configuration instead
- `model` — Model id override, passed through to the model call; _Default_: the [`models`](../models/overview.md#configuration) generative default
- `maxTurns` — Maximum tool-call iterations in a single run; _Default_: `50`
- `maxCostUsd` — Intended per-run cost ceiling. **Not enforced** — it is a stored setting only, and nothing checks spend against it; _Default_: `5.00`
- `autoApprove` — Run without per-action approval gates; _Default_: `false`
- `allowDestructive` — Include the tools marked destructive in the agent's toolset: `write_file`, the inspector's code-evaluation tools, and any operations tool carrying MCP's [`destructiveHint`](../mcp/tool-metadata.md) (`drop_table`, `delete`, `restart`, `set_configuration`, ...). When `false` they are removed entirely rather than gated. That hint comes from a curated set in core which does not cover every damaging operation, so this is not a complete safety boundary on its own — see [Agent operations](../operations-api/operations.md#agent); _Default_: `false`
- `user` — Harper user the agent's **operations** tools run as; the filesystem, HTTP, schedule, and inspector tools always run at process privilege regardless. If it cannot be resolved and it is not the default, the agent fails closed and runs with no operations tools; _Default_: `hdb_agent`, which falls back to a `super_user` bootstrap identity
- `componentsScope` — Filesystem write scope for component edits, relative to `rootPath`; _Default_: the full `componentsRoot`
- `httpFetch` <VersionBadge version="v5.3.2" /> — Whether the agent has its `http_fetch` tool, and which hosts it may reach: `true`, `false`, or `{ allow: [...] }`. Read at startup only. See [Restricting `http_fetch`](#restricting-http_fetch); _Default_: `true`
- `systemPromptAppend` — Operator text appended to the agent's system prompt

`enabled`, `provider`, `model`, `maxTurns`, `maxCostUsd`, `autoApprove`, `allowDestructive`, and `systemPromptAppend` can also be changed at runtime with [`set_agent_config`](../operations-api/operations.md#set_agent_config), which applies in memory only. `enabled` is the exception worth knowing: it cannot switch the agent on, because with the agent disabled at startup no agent operation is registered at all.

### Restricting `http_fetch`

<VersionBadge version="v5.3.2" />

`http_fetch` lets the agent send HTTP requests from the Harper process: to its own REST endpoints while it builds an app, or to pull a reference page. The same agent reads table rows, logs, and component source, and text in any of them can steer it, so an enabled agent has a read path and an egress path in one toolset. `agent.httpFetch` bounds that tool. It is not a bound on every way the agent can reach the network: with `allowDestructive` on, for example, the agent can write component code, and the Harper process runs that code.

Remove the tool when the agent has no reason to reach the network, for example an investigation or operations-assistant role:

```yaml
agent:
  enabled: true
  httpFetch: false
```

Or keep it and allow only named hosts:

```yaml
agent:
  enabled: true
  httpFetch:
    allow:
      - localhost:9926
      - '*.example.com'
```

| Value              | Effect                                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `true` (default)   | The tool is available. Cloud-metadata hosts and the IPv4 link-local range are refused.                                                                   |
| `false`            | The tool is removed from the agent's toolset. The model never sees it, and the system prompt stops suggesting HTTP checks.                               |
| `{ allow: [...] }` | The tool is available, and a request is refused unless its host matches an entry. Its description lists the entries, so the model knows where it can go. |

Allow-list entries take these forms:

- `api.example.com` — that host, on any port
- `localhost:9926` — that host on that port only. A URL without a port uses 80 for `http` and 443 for `https`.
- `*.example.com` — any subdomain, at any depth. It does not match `example.com` itself; list that separately.
- `[::1]` or `[::1]:9926` — an IPv6 address, in brackets

Entries and request URLs are compared in canonical form, so letter case, internationalized names, and shorthand spellings of an IPv4 address all match the same entry. An IPv4 entry does not admit the IPv4-mapped IPv6 form of its address (`[::ffff:...]`); list that separately if you need it.

Some behavior worth knowing:

- **Every redirect hop is checked.** A redirect to a host the policy refuses fails the request before that host is contacted. This applies in every mode, so with the default `true`, a redirect into the cloud-metadata range fails too.
- **The metadata block comes first.** Listing a cloud-metadata or link-local address does not make it reachable.
- **Matching is by host name, not address.** An allowed name whose DNS resolves to an internal address is still reached. List names whose DNS you control.
- **An empty list removes the tool**, the same as `false`. A value Harper cannot read also removes the tool, and logs an error naming it, while the rest of the agent stays available.
- **It is read at startup only.** Set it in `harper-config.yaml`, with `set_configuration`, through `HARPER_CONFIG`, or as an [environment variable](./overview.md#2-environment-variables) or [CLI argument](./overview.md#3-cli-arguments) (`AGENT_HTTPFETCH=false`, or `AGENT_HTTPFETCH_ALLOW='["localhost:9926"]'` as a JSON array), then restart. A comma-separated string is not a list: it is rejected, and the tool is removed. [`set_agent_config`](../operations-api/operations.md#set_agent_config) rejects it at runtime. Because `set_configuration` can write it and `restart` applies it, the policy only holds against the agent itself while those two operations stay out of its toolset (they are not in the default operations allow list) or behind [approval](../operations-api/operations.md#approve_agent_action).

---

## `deployment`

Retention for what `deploy_component` leaves behind. See [`deploy_component`](../operations-api/operations.md#deploy_component).

```yaml
deployment:
  payloadRetention:
    maxSize: 10485760
  stagingRetention:
    maxCount: 5
```

- `payloadRetention.maxSize` <VersionBadge version="v5.1.15" /> — Bytes. After a successful deploy, a payload larger than this has its stored tarball (`payload_blob`) dropped from the `hdb_deployment` row; the row and its metadata stay. Set it very high to retain every payload; _Default_: `10485760` (10 MiB)
- `stagingRetention.maxCount` <VersionBadge version="v5.3.0" /> — How many complete builds that are not live may remain per component under `<componentsRoot>/.deploy-staging`: builds staged with `activate: false`, and [releases replaced by a later deploy](../operations-api/operations.md#going-back-to-a-previous-release), which `deployment_id` can make live again. The newest survive; older ones are removed when that component next deploys and at startup. `drop_component` removes all of them. Each is a full installed copy of the component, `node_modules` included. `0` keeps none, and no replaced release is kept. This bounds dormant builds only, not a disk quota: staging directories that belong to an in-flight or unsettled deploy are never touched; _Default_: `5`

---

## `applications`

Added in: v5.0.0

Controls how application modules are loaded and isolated. See [Module Loading](../components/module-loading.md) for the full reference.

```yaml
applications:
  lockdown: freeze-after-load
  moduleLoader: vm-current-context
  dependencyLoader: auto
  allowedDirectory: app
  allowedSpawnCommands:
    - npm
    - node
  # allowedBuiltInModules: [] # if omitted, all Node.js built-ins are allowed
```

- `lockdown` — Indicates if intrinsic/built-in objects should be locked down/frozen. This provides additional security and protection against prototype pollution attacks. The default is `freeze-after-load` (since v5.0.2; v5.0.0 and v5.0.1 defaulted to `freeze`), which freezes the important built-in objects once all components have loaded, so component initialization can still modify them. This can also be set to `freeze` (freeze before any application code loads), `none`, or `ses` (lockdown provided by the `ses` package, which is more strict). See [Intrinsic Lockdown](../components/module-loading.md#intrinsic-lockdown).
- `moduleLoader` — The method used to load modules (and isolate the application). The default is `vm-current-context` (since v5.1.0; v5.0.x defaulted to `vm`), which uses Node's VM module loader in Harper's own context so applications share JavaScript intrinsics. This can also be set to `vm` (VM loader with a separate context and its own intrinsics per application), `native` (standard Node module loader), or `compartment`, which uses the `ses` implementation of the proposed `Compartment` functionality. See [Module Loader Modes](../components/module-loading.md#module-loader-modes).
- `dependencyLoader` — The application module loader can be used to load packages/dependencies (installed as `dependencies` from the package.json). The default is 'auto', which only use the VM module loader if the package specifies `harper` as a dependency. This can also be set to `app` to always use the application module loader or `native` to always native module loader for packages. See [Dependency Loading](../components/module-loading.md#dependency-loading).
- `allowedDirectory` — Added in v5.0.4. Restricts where an application may load modules from. The default is `app`, which permits only modules within the application's own directory tree; loading from outside it throws. Set to `any` to remove the restriction. Dev-mode installs default to `any`. Applies to imports the application module loader handles, so treat it as a configuration guardrail rather than a security boundary. See [Allowed Directory](../components/module-loading.md#allowed-directory).
- `allowedBuiltInModules` — An allowlist of the Node.js built-in modules applications may import. If omitted, all built-ins are allowed. Matching strips a `node:` prefix and compares the first path segment, so `fs` also permits `node:fs/promises`. Like `allowedDirectory`, it applies to imports the application module loader handles. See [Allowed Built-in Modules](../components/module-loading.md#allowed-built-in-modules).
- `allowedSpawnCommands` - This lists the specific commands that can be spawned by the application (using `child_process`'s `spawn()` and `execFile()` functions). You can add commands that your application will need to launch (this is to protect against malicious code spawning processes). Only the first token of the command is matched, spawning also requires a mandatory `name` option, and the call is subject to a node-wide single-process lock — see [Child Processes](../components/javascript-environment.md#child-processes) for the full contract.

## Component Configuration

Installed components are configured directly at the root of `harper-config.yaml` using the component name as the key — not nested under a `components:` section. See [Components](../components/overview.md).

```yaml
my-component:
  package: 'HarperDB-Add-Ons/my-component'
  port: 4321
```

- `<component-name>.package` — NPM package name, GitHub repo (`user/repo`), or local path
- `<component-name>.port` — Port for the component; _Default_: value of `http.port`
