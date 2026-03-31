---
id: overview
title: MQTT
---

<!-- Source: versioned_docs/version-4.7/developers/real-time.md (primary) -->
<!-- Source: release-notes/v4-tucker/4.2.0.md (confirmed MQTT introduction, QoS 0/1, durable sessions) -->
<!-- Source: release-notes/v4-tucker/4.3.0.md (confirmed mTLS, single-level wildcards, retain handling, CRDT) -->
<!-- Source: release-notes/v4-tucker/4.5.0.md (confirmed improved message delivery, blob support) -->

<VersionBadge version="v4.2.0" />

Harper includes a built-in MQTT broker that provides real-time pub/sub messaging deeply integrated with the database. Unlike a generic MQTT broker, Harper's MQTT implementation connects topics directly to database records — publishing to a topic writes to the database, and subscribing to a topic delivers live updates for the corresponding record.

## How Topics Map to Database Records

MQTT topics in Harper follow the same path convention as REST endpoints. If you define a table or resource with an endpoint path of `my-resource`, the corresponding MQTT topic namespace is `my-resource`.

A topic of `my-resource/some-id` corresponds to the record with id `some-id` in the `my-resource` table (or custom resource). This means:

- **Subscribing** to `my-resource/some-id` delivers notification messages whenever that record is updated or deleted.
- The **current value** of the record is treated as the retained message for that topic. On subscription, the subscriber immediately receives the current record as the initial retained message — no separate GET request needed.
- **Publishing** with the `retain` flag set replaces the record in the database (equivalent to a PUT operation).
- **Publishing without** the `retain` flag delivers the message to current subscribers without writing to the database.

Defining a table that creates a topic can be as simple as adding a table with no attributes to your [schema.graphql](../database/schema.md) in a Harper application:

```graphql
type MyTopic @table @export
```

## Protocol Support

Harper supports MQTT versions **v3.1.1** and **v5**, with standard publish/subscribe capabilities.

### Topics and Wildcards

Harper supports multi-level topics for both publishing and subscribing:

- **Multi-level wildcard (`#`)** — Subscribe to `my-resource/#` to receive notifications for all records in that resource, including nested paths (`my-resource/some-id`, `my-resource/nested/id`).
- **Single-level wildcard (`+`)** — Added in v4.3.0. Subscribe to `my-resource/+/status` to match any single path segment.

### QoS Levels

- **QoS 0** — At most once delivery (fire and forget).
- **QoS 1** — At least once delivery (acknowledged delivery).
- **QoS 2** — Harper can perform the QoS 2 conversation but does not guarantee exactly-once delivery.

### Sessions

- **Clean sessions** — Subscriptions and queued messages are discarded on disconnect.
- **Durable sessions** — Subscriptions and queued messages are persisted across reconnects.

### Last Will

<VersionBadge version="v4.3.0" />

Harper supports the MQTT Last Will and Testament feature. If a client disconnects unexpectedly, the broker publishes the configured will message on its behalf.

## Content Negotiation

Harper handles structured data natively. Messages can be published and received in any supported structured format — JSON, CBOR, or MessagePack — and Harper stores and delivers them as structured objects. Different clients can independently choose their preferred format: one client may publish in JSON while another subscribes and receives in CBOR.

## Ordering and Distributed Delivery

Harper is designed for distributed, low-latency message delivery. Messages are delivered to subscribers immediately on arrival — Harper does not delay delivery to coordinate consensus across nodes.

In a distributed cluster, messages may arrive out of order due to network topology. The behavior depends on whether the message is retained or non-retained:

- **Retained messages** (published with `retain: true`, or written via PUT/upsert) maintain eventual consistency across the cluster. Harper keeps the message with the latest timestamp as the winning record state. An out-of-order earlier message will not be re-delivered to clients; the cluster converges to the most recent state.
- **Non-retained messages** are always delivered to local subscribers when received, even if they arrive out of order. Every message is delivered, prioritizing completeness over strict ordering.

**Non-retained messages** are suited for applications like chat where every message must be delivered. **Retained messages** are suited for sensor readings or state updates where only the latest value matters.

## Authentication

MQTT connections support two authentication methods:

- **Credential-based** — Standard MQTT username/password in the CONNECT packet.
- **mTLS** — Added in v4.3.0. Mutual TLS authentication using client certificates. The `CN` (common name) from the client certificate subject is used as the Harper username by default.

Authentication is required by default (`requireAuthentication: true`). See [MQTT Configuration](./configuration) for details on disabling authentication or configuring mTLS options.

## Server Events API

JavaScript components can listen for MQTT connection events via `server.mqtt.events`:

```javascript
server.mqtt.events.on('connected', (session, socket) => {
	console.log('client connected with id', session.clientId);
});
```

Available events:

| Event          | Description                                          |
| -------------- | ---------------------------------------------------- |
| `connection`   | Client establishes a TCP or WebSocket connection     |
| `connected`    | Client completes MQTT handshake and is authenticated |
| `auth-failed`  | Client fails to authenticate                         |
| `disconnected` | Client disconnects                                   |

## Feature Support Matrix

| Feature                                       | Support                                                      |
| --------------------------------------------- | ------------------------------------------------------------ |
| MQTT v3.1.1 connections                       | ✅                                                           |
| MQTT v5 connections                           | ✅                                                           |
| Secure MQTTS (TLS)                            | ✅                                                           |
| MQTT over WebSockets                          | ✅                                                           |
| Authentication via username/password          | ✅                                                           |
| Authentication via mTLS                       | ✅ (added v4.3.0)                                            |
| Publish                                       | ✅                                                           |
| Subscribe                                     | ✅                                                           |
| Multi-level wildcard (`#`)                    | ✅                                                           |
| Single-level wildcard (`+`)                   | ✅ (added v4.3.0)                                            |
| QoS 0                                         | ✅                                                           |
| QoS 1                                         | ✅                                                           |
| QoS 2                                         | Not fully supported — conversation supported, not guaranteed |
| Keep-Alive monitoring                         | ✅                                                           |
| Clean session                                 | ✅                                                           |
| Durable session                               | ✅                                                           |
| Distributed durable session                   | Not supported                                                |
| Last Will                                     | ✅                                                           |
| MQTT V5 Subscribe retain handling             | ✅ (added v4.3.0)                                            |
| MQTT V5 User properties                       | Not supported                                                |
| MQTT V5 Will properties                       | Not supported                                                |
| MQTT V5 Connection properties                 | Not supported                                                |
| MQTT V5 Connection acknowledgement properties | Not supported                                                |
| MQTT V5 Publish properties                    | Not supported                                                |
| MQTT V5 Subscribe properties (general)        | Not supported                                                |
| MQTT V5 Ack properties                        | Not supported                                                |
| MQTT V5 AUTH command                          | Not supported                                                |
| MQTT V5 Shared subscriptions                  | Not supported                                                |

## Related

- [MQTT Configuration](./configuration)
- [HTTP Overview](../http/overview.md)
- [Security Overview](../security/overview.md)
- [Database Schema](../database/schema.md)
- [REST Overview](../rest/overview.md)
