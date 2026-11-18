---
section: Authentication
---

### Operation tokens and session cookies require an active user

After you drop a user, Harper returns HTTP 401 for their [operation tokens](/reference/v5/security/jwt-authentication), even before the tokens expire. The built-in session lookup also requires an active stored user. Applications that establish sessions for external identities can supply those principals through `server.getUser`.

The native Operations API can verify fresh login credentials even when a request carries a rejected session cookie. A successful login issues a new cookie.

Recreating the same username can make an unexpired token or existing session cookie usable again.

Authentication audit events omit session IDs, which are credentials. [#4124](https://github.com/HarperFast/harper/issues/4124)
