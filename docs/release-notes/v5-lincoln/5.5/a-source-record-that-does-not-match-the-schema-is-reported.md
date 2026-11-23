---
section: Resource API
---

### Cached Records That Do Not Match the Schema Are Reported

When a caching table's [source](/reference/v5/resources/resource-api#sourcedfromresource-options) returns a record that does not match the table's schema, Harper now logs a warning naming the table, the record and the attributes, so a schema that disagrees with its source can be found. The record is still cached and returned as the source sent it. A source that returns something other than a record, such as an array or binary data, now fails the request with `502` instead of being cached.
