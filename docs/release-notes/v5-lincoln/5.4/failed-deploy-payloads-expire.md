---
section: 'Component Deploys'
order: 50
---

### Failed Deploy Payloads Expire

A failed deploy keeps its payload for retrying or debugging, but no longer forever: `deployment.payloadRetention.failedMaxAge` (default `7d`) and `failedMaxCount` (default `2`) bound how long, and how many per project, are kept. Each project's newest failed payload is always kept, and the record stays. See [`deployment.payloadRetention`](/reference/v5/configuration/options#deployment).
