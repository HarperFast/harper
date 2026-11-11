---
section: 'Full-Text Search'
---

### The First Search on an Idle Full-Text Index Is Current

A full-text search that did not wait for the index, run on a worker that had not searched that index yet, could return `503` with `code: "DERIVED_INDEX_LAGGING"` while the index was up to date and had received no writes. This happened with `maxIndexLagMilliseconds: 0`, and in 5.4.0-beta.3 with the default as well. A retry succeeded. Once a database has gone about 30 seconds without a write to any of its tables, such a search on its full-text indexes now returns its results with `Harper-Index-Coverage: current; lag=0`. A search with `waitForIndexMilliseconds` on such a worker no longer makes Harper reopen the index's reader on every worker. A search that arrives just after a write ends the quiet period can still return `503` until the index has caught up with that write.

See [freshness controls](/reference/v5/full-text-search/querying#freshness-controls).
