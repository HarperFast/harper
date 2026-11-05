---
section: 'Component Deploys'
order: 80
---

### Isolated Applications Are Admitted in Startup Order

The `threads.maxIsolated` cap now counts only the isolated applications that get a dedicated worker: those already running, then the rest in root-config order, the order startup admits them. An application whose live release failed closed, such as a first release its canary rejected, no longer holds a place, so it does not block other isolated deploys. A `deploy_component` that would leave its application without a worker in that order is refused with `409`, including a redeploy of an application that is on disk but has no running worker; before, such a deploy could succeed and never start a worker. The same check runs when a refused release is activated again by its `deployment_id`. The deploy also answers `503` when the node cannot read which releases are refused. See [Requirements and refusals](/reference/v5/components/applications#requirements-and-refusals).
