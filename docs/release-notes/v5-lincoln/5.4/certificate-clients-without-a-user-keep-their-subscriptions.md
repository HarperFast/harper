---
section: 'Subscriptions'
---

### Certificate Clients Without a User Keep Their Subscriptions

Since 5.2, live subscriptions are re-authorized periodically and whenever a user or role changes. That recheck revoked any subscription whose user had no role, before rerunning the `allowRead` that admitted it. Some applications authorize mTLS clients in an `allowRead` override, for example by the certificate's CN, and those certificates name no `hdb_user`. Their clients stopped receiving messages about 30 seconds after subscribing, while the connection stayed open.

A client authenticated by a certificate that names no `hdb_user`, and that arrived with no role, is now rechecked by `allowRead` alone, over HTTPS, WSS and MQTT over TLS, until an `hdb_user` record for its name appears; from then on its connection needs a role. A user that a `server.getUser` override builds for a name with no record is not reloaded at all. Every other principal still loses its subscriptions when it has no role, including after `drop_user`. For every client a certificate names, a plain object that a `server.getUser` override returns is now copied onto the request or MQTT connection (its top level, with own getters read once), not used itself; any other object, such as a class instance, is used as returned, and this exemption does not apply to it. See [Row-Level Access Control with Explicit Filters](/reference/v5/database/schema#row-level-access-control-with-explicit-filters) ([harper#4062](https://github.com/HarperFast/harper/issues/4062)).
