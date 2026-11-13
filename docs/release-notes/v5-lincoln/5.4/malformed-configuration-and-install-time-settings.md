---
section: 'Configuration'
---

### Malformed Configuration and Install-Time Settings

Harper now refuses a `harper-config.yaml` with YAML parse errors, including duplicate keys, before it is used. Before, a complete file with parse errors could be adopted without a warning ([harper#2986](https://github.com/HarperFast/harper/pull/2986)).

A first-time install now composes the whole configuration (defaults, an `HDB_CONFIG` template, CLI arguments and environment variables) before it creates the `system` database. A storage engine or RocksDB compression set through `HARPER_DEFAULT_CONFIG`, `HARPER_SET_CONFIG`, `STORAGE_*` or an `HDB_CONFIG` template therefore applies to `system` too; before, `system` could be created on one engine while workers opened the other. An install from a root-named `HDB_CONFIG` template refuses a destination that already holds a database. On every start, `HARPER_CONFIG` and `HARPER_SET_CONFIG` take precedence over overlapping individual variables: `HARPER_CONFIG` defining `http.port` wins over `HTTP_PORT`, on the main thread and on workers. See [Configuration Precedence](/reference/v5/configuration/overview#configuration-precedence) ([harper#3233](https://github.com/HarperFast/harper/pull/3233)).
