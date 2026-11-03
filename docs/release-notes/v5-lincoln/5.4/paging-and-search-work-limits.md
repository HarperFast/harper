---
section: 'Full-Text Search'
order: 20
---

### Paging and Search Work Limits

Full-text and autocomplete queries use the existing `limit` and `offset` paging options. Harper reads additional native batches when needed after filtering, so the initial native result window no longer silently cuts off eligible results. The new `storage.fullText.maxRawHitsPerRequest`, `storage.fullText.maxResultsPerRequest` and `storage.fullText.requestBudgetMilliseconds` settings bound fetched hits, retained results and execution time. Requests that exceed those budgets return an error. The `storage.fullText.runtime` section also provides process-wide native-capacity budgets; changes to those budgets require a full Harper process restart. Separate page requests run independently and can see changes to records or index contents.

See [Full-text query execution](/reference/v5/resources/query-optimization#full-text-search-work-and-paging) and [storage configuration](/reference/v5/configuration/options#storage) for limits, restart requirements and recovery guidance.
