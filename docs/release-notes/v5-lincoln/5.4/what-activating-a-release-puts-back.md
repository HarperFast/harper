---
section: 'Component Deploys'
order: 45
---

### What Activating a Release Puts Back

Activating a staged or earlier release puts back the `host`, `urlPath`, `isolated` and `branchedDatabases` it was deployed with, so it can move an application onto or off its private database copy. Deployment records now say which, as `routing`, so a client can show it before it activates a release. A `routing` of `null` means the release leaves them as they are, and a `null` key means activating it removes that key. A record without `routing` is older, or its deploy has not determined it yet. See [`get_deployment`](/reference/v5/operations-api/operations#get_deployment) ([#4077](https://github.com/HarperFast/harper/issues/4077)).
