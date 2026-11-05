---
section: Upgrade Notes
---

### System-table permission declarations

Role declarations cannot grant direct system-table access. Superusers retain Harper-managed read permissions.

- The `add_role` and `alter_role` Operations API requests reject `permission.system` with a 400 response.
- Legacy `system` declarations in roles files are ignored with a warning naming the role. Other permissions and roles still apply. Remove these declarations from configuration.
- Legacy scoped tokens lose declared system grants when validated, while their other permissions remain effective. This does not invalidate the token itself.

See [roles-file configuration](/reference/v5/users-and-roles/configuration#managing-roles-with-config-files) and [the original system-permission change (#2122)](https://github.com/HarperFast/harper/pull/2122).
