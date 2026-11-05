---
section: 'Component Deploys'
order: 100
---

### A Rolling Restart Fails When a Node Did Not Restart

The job behind a replicated `restart_service` (and behind a `restart: "rolling"` deploy whose `certification` is `unavailable`) now ends `ERROR` when any other node did not restart, instead of `COMPLETE`. Its `message` names each node that failed or was skipped, and `result.replicated` holds one entry per other node in both outcomes, with an `error` key, not `message`, for a node that did not restart. A node whose restart failed or may still be running stops the roll, and the nodes after it are reported as skipped; a node whose write queue was full is retried after the others. See [`replicated`](/reference/v5/operations-api/operations#restart_service-replicated) ([harper#3498](https://github.com/HarperFast/harper/pull/3498)).
