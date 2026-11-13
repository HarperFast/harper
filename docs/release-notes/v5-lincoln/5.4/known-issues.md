---
section: 'Known Issues'
---

- **Bun:** while a WebSocket listener is on (REST subscriptions or MQTT over WebSocket, both on by default), the application port runs on Bun's `node:http` emulation, and legacy Fastify routes on it answer `404`. Turning both WebSocket listeners off serves the port through `Bun.serve` ([harper#2355](https://github.com/HarperFast/harper/issues/2355)).
- **uWS HTTP (opt-in):** a legacy Fastify route authenticates the request again against `hdb_user` instead of using the principal Harper resolved. A component `server.getUser` principal with no `hdb_user` record gets `401`, and a credential `hdb_user` accepts is authorized as that user even when the component's `getUser` would refuse or narrow it ([harper#4326](https://github.com/HarperFast/harper/issues/4326)).
- A request still running when listeners close on shutdown is force-closed after a fixed 2.5 seconds on Node or 5 seconds on Bun, whatever `threads.shutdownTimeout` is ([harper#3939](https://github.com/HarperFast/harper/issues/3939)).
