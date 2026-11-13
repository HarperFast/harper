---
section: 'Security'
---

### Package URL Credentials Are Redacted

A package URL can carry a credential, such as `https://user:token@github.com/org/repo.git`. `get_components`, `list_deployments` and `get_deployment` now show it as `https://[REDACTED]@host/…` to anyone but a super user, across every string in a deployment row and its events. Package fetch errors, logged subprocess output and load-failure messages are redacted, and with `http.logging.headers` on, `Authorization` and `Cookie` values are logged as `[REDACTED]`. Stored values are unchanged, so installs and Studio's Redeploy work as before. `get_configuration` still returns the raw configuration to a role granted it, and logs written before the upgrade keep what they hold ([harper#3991](https://github.com/HarperFast/harper/pull/3991)).
