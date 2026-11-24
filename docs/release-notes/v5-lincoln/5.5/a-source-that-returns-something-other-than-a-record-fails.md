---
section: Resource API
---

### A Source That Returns Something Other Than a Record Fails

A caching table's [source](/reference/v5/resources/resource-api#sourcedfromresource-options) that returns an array, binary data or a string instead of a record now fails the request with `502`, and nothing is cached. Before, an array or binary value was cached as if it were a record, and a string failed with `500`. The reference now also states that a record the source returns is cached without being checked against the table's schema.
