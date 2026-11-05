---
id: basic-authentication
title: Basic Authentication
---

<!-- Source: versioned_docs/version-4.7/developers/security/basic-auth.md (primary) -->

Available since: v4.1.0

Harper supports HTTP Basic Authentication. In the context of an HTTP transaction, [Basic Authentication](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Authentication#basic_authentication_scheme) is the simplest authorization scheme which transmits credentials as username/password pairs encoded using base64. Importantly, this scheme does not encrypt credentials. If used over an insecure connection, such as HTTP, they are susceptible to being compromised. Only ever use Basic Authentication over secured connections, such as HTTPS. Even then, its better to upgrade to an encryption based authentication scheme or certificates. See [HTTP / TLS](../http/tls.md) for more information.

## How It Works

Each request must contain the `Authorization` header with a value if `Basic <credentials>`, where `<credentials>` is the Base64 encoding of the string `username:password`.

```
Authorization: Basic <base64(username:password)>
```

## Example

The following example shows how to construct the Authorization header using `btoa()`:

```javascript
const username = 'HDB_ADMIN';
const password = 'abc123!';
const authorizationValue = `Basic ${btoa(`${username}:${password}`)}`;
```

Then use the `authorizationValue` as the value for the `Authorization` header such as:

```javascript
fetch('/', {
	// ...
	headers: {
		Authorization: authorizationValue,
	},
	// ...
});
```

## cURL Example

With cURL you can use the `--user` (`-u`) command-line option to automatically handle the Base64 encoding:

```bash
curl -u "username:password" [URL]
```

## When to Use Basic Auth

Basic authentication is the simplest option and is appropriate for:

- Server-to-server requests in trusted environments
- Development and testing
- Scenarios where token management overhead is undesirable

For user-facing applications or when tokens are preferred for performance reasons, see [JWT Authentication](./jwt-authentication.md).
