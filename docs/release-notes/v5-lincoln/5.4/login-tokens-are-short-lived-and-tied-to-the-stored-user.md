---
section: 'Authentication'
---

### Login Tokens Are Short-Lived and Tied to the Stored User

A login token (`create_authentication_tokens` with `purpose: "login"`, which the `login` operation trades for a session cookie) now lives at most [`authentication.maxLoginTokenTimeout`](/reference/v5/security/configuration#maxlogintokentimeout), default `5m`; a longer `expires_in` is shortened to it. A login token stops working when its user's password changes, when the user is dropped, or when the username is dropped and added again, and none is issued for a user with no active stored record. Login tokens issued before this release are refused. See [Login tokens](/reference/v5/operations-api/operations#login-tokens) ([harper#4618](https://github.com/HarperFast/harper/issues/4618)).
