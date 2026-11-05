---
section: 'Component Deploys'
order: 60
---

### Warning When a Declared Entry Point Matches Nothing

A deploy now warns when a `jsResource.files` or `graphqlSchema.files` pattern in the component's own config matches no file in the release, as a truncated payload would. The deploy still goes ahead. See [Declared entry points that matched nothing](/reference/v5/operations-api/operations#declared-entry-points-that-matched-nothing).
