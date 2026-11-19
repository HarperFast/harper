---
section: 'REST'
---

### Event Streams Resume After a Reconnect

A table's Server-Sent Events stream now issues event ids, and a reconnect that sends the last one in `Last-Event-ID` (an `EventSource` does this by itself) receives the events committed while the client was away. Before, the stream carried no ids and every reconnect started from the current time. On RocksDB the id is a checkpoint token, sent as an event with an `id` and no `data`, that also resumes on another node of the cluster; elsewhere it is a position in the node's own log.

A position Harper can no longer resume is refused with `400`, `409` or `410`, or ends a running stream with an `event: harper-error` event that clears the client's id, instead of restarting from now. A stream also ends that way when another node's data is copied into its database, where it used to send the current records again in place; the client's reconnect now does that. A client can receive an event twice after a resume and should keep the newer `version` of each record.

A custom resource reads the header as `request.lastEventId`. See [Resuming a Dropped Stream](/reference/v5/rest/server-sent-events#resuming-a-dropped-stream) ([harper#515](https://github.com/HarperFast/harper/issues/515)).
