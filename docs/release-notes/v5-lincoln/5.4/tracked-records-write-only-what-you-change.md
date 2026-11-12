---
section: 'Resource API'
---

### In-Place `Date` and `Bytes` Changes No Longer Save

On a record returned by `update()`, a `Date` or `Bytes` property must now be reassigned to be saved. Changing it in place (`record.when.setTime(...)`, `record.bytes[0] = 9`) used to save; it no longer does, and no error is raised. Assign a new value instead, such as `record.when = new Date(...)`. `Date` and `Bytes` elements of an array property still save when changed in place. See [What a tracked record writes](/reference/v5/resources/resource-api#what-a-tracked-record-writes).

### Tracked Records Write Only What You Change

A record returned by `update()` no longer writes properties you only read: reading a sub-object or an array element saves nothing, sends nothing to a source's `patch` and adds nothing to the audit history. On a table that is not `@sealed`, assigning an undeclared property saves it even when nothing else changed.

### `addTo` and `subtractFrom` Calls Combine

Repeated `addTo` / `subtractFrom` calls on one property in a transaction now add up instead of the last one winning, and a delta after an assignment adds to the assigned value (the write is still an assignment, so it does not merge with concurrent writers). `subtractFrom` accepts a BigInt, and on an `Int`, `Long`, `Float` or `Number` property a BigInt delta is converted to a number (one beyond 2^53 in magnitude is rejected). See [`addTo`](/reference/v5/resources/resource-api#addtoproperty-string-value-number).
