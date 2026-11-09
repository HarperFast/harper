---
section: Replication
---

### Increment re-delivery on audit:false tables

Tables with `audit: false` now keep received increment identities through invalidation and a replacement put in the same transaction. Re-delivering a transaction that contains an increment followed by either operation after a newer patch no longer applies the increment twice. A replacement put still clears identities from older transactions.
