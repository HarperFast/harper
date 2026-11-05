---
section: 'Pull Request Previews'
order: 20
---

### Previews Expire, and Are Capped

A `deploy_component` can carry `preview` metadata naming its application, PR, branch, commit and `expiresAt`, deployed as `<app>-pr-<n>`. The cluster drops a preview once it expires, checking every `deployment.previews.sweepInterval` (10 minutes by default); `deployment.previews.maxPerApplication` caps how many previews of one application a node keeps live; and a preview's component keeps `deployment.previews.stagingRetention.maxCount` (default `1`) replaced releases. `get_components` and the deployment record show the metadata. See [Preview deployments](/reference/v5/operations-api/operations#preview-deployments).
