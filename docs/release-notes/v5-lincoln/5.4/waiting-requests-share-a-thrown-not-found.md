---
section: 'Resource API'
---

### Requests Waiting on a Source Fetch Share a Thrown Not-Found

When many requests for the same missing record of a caching table (`sourcedFrom`) wait on one source fetch and the source throws an error whose `statusCode` is 404 or 410, as an HTTP client that throws on any non-2xx response does, the requests waiting in the same worker thread now receive that error instead of each calling the source again in turn. Before, a burst of such requests made one source call per request, one after another, and each failure woke every waiting request to try again. Each request gets its own copy of the error, with the same class, status and message. Other failures are still retried by the waiting requests, and nothing is cached, so the next request after the burst calls the source again. See [`sourcedFrom`](/reference/v5/resources/resource-api#sourcedfromresource-options).
