---
section: 'Resource API'
---

### A Slow Source Fetch No Longer Releases Another Fetch's Hold on a Record

A caching table (`sourcedFrom`) lets one source fetch at a time load a record while other requests for it wait. When that fetch took longer than 10 seconds, a waiting request could release the fetch's hold on the record while it was still running; a second fetch then started, and when the first one finished it released the second one's hold too, so slow origins saw overlapping fetches multiply and every waiting request woke repeatedly. Now only the fetch that holds a record releases it. A fetch still running after 10 seconds gives up its hold, so one more request can fetch, and its late result is cached only if nothing newer was. See [`sourcedFrom`](/reference/v5/resources/resource-api#sourcedfromresource-options).
