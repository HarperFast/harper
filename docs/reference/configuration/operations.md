---
title: Configuration Operations
---

<!-- Source: versioned_docs/version-4.7/developers/operations-api/configuration.md (primary) -->

# Configuration Operations

Operations API endpoints for reading and modifying Harper configuration.

_All operations in this section are restricted to `super_user` roles._

For the full list of configurable options, see [Configuration Options](./options.md).

---

## Set Configuration

Modifies one or more Harper configuration parameters. **Requires a [restart](../operations-api/operations.md#restart) or [restart_service](../operations-api/operations.md#restart_service) to take effect.**

`operation` _(required)_ — must be `set_configuration`

`replicated` _(optional)_ <VersionBadge version="v5.1.0" /> — set to `true` to apply the same configuration change to all cluster nodes in a single call. The origin node applies the change first; if its local write fails, nothing is sent to peers. Requires replication to be configured.

Additional properties correspond to configuration keys in underscore-separated format (e.g. `logging_level` for `logging.level`, `clustering_enabled` for `clustering.enabled`).

:::warning Replicate cluster-appropriate parameters only
A replicated call sends the exact same values to every node. Do not include node-local parameters — ports, `node.hostname`, `rootPath`, storage/log file paths, TLS certificate or key paths, or `replication.hostname`/`url`/`routes` — as they would overwrite each peer's local values.
:::

### Body

```json
{
	"operation": "set_configuration",
	"logging_level": "trace",
	"clustering_enabled": true
}
```

### Response: 200

```json
{
	"message": "Configuration successfully set. You must restart HarperDB for new config settings to take effect."
}
```

### Replicated body

```json
{
	"operation": "set_configuration",
	"http_corsAccessList": ["app.example.com"],
	"replicated": true
}
```

### Response: 200 (replicated)

The `replicated` array reports per-node outcomes. A failed peer appears as `{ "status": "failed", "reason": "...", "node": "..." }` while `message` still reports overall success — always check the array when replicating.

```json
{
	"message": "Configuration successfully set. You must restart Harper for new config settings to take effect.",
	"replicated": [
		{
			"message": "Configuration successfully set. You must restart Harper for new config settings to take effect.",
			"node": "node-2"
		}
	]
}
```

To restart the whole cluster afterward, follow with [restart_service](../operations-api/operations.md#restart_service) using `"replicated": true` — it restarts nodes one at a time, so the cluster stays available:

```json
{
	"operation": "restart_service",
	"service": "http",
	"replicated": true
}
```

---

## Get Configuration

Returns the current Harper configuration.

`operation` _(required)_ — must be `get_configuration`

### Body

```json
{
	"operation": "get_configuration"
}
```

### Response: 200

```json
{
	"http": {
		"compressionThreshold": 1200,
		"cors": false,
		"corsAccessList": [null],
		"keepAliveTimeout": 30000,
		"port": 9926,
		"securePort": null,
		"timeout": 120000
	},
	"threads": 11,
	"authentication": {
		"cacheTTL": 30000,
		"enableSessions": true,
		"operationTokenTimeout": "1d",
		"refreshTokenTimeout": "30d"
	},
	"analytics": {
		"aggregatePeriod": 60
	},
	"replication": {
		"hostname": "node1",
		"databases": "*",
		"routes": null,
		"url": "wss://127.0.0.1:9925"
	},
	"componentsRoot": "/Users/hdb/components",
	"localStudio": {
		"enabled": false
	},
	"logging": {
		"auditAuthEvents": {
			"logFailed": false,
			"logSuccessful": false
		},
		"auditLog": true,
		"auditRetention": "3d",
		"file": true,
		"level": "error",
		"root": "/Users/hdb/log",
		"rotation": {
			"enabled": false,
			"compress": false,
			"interval": null,
			"maxSize": null,
			"path": "/Users/hdb/log"
		},
		"stdStreams": false
	},
	"mqtt": {
		"network": {
			"port": 1883,
			"securePort": 8883
		},
		"webSocket": true,
		"requireAuthentication": true
	},
	"operationsApi": {
		"network": {
			"cors": true,
			"corsAccessList": ["*"],
			"domainSocket": "/Users/hdb/operations-server",
			"port": 9925,
			"securePort": null
		}
	},
	"rootPath": "/Users/hdb",
	"storage": {
		"writeAsync": false,
		"caching": true,
		"compression": false,
		"noReadAhead": true,
		"path": "/Users/hdb/database",
		"prefetchWrites": true
	},
	"tls": {
		"privateKey": "/Users/hdb/keys/privateKey.pem"
	}
}
```
