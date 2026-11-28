---
section: Storage
---

### Audit History Across Origins

Historical reads can now find a record's committed audit entry when another node appended an older transaction after a matching timestamp. The same fix lets out-of-order full record writes find the audit history they need to preserve newer changes.
