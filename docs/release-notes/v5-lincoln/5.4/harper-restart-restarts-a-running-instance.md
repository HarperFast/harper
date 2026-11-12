---
section: 'CLI'
---

### `harper restart` Restarts a Running Instance

`harper restart` now asks a running Harper to restart, over its local domain socket, in the same way as the [`restart`](/reference/v5/operations-api/operations#restart) operation. Before, it started a second process, which exited `4` with `Harper is already running` after printing that a restart was under way, and the running instance never restarted. When the instance cannot be reached or refuses the restart, the command now returns `1` without claiming a restart. With no Harper running, it still starts one.

Without `target=`, `harper restart` always acts on the local instance, never on `HARPER_CLI_TARGET` or a target saved by `harper login`. `harper restart target=<url>` now restarts that remote instance; before, it ignored `target`. `harper restart replicated=true` now returns `1`, since the `restart` operation restarts one instance; to restart every node in a cluster one at a time, use `harper restart_service service=http_workers replicated=true`. See [`harper restart`](/reference/v5/cli/commands#harper-restart) ([harper#4299](https://github.com/HarperFast/harper/issues/4299)).
