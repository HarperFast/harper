---
section: Replication
---

### Root-Topic Messages Reach Replicas

Messages published to a table's root topic (with no record id) now reach subscribers on receiving nodes. Previously, a `TypeError` could abort the containing replicated transaction, including its record writes.

Upgrading does not re-apply transactions a node has already skipped. Record writes in those transactions may need resynchronization.
