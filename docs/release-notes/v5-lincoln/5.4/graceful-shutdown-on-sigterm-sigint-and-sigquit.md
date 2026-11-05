---
section: 'Configuration'
order: 10
---

### Graceful Shutdown on SIGTERM, SIGINT and SIGQUIT

On SIGTERM, SIGINT or SIGQUIT, Harper no longer exits at once. It stops accepting connections, gives requests in flight a few seconds to finish, closes component scopes (their `'close'` listeners run once requests in flight have had a few seconds to finish), and exits with code `0`. The new `threads.shutdownTimeout` (default `8000` ms, `30000` under `harper dev`) bounds that shutdown; `0` restores the immediate exit, and a second signal exits at once. Set it a few seconds below your orchestrator's stop grace period (Docker and Compose default to 10 seconds, Kubernetes to 30, minus any `preStop` hook time), leaving time for the database close at exit, which the setting does not bound. `harper stop` now waits for Harper to exit, and exits `1` if it is still running `threads.shutdownTimeout` + 60 seconds after the signal. See [Shutting down on a termination signal](/reference/v5/configuration/options#shutting-down-on-a-termination-signal) and [`harper stop`](/reference/v5/cli/commands#harper-stop) ([harper#3943](https://github.com/HarperFast/harper/pull/3943)).
