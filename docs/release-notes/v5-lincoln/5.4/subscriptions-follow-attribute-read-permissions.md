---
section: 'Security'
order: 40
---

### Subscriptions Follow Attribute Read Permissions

A role with `attribute_permissions` now receives only the attributes it may read in each subscription message over SSE, WebSocket and MQTT: the current record, live changes, replayed history and published messages. Before, these messages carried every stored attribute. Computed and relationship attributes are left out of these messages, even when the role may read them; a GET can still return them. A message stored as `{ contentType, data }`, which is how Harper stores most MQTT payloads that are not JSON, is filtered like a record, so it arrives as `{}` unless the role may read an attribute named `contentType` or `data`; string and binary values published from code arrive unchanged. For every role, subscription events no longer carry internal storage fields such as `metadataFlags` and `expiresAt`, or the audit record's `user` and `nodeId`. See [Important Rules](/reference/v5/users-and-roles/overview#important-rules) ([harper#3307](https://github.com/HarperFast/harper/pull/3307)).
