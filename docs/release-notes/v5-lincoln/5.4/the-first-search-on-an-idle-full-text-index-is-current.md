---
section: 'Full-Text Search'
---

### The First Search on an Idle Full-Text Index Is Current

A full-text search that did not wait for the index, run on a worker that had not searched that index yet, could return `503` with `code: "DERIVED_INDEX_LAGGING"` while the index was up to date and had received no writes. This happened with `maxIndexLagMilliseconds: 0`, and in 5.4.0-beta.3 with the default as well. A retry succeeded. Once an index has gone about 30 seconds without writes, such a search now returns its results with `Harper-Index-Coverage: current; lag=0`. A search with `waitForIndexMilliseconds` on such a worker no longer makes Harper reopen the index's reader on every worker. A search that arrives just after the first write following a quiet period can still return `503` until the index has applied that write.

See [freshness controls](/reference/v5/full-text-search/querying#freshness-controls).
