---
section: 'Pull Request Previews'
order: 40
---

### Payload Deploys Can Set Routing, Isolation and Branching

A payload deploy, such as `harper deploy` from a directory, can now set `host`, `urlPath`, `isolated` and `branchedDatabases`, which it used to refuse or ignore. One that sets any of them sets all four, keeping the current value of each it leaves out, and going back to its release restores them. See [How a deploy updates the root config](/reference/v5/operations-api/operations#how-a-deploy-updates-the-root-config).

**Upgrade impact:** a `project` with a character other than letters, numbers, `-` and `_`, after an npm scope and archive extension are removed, now fails with `400`. `my-app.pr-12` used to deploy over `my-app`.
