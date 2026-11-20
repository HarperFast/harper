---
section: 'REST'
---

### Event Streams Resume After a Reconnect

A table's Server-Sent Events stream now issues event ids, and a reconnect that sends the last one in `Last-Event-ID` (an `EventSource` does this by itself) resumes from it. Before, the stream carried no ids and every reconnect started from the current time.

On RocksDB the id is a checkpoint token, sent as an event with an `id` and no `data`. A reconnect with a token delivers the changes committed while the client was away, including a transaction that was still open when the token was issued, and it also resumes on another node of the cluster. Until the stream sends its first token (within about five seconds of connecting), and for the whole stream where it cannot issue one, such as on LMDB, each event carries a position in the node's own log instead. A reconnect with a log position can miss a transaction that commits later with an earlier log key. [Resuming a Dropped Stream](/reference/v5/rest/server-sent-events#resuming-a-dropped-stream) lists when a stream sends each kind.

A position Harper can no longer resume is refused with `400`, `409` or `410`, or ends a running stream with an `event: harper-error` event that clears the client's id, instead of restarting from now. A stream also ends that way when another node's data is copied into its database, where it used to send the current records again in place; the client's reconnect now does that. A client can receive an event twice after a resume and should ignore one whose `version` is older than the record it holds. Until every node of a cluster runs 5.5, a reconnect that reaches an older node starts a new subscription as before.

A custom resource reads the header as `request.lastEventId`. See [In a Custom Resource](/reference/v5/rest/server-sent-events#in-a-custom-resource) ([harper#515](https://github.com/HarperFast/harper/issues/515)).
