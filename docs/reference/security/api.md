---
title: Security API
---

<!-- Source: versioned_docs/version-4.7/reference/globals.md (auth global) -->
<!-- Source: release-notes/v4-tucker/4.5.0.md (server.authenticateUser) -->

# Security API

Harper exposes security-related globals accessible in all component JavaScript modules without needing to import them.

---

## `auth(username, password?): Promise<User>`

Returns the user object for the given username. If `password` is provided, it is verified before returning the user (throws on incorrect password).

```javascript
const user = await auth('admin', 'secret');
// user.role, user.username, etc.
```

This is useful for implementing custom authentication flows or verifying credentials in component code. For HTTP-level authentication configuration, see [Security Overview](./overview.md).
