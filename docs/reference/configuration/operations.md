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

Additional properties correspond to configuration keys in underscore-separated format (e.g. `logging_level` for `logging.level`, `clustering_enabled` for `clustering.enabled`).

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
