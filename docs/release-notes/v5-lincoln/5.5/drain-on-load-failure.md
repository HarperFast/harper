---
section: 'Components'
---

### Take a node out of rotation when a component fails to load

The new `status.drainOnLoadFailure` setting (default `false`) makes `get_status` report `availability` as `Unavailable` while any thread has a component that failed to load, and report the stored value again once the component loads. A load balancer that routes on `availability` then stops sending traffic to a node whose application is answering with its load error. An operator's `Unavailable` always wins, and only load failures count, not runtime problems or health checks ([harper#2883](https://github.com/HarperFast/harper/pull/2883), [`status.drainOnLoadFailure`](/reference/v5/configuration/options#statusdrainonloadfailure)).
