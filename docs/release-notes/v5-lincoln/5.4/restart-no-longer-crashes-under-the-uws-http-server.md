---
section: 'Configuration'
---

### Restarting No Longer Crashes Under the uWS HTTP Server

With the uWS HTTP server, the `restart` operation and an immediate shutdown (a second signal, or `threads.shutdownTimeout: 0`) used to crash the process (`SIGABRT` or `SIGSEGV`) instead of exiting or relaunching it. Harper now lets each worker close its uWS sockets before stopping it, waiting up to 10 seconds for a busy one. See [shutdown](/reference/v5/configuration/options#threads) ([harper#4393](https://github.com/HarperFast/harper/pull/4393)).
