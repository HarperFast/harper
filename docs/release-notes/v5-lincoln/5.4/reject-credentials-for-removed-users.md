---
section: Authentication
---

### Operation tokens and session cookies require an active user

After you drop a user, Harper returns HTTP 401 for their [operation tokens](/reference/v5/security/jwt-authentication), even before the tokens expire. The built-in session lookup also requires an active stored user. Applications that establish sessions for external identities can supply those principals through `server.getUser`.

When Harper rejects a session for a missing or inactive user, it expires the cookie so that the browser can retry login.

Recreating the same username can make an unexpired token or existing session cookie usable again.

Authentication audit events omit session IDs, which are credentials. [#4124](https://github.com/HarperFast/harper/issues/4124)
