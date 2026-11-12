---
section: 'Resource API'
---

### One Stale-While-Revalidate Refresh per Record at a Time

When `allowStaleWhileRevalidate` lets a caching table serve an expired record, a read now starts a background refresh only if no fetch for that record is already running. Before, every read of the expired record started a refresh that waited behind the running one; when the running refresh failed, each waiting refresh called the source again in turn and logged its own warning, so one failing record kept the source and the logs busy for as long as reads kept arriving. Reads still get the stale record at once, and the read after a failed refresh starts a new one. `allowStaleWhileRevalidate` is now called before the refresh starts rather than just after. See [`allowStaleWhileRevalidate`](/reference/v5/resources/resource-api#allowstalewhilerevalidateentry-id-boolean).
