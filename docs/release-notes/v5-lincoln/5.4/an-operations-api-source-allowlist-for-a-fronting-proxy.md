---
section: 'Security'
order: 10
---

### An Operations API Source Allowlist for a Fronting Proxy

`set_network_access` stores a list of allowed source CIDRs for the operations API in the `system.hdb_network_access` table, which replicates like users and roles, and `get_network_access` reads it; both are `super_user` only. Harper publishes the list as `allowedSources` in the metadata file of each operations API Unix domain socket (`tls.unixDomainSockets` with `operationsApi.network.securePort`), and rewrites it on each node the change replicates to. A proxy that reads that file, such as Harper Fabric's, admits only the listed addresses. Harper does not enforce the list on its own listeners. Setting a non-empty list that excludes the request's source address, or when Harper cannot tell that address, fails with `409` unless it passes `force: true`; on Node.js the local CLI, over the operations domain socket, is never checked. See [Network Access](/reference/v5/operations-api/operations#network-access) ([harper#3358](https://github.com/HarperFast/harper/issues/3358)).
