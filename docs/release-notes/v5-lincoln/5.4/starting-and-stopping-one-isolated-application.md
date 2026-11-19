---
section: 'Component Deploys'
order: 70
---

### Starting and Stopping One Isolated Application

The first `restart: true` deploy of a new isolated application now starts only its own worker, which is that release's canary, instead of also restarting the shared workers. Dropping an isolated application stops its worker with or without `restart`, and `drop_component` removes an application's forks by default; `keepBranches: true` keeps them. A removal the drop cannot finish, because a worker still has the fork loaded or the removal failed, is recorded and retried until it succeeds ([harper#3600](https://github.com/HarperFast/harper/pull/3600)). Dropping an application a node does not have restarts nothing there. The response reports `node`, `componentRemoved`, `workerStopped`, and `branchesRemoved` for the node that answered, and the same for each peer in `replicated`, so a preview's cleanup can be one replicated drop. See [Restarting and dropping](/reference/v5/components/applications#restarting-and-dropping) and [Removing a fork](/reference/v5/components/applications#removing-a-fork).
