---
section: 'Authentication'
order: 10
---

### Local Requests Use a Built-in User

Requests trusted by `authorizeLocal`, the operations API domain socket (including the local CLI), or raw-TCP MQTT loopback under `authorizeLocal` now run as a built-in super user named `local`, independently of stored users. Attribution such as audit entries and job owners now reads `local`. New users cannot be named `local`; an existing stored user with that name keeps working. Credential-free token minting still issues tokens for a stored super user and fails with HTTP 409 if none is eligible. Local trust is not saved in sessions. See [Local request identity](/reference/v5/security/configuration#local-request-identity), [`add_user`](/reference/v5/users-and-roles/operations#add-user), and [`create_authentication_tokens`](/reference/v5/operations-api/operations#create_authentication_tokens) ([harper#3755](https://github.com/HarperFast/harper/pull/3755)).

Bun and uWebSockets requests delegated to Fastify retain their verified peer address. Under Bun, remote callers must authenticate even when `authorizeLocal` is enabled; a missing peer address no longer grants localhost trust.
