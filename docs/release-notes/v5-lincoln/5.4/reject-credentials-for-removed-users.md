---
section: Authentication
---

### Operation tokens and session cookies require an active user

After you drop a user, Harper returns HTTP 401 for their [operation tokens](/reference/v5/security/jwt-authentication), even before the tokens expire. The same applies to existing session cookies that Harper resolves through its built-in user lookup.
