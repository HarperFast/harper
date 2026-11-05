---
section: Upgrade Notes
---

### System-table permission declarations

Role declarations cannot grant direct system-table access. Superusers retain Harper-managed read permissions.

- The `add_role` and `alter_role` Operations API requests, and `create_authentication_tokens` requests minting a scoped token, reject `permission.system` with a 400 response.
- Legacy `system` declarations in roles files are ignored with a warning naming the role. Other permissions and roles still apply. Remove these declarations from configuration.
- Legacy scoped tokens lose declared system grants when validated, while their other permissions remain effective. This does not invalidate the token itself.

See [roles-file configuration](/reference/v5/users-and-roles/configuration#managing-roles-with-config-files) and [fix: resolve system table permissions against the live registry #2122](https://github.com/HarperFast/harper/pull/2122) and [fix: discard legacy system grants without blocking role-file upgrades #4038](https://github.com/HarperFast/harper/pull/4038).
