---
section: 'REST'
order: 10
---

### A JSON Response That Fails Mid-Stream Is Cut Off

[Cut off a JSON response that fails mid-stream](https://github.com/HarperFast/harper/pull/3664) changes how a streamed JSON array reports a failure after its `200` status is sent. Harper still writes an `{"error": ...}` element, but now leaves out the closing `]` and aborts the connection, instead of closing the array and ending the response normally. A partial result no longer parses as a complete one. Clients should treat a cut-off body, such as `response.json()` rejecting, as a failed read. NDJSON and Server-Sent Events responses are unchanged. A `json` `export_local` whose query fails now ends its job with `ERROR` and removes the partial file.

A common trigger is a client that stops reading a large collection query for longer than `storage.maxTransactionOpenTime` (default 30 seconds), which on RocksDB fails the read with `ReadSnapshotExpiredError`. See [When a Streamed Response Fails](/reference/v5/rest/content-types#when-a-streamed-response-fails) and [`storage.maxTransactionOpenTime`](/reference/v5/database/storage-tuning#storagemaxtransactionopentime) ([harper#2392](https://github.com/HarperFast/harper/issues/2392)).
