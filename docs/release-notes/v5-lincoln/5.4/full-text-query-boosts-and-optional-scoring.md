---
section: 'Full-Text Search'
order: 30
---

### Full-Text Query Boosts and Optional Scoring

Full-text conditions now accept `boost` to scale a required text score and `should` to add optional scoring clauses without expanding the matching records. Use these controls through `Table.search()`, HTTP `QUERY`, or `search_by_conditions`; select `$score` to return the adjusted relevance score. Optional clauses search the same index and require read access to their source fields. No index rebuild is needed for query-time scoring. See [Query-Time Relevance Controls](/reference/v5/full-text-search/querying#query-time-relevance-controls).

**Upgrade impact:** `boost` and `should` are now reserved query-object keys on all tables. Misplaced controls return HTTP 400 instead of being ignored; rename custom keys that previously used these names. Attributes named `boost` or `should` remain queryable through the `attribute` property.
