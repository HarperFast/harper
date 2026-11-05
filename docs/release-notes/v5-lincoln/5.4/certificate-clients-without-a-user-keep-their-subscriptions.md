---
section: 'Subscriptions'
---

### Certificate Clients Without a User Keep Their Subscriptions

Since 5.2, live subscriptions are re-authorized periodically and whenever a user or role changes. That recheck revoked any subscription whose user had no role, before rerunning the `allowRead` that admitted it. Some applications authorize mTLS clients in an `allowRead` override, for example by the certificate's CN, and those certificates name no `hdb_user`. Their clients stopped receiving messages about 30 seconds after subscribing, while the connection stayed open.

A principal with no `hdb_user` record is now rechecked by `allowRead` alone. A user with an `hdb_user` record still loses its subscriptions once it has no role, as after `drop_user`. See [Row-Level Access Control with Explicit Filters](/reference/v5/database/schema#row-level-access-control-with-explicit-filters) ([harper#4062](https://github.com/HarperFast/harper/issues/4062)).
