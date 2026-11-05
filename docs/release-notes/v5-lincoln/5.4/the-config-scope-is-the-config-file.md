---
section: 'Built-in Agent'
order: 30
---

### The `config` Scope Is the Config File

The built-in agent's read-only `config` filesystem scope used to be the directory holding `harper-config.yaml`. On a default install that is `rootPath`, so the agent could read `keys/`, `ssh/`, and the raw database files. It is now the config file alone. The new `agent.configScope` replaces it at startup with another file or directory, which keeps the config file readable only if it contains it. In every scope, the agent's filesystem tools now refuse to read Harper's key directories (`<rootPath>/keys` and `<rootPath>/ssh`), files named `*.pem`, `*.key`, or `.jwtPass`, and text holding a PEM private key, and they refuse to write into the key directories. `set_agent_config` now rejects `configScope` and `componentsScope` with a `400`, as it already did `httpFetch`. An agent that read other files through `config` needs `configScope` set to a directory that holds them. See [Filesystem scopes](/reference/v5/configuration/options#filesystem-scopes) ([harper#3041](https://github.com/HarperFast/harper/issues/3041)).
