---
section: 'Component Deploys'
order: 10
---

### Certifying a Release in a Canary Worker

A `deploy_component` with `restart: true` or `restart: "rolling"` now checks its release before rolling it out. The first worker started on the release, the canary, is held out of traffic until it reports whether the deployed component loaded, and the rollout goes on only if it did. Each later replacement is checked the same way. When the node that received the deploy rejects the release, the deploy fails with `400`. The release it replaced is made live again, or, with nothing to go back to, the component fails closed on that node. A new `certification` field in the response reports the outcome, and says when a restarting deploy went out unchecked (`uncertified` or `unavailable`, as for a `package: file:<dir>` deploy). With `"rolling"`, each other node then certifies the release with a canary of its own, and a node that rejects it does not fail the deploy: the deploy's record ends `partial`, as [Following a Rolling Deploy to Every Node](#following-a-rolling-deploy-to-every-node) describes. A node running a version before 5.4.0 activates without a canary. A deploy that restarts nothing is not test-loaded. If its release throws when it loads, `get_status` reports the failure. See [Certifying a release in a canary worker](/reference/v5/operations-api/operations#certifying-a-release-in-a-canary-worker).
