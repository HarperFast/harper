---
section: 'Component Deploys'
order: 85
---

### A Replicated Isolated Deploy Starts Its Worker on Every Node

A `deploy_component` of a new isolated application now starts its dedicated worker on every node it replicates to. Before, only the node that received the deploy started one. The others logged nothing, served nothing for the application, and their rollout ended `uncertified`. The same applied to a deploy that application code ran with `server.operation`. A node now re-reads `harper-config.yaml` before each restart that starts or stops isolated workers. See [isolated applications](/reference/v5/components/applications#requirements-and-refusals).
