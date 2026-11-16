---
section: 'Full-Text Search'
order: 20
---

### Stored-Field Sorting and Exact Counts

[Allow stored-field sorting and exact counts for full-text search](https://github.com/HarperFast/harper/pull/3846) adds directly stored sort fields and bounded exact eligible-record totals to full-text and autocomplete queries. Default ordering remains descending relevance. Enable `rest.exactCount` and send `Prefer: count=exact` for REST totals, or use `count: 'exact'` in `Table.search()`.

Sorting must enumerate the complete eligible set within the configured search budgets. A relevance-ordered query preserves its page and highlights if optional tail counting exceeds a work, time or native-admission limit, returning an unknown total. Cancellation and other execution failures remain errors. Final-page preparation preserves highlights when expiry removes a candidate. See [ordering and counts](/reference/v5/full-text-search/querying#score-and-ordering) for supported sort keys and source-refresh semantics.

This change is not released yet.
