---
section: 'Security'
---

### Replication Controls Require a Super User

The `X-Replicate-To` header and the operations API `replicateTo` and `replicatedConfirmation` fields now require a super user, checked where client input enters the request context. Before, a non-super user could set them on routes that bypassed a table's default permission checks, including the operations API, and `X-Replicate-To: 0` bypassed the check entirely. Application code that sets these fields on a context is still trusted ([harper#3084](https://github.com/HarperFast/harper/pull/3084)).
