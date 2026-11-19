---
section: 'Configuration'
order: 20
---

### Applying V8 Flags From the Configuration

The new `threads.v8Flags` setting takes a V8 flag, or a list of them, and applies them to the Harper process before its first worker thread starts, so every worker thread runs with them. It is for flags such as `--optimize-for-size`, which Node refuses in `NODE_OPTIONS` and which cannot be passed to a worker thread. It can also be set through `HARPER_SET_CONFIG` or `HARPER_CONFIG`. An entry must start with `--`; `set_configuration` refuses one that does not, and Harper stops at startup with an error naming the setting. Unlike the command line, this does not apply a flag's implied flags, so list them yourself (for example `--max-semi-space-size=1` alongside `--optimize-for-size`). A changed value takes effect when the process restarts (the `restart` operation, on each node); `restart_service` restarts only worker threads and does not apply it. Not applied under Bun. See [Applying V8 flags](/reference/v5/configuration/options#applying-v8-flags).
