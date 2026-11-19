---
section: 'Pull Request Previews'
order: 60
---

### Conflicting Trust Policies Are Refused

When two enabled OIDC trust policies match one identity token and give it a different user or different operations, `exchange_oidc_token` now refuses the token, without spending it, where before the first policy by `id` answered. Operations compare as what they allow, so a permission group such as `read_only` equals the list it expands to. `list_oidc_trust` names each such pair in `invalid_reason`, and its entries carry a new `exchangeable` field. `harper deploy setup=true provider=github-actions` and `enable_previews` refuse to write a policy that would make such a pair. See the [Upgrade Notes](#upgrade-notes) and [`exchange_oidc_token`](/reference/v5/operations-api/operations#exchange_oidc_token) ([harper#3811](https://github.com/HarperFast/harper/pull/3811)).
