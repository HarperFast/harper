---
section: 'Component Deploys'
order: 20
---

### Following a Rolling Deploy to Every Node

A certified `"rolling"` deploy now responds with `status: "rolling_out"`, and its deployment record follows the job that takes the release to the other nodes. The record names the job in `restart_job_id`, adds each node's outcome to its `peer_results` entry as `activation`, and ends `success` once every node has taken the release, or `partial` with `error.nodes` naming each node that did not. A job that fails before it reaches every node ends the record `partial`; one cut short by its node restarting, or unable to write the record's end, is settled at that node's next start from the job's own result. The record replicates, so any node answers `get_deployment` for it, where before only the node that received the deploy knew the job's outcome. `harper deploy restart=rolling` now waits on the record, prints each node's outcome, and exits non-zero when a node did not take the release or the wait runs out; `wait=false` skips the wait, and `wait_timeout=<ms>` bounds it. That wait needs `get_deployment`, which the role `harper deploy setup=true` creates now grants. A CI role written by hand with an `operations` list needs it added with `alter_role`, as does a trust policy scoped with `operations`; until then pass `wait=false`, or the wait is refused after the node you called has taken the release. See [Waiting for a rolling deploy](/reference/v5/cli/commands#waiting-for-a-rolling-deploy).
