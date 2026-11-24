---
section: 'Storage'
---

### A Declared Schema Reaches Every Thread

Adding or removing `@createdTime`, `@updatedTime`, `@expiresAt`, `@hidden` or a field's description on an existing attribute now reaches every thread and survives restarts. Before, threads that do not load the schema never saw the change, and the others lost it whenever they next reloaded the table catalog, which any schema change triggers.

On a node that received a table from a cluster peer before its own schema declared it (a node cloned or added before the application was deployed to it), declaring the schema now gives the table its `@createdTime`, `@updatedTime` and `@expiresAt` fields, its required primary key, and its `@relationship` fields, which resolved to `null` on that node. The node repairs this the first time it loads the schema after the upgrade. Records written before then keep their missing timestamps.

Removing `@indexed` from an attribute now stops Harper from maintaining that index on writes. The index's storage is not reclaimed.
