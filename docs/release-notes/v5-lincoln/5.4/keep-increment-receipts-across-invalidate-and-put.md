---
section: Replication
---

### Increment Re-delivery on audit:false Tables

On tables with `audit: false`, re-delivering a transaction no longer applies an increment twice after the record was invalidated, or after the same transaction replaced it with a put. A re-delivered increment can still apply again if a later transaction has since replaced the record with a put.
