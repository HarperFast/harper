---
section: 'REST'
---

### Read Requests Get Admission Control

`GET`, `HEAD` and `OPTIONS` requests now get a `503` when they arrive after the current event-loop iteration has already run longer than `http.readRequestQueueLimit` (default `5000` ms). A read is never queued: it runs at once or is refused. Set `http.readRequestQueueLimit: false` to turn this off. Writes keep the existing request queue ([harper#3234](https://github.com/HarperFast/harper/pull/3234)).
