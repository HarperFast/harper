---
section: 'Component Deploys'
order: 30
---

### Which Release Is Live on Each Node

The new `list_releases` operation lists, for each component, the release live on a node and the releases it keeps on disk to make live again, each with its `state` (`staged` or `kept`), `at` and `size`; `replicated: true` asks every node. `get_components` entries now carry the live release's `deployment_id`, `deployed_at`, when the deploy that made it live finished, and `restarted_at`, when that node last loaded it. See [`list_releases`](/reference/v5/operations-api/operations#list_releases).
