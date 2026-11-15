---
section: 'Full-Text Search'
order: 30
---

### No-Wait Full-Text Searches Wait for Their Reader

A full-text search that passed `waitForIndexMilliseconds: 0` could fail with `503 Full-text reader acquisition exceeded the index-wait budget` while the node refreshed or reopened its search reader. This happened after index publications and every 30 seconds or so on an idle index. Reader acquisition now has its own 30-second limit, so `0` behaves like an omitted value: the query waits for the reader and then searches. `waitForIndexMilliseconds` bounds only the wait for index coverage, so a waiting query's total time can exceed it by the time spent acquiring the reader. A query that times out acquiring a reader returns `503 Full-text reader acquisition timed out` ([#4224](https://github.com/HarperFast/harper/issues/4224)).

See [freshness controls](/reference/v5/full-text-search/querying#freshness-controls).
