---
section: 'Component Deploys'
order: 90
---

### Setting Up GitHub Actions Deploys

`harper deploy setup=true provider=github-actions` sets a cluster up so a GitHub Actions workflow can deploy with its OIDC identity token instead of a stored credential. It creates a deploy-only role and user, a trust policy matching the workflow's repository, branch and environment, and the repository's `HARPER_CLI_TARGET` variable. It checks the policy against the workflow file in the repository's checkout before it writes, where it can, and reads it back after. It only creates: running it again leaves the cluster and the variable as they are, a record that differs, or that someone deactivated or disabled, stops it before it writes, and a `HARPER_CLI_TARGET` that names another cluster is left in place. A policy with the same id that another super user creates in the moment before setup writes it is still overwritten. See [GitHub Actions deploys (OIDC)](/reference/v5/cli/commands#github-actions-deploys-oidc).
