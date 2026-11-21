---
section: Resource API
---

### Cached Records Are Checked Against the Schema

A record a caching table fetches from its [source](/reference/v5/resources/resource-api#sourcedfromresource-options) is now checked against the table's schema before it is returned or cached, as a `put` of it would be. A record missing a required attribute, or holding a value of the wrong type, now fails the request with `502` and is not cached; before, it was returned and cached as it came. If a source returns records that do not match the schema, fix the source or the schema before upgrading.
