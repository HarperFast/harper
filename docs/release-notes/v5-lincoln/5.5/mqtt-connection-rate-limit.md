---
section: 'MQTT'
---

### Per-Address Connection Rate Limit

The new `mqtt.network.connectionRateLimit` limits how fast one source address can open MQTT connections on the TCP and TLS ports. A connection over the limit is reset as soon as it is accepted, before the TLS handshake and before any MQTT packet is read, so a flood of connections that would all be refused at authentication no longer costs a handshake, a `CONNECT` parse and a log line each. The limit is off by default; set `perSecond` (and optionally `burst`) to turn it on. It applies per worker thread and does not cover MQTT over WebSockets. See [`connectionRateLimit`](/reference/v5/mqtt/configuration#mqttnetworkconnectionratelimit) ([harper#345](https://github.com/HarperFast/harper/issues/345)).
