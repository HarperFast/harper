---
section: Upgrade Notes
---

### System-table permission declarations

System-table permissions are managed by Harper. Only superusers may read system tables; role declarations cannot grant system access.

- The `add_role` and `alter_role` Operations API requests reject `permission.system` with a 400 response.
- Legacy `system` declarations in roles files are ignored with a warning naming the role. Other permissions and roles still apply. Remove these declarations from configuration.
- Legacy scoped tokens lose declared system grants when validated, while their other permissions remain effective. This does not invalidate the token itself.
