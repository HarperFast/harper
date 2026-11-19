---
section: 'Resource API'
---

### Residency Hooks and Indexed Computed Resolvers Are Deprecated

`Table.setResidency`, `Table.setResidencyById` and `setComputedAttribute` resolvers on `@indexed` attributes are deprecated in 5.4 and log a warning when registered. They run in application code, which the dedicated replication worker pool does not load. With `replication.threads` omitted, a node with two or more HTTP workers and a dedicated replication port starts `floor(threads.count / 2)` replication workers by default; if an application registers one of these hooks at boot, no pool starts and one warning names the tables. A hook registered after boot, from a deferred load or a later deploy, only warns. An explicit `replication.threads` keeps its value, and `replication.threads: 0` opts out of the pool ([harper#3232](https://github.com/HarperFast/harper/pull/3232), [harper#3833](https://github.com/HarperFast/harper/pull/3833)).
