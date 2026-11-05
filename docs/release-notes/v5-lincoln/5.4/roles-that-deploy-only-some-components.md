---
section: 'Pull Request Previews'
order: 30
---

### Roles That Deploy Only Some Components

A role's new `component_deploy` grant names the components it may deploy, drop and read, such as `my-app-pr-*`, and can require each deploy to be isolated, under a host suffix, on branched databases, or a preview, with its own `maxPreviews` and `maxTtlDays`. It answers for `deploy_component`, `drop_component`, `get_components`, `list_deployments` and `get_deployment`, ahead of the role's `operations` list. `component_deploy` is now a reserved name, which no database can use. See [Component Deploy Grants](/reference/v5/users-and-roles/overview#component-deploy-grants).

A secret can be granted to a component-name pattern, such as `my-app-pr-*`, so one private-source deploy credential serves every preview; a component's own code still reads only secrets granted to its exact name. `harper deploy setup=true` accepts such a `project` for the `github` and `npm` providers. See [`grant_secret`](/reference/v5/operations-api/operations#grant_secret--revoke_secret).
