---
section: Storage
order: 40
---

### Record history after eviction

Retained audit history stays readable after a record is evicted and across later reinsertion on tables eligible for eviction. Historical reads also reconstruct the complete record after multiple mutations in one transaction.

Plain non-expiring reinsertion on a non-evicting table can still omit older history.

History listings reuse complete audit entries within a bounded read context and build ordinary patch histories incrementally. Unsafe chains and values retain the existing reconstruction behavior. See [#3504](https://github.com/HarperFast/harper/pull/3504).
