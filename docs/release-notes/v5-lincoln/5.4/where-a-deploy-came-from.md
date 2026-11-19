---
section: 'Component Deploys'
order: 40
---

### Where a Deploy Came From

Deployment records now carry `source`. A deploy made with a token from `exchange_oidc_token` records the claims the exchange verified, such as the repository, commit and workflow run, with `via: "oidc"`. Otherwise `via: "declared"` records what the client said, such as the commit of the checkout the `harper` CLI deployed. `list_deployments` takes `sha` to find the deploys of one commit. See [`get_deployment`](/reference/v5/operations-api/operations#get_deployment).
