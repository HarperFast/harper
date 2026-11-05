---
section: Vector Search
---

### Vector thresholds beside other conditions and through relationships

A vector distance threshold (`{ attribute, comparator: 'lt', value, target }`) now returns the right records wherever it sits in a query. When another condition was narrower, it compared each coordinate of the stored vector to the threshold instead of the distance, and could return records outside the threshold; it now checks each candidate's exact distance. A threshold on a relationship path (`['product', 'embedding']`), inside a relationship group (`products[...]`), or reached through a relationship into another database, used to fail with `A target vector must be provided` or a transaction error, and now runs. An OR led by a vector condition no longer fails. See [Filtering by Distance Threshold](/reference/v5/database/schema#filtering-by-distance-threshold).

**Upgrade impact:** a query whose threshold condition is not its narrowest condition can return fewer records: the ones outside the threshold are gone. An `lt` or `le` condition on a vector attribute without `target`, or a condition with `target` and another comparator, now returns HTTP 400 wherever it sits, as it already did when it drove the search.

This change is not released yet.
