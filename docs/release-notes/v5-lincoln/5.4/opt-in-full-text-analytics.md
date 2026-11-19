---
section: 'Analytics'
order: 20
---

### Opt-in Full-Text Analytics

Optional `analytics.fullText` collection reports full-text operation counters, queue occupancy and cached reader observations through the existing `fulltext` analytics metric. Collection is off by default and requires Harper analytics enabled on a writable node; enabling it applies dynamically without reopening indexes. The implied per-handle cadence is 60 seconds, with histogram recording and reader-byte observation separately opt-in. Rows retain exact decimal counters and the newest observation per worker/index/role. Qualify the cost for your workload; no production overhead bound is claimed. See [Full-text analytics](/reference/v5/analytics/overview#full-text-analytics) and [`analytics.fullText` configuration](/reference/v5/configuration/options#analyticsfulltext).
