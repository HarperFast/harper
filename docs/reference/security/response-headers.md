---
id: response-headers
title: Response Header Hardening
---

Harper is an origin/API server, and by default it does not emit the browser security-hardening response headers that a public-facing web application typically wants — `X-Content-Type-Options`, `X-Frame-Options`, `Content-Security-Policy`, `Referrer-Policy`, `Strict-Transport-Security`, `Permissions-Policy`, or the `Cross-Origin-*` family (COOP, COEP, CORP). Nor does it emit `Cache-Control`. For browser-facing deployments you generally want to add these.

Where you add them depends on your deployment. On Harper-hosted deployments (Fabric) there is no customer-controlled reverse proxy, CDN, or edge to configure — so the reliable place to set these headers is from your application code, in a custom Resource. If you run your own edge, an edge configuration is also an option (see the fallback note below).

## Setting headers from a custom Resource

A custom [Resource](../resources/resource-api.md) handler can set response headers through the request context. When a Resource method is invoked over HTTP, `getContext()` returns the `Request` object, which carries a `responseHeaders` map with a `set(name, value)` method:

```javascript
export class Product extends tables.Product {
	get(query) {
		const { responseHeaders } = this.getContext();
		// Highest-value, lowest-effort hardening header:
		responseHeaders.set('X-Content-Type-Options', 'nosniff');
		// Frame-embedding and content-source policies go here as well.
		// Keep these conservative and application-specific — e.g. only
		// relax X-Frame-Options if your app is legitimately embedded:
		responseHeaders.set('X-Frame-Options', 'SAMEORIGIN');
		// responseHeaders.set('Content-Security-Policy', "default-src 'self'");
		return super.get(query);
	}
}
```

`X-Content-Type-Options: nosniff` is the highest-value, lowest-effort header to add: it stops browsers from MIME-sniffing a response away from its declared `Content-Type`, closing a class of content-injection attacks with essentially no cost.

This applies to responses that flow through the custom Resource handler that sets them. It does not retroactively harden other endpoints — see the gap below.

## The gap: auto-generated endpoints and global defaults

There is currently no built-in or configuration-based way to apply these headers to Harper's auto-generated HTTP surfaces — the REST endpoints Harper exposes for a table, and the GraphQL endpoint — and no global response-header default that applies across all surfaces. The `responseHeaders` mechanism above only covers responses served by a custom Resource handler you have written.

For now, security headers can be added from custom Resources; global and auto-endpoint coverage is tracked in [HarperFast/harper#1567](https://github.com/HarperFast/harper/issues/1567) ("Provide a built-in way to set security/cache response headers across all HTTP surfaces").

These defaults may tighten in a future release. Treat the guidance here as current behavior, not a permanent guarantee — check the release notes if you are relying on the absence of a header.

## Caching of authenticated responses

Harper does not emit `Cache-Control` on its responses. If a response is cached by anything shared between users — a CDN, a proxy cache, or a browser cache on a shared machine — a response that depends on the caller's identity must not be stored and replayed for a different caller. This includes authenticated reads and `allowRead`-gated rows, or any response that varies by `Authorization`.

Until a built-in control lands (also tracked in [#1567](https://github.com/HarperFast/harper/issues/1567)), you can set `Cache-Control` from a custom Resource the same way as the hardening headers above:

```javascript
get(query) {
	const { responseHeaders } = this.getContext();
	// Prevent shared caches from storing an identity-dependent response:
	responseHeaders.set('Cache-Control', 'no-store');
	return super.get(query);
}
```

If you do want identity-scoped responses cached, key the cache on identity (e.g. vary on `Authorization` or the session cookie) rather than storing a single shared copy. Getting this wrong can return one user's private data to another, so default to `no-store` for anything that depends on who is asking.

## Fallback: setting headers at your own edge

If you self-host Harper behind your own reverse proxy or CDN (not applicable to Harper-hosted/Fabric deployments), you can add the same headers there instead. This is the fallback rather than the primary answer, since the hosted deployment model has no such edge to configure. A minimal Nginx example:

```nginx
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options        "SAMEORIGIN" always;
add_header Referrer-Policy        "strict-origin-when-cross-origin" always;
```

CSP and `Strict-Transport-Security` values are application-specific; set them based on the origins your application legitimately loads from and your HTTPS posture.

## Related

- [Resource API](../resources/resource-api.md) — Custom Resource handlers and the request context
- [REST Headers](../rest/headers.md) — Standard request/response headers Harper does emit
- [Security Overview](./overview.md)
