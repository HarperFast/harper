---
section: 'Security'
order: 41
---

### Narrowing a Role's Attribute Permissions Ends Its Open Subscriptions

An open SSE, WebSocket or MQTT subscription now ends once its user's role can no longer read a stored attribute it could read when the subscription opened: after an `alter_role` that removes read on an attribute (or adds `attribute_permissions` to a role that had none), or an `alter_user` that moves the user to a narrower role. Before, the subscription kept delivering the attributes it opened with until it closed. Reconnect to subscribe with the new attribute list; an MQTT connection that authenticated before the change must reconnect before its next `SUBSCRIBE` is accepted. A change that only adds readable attributes leaves open subscriptions as they are. See [Important Rules](/reference/v5/users-and-roles/overview#important-rules).
