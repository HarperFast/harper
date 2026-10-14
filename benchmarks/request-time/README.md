# Request-path cost of `request-time`

Measures what recording `request-time` beside `duration` costs on the HTTP request path, by comparing a build without it (the branch's merge-base) with a build that has it, with analytics on and off.

## What it runs

`drive.mjs` holds `--concurrency` keep-alive loops against one route for `--seconds` and reports requests per second and p50/p90/p99 latency:

```
node benchmarks/request-time/drive.mjs http://127.0.0.1:9926 20 50 GET
node benchmarks/request-time/drive.mjs http://127.0.0.1:9926 20 50 PUT
```

Run it against each build booted the same way: a throwaway root, `--THREADS_COUNT=2`, an application directory exporting `type Probe @table @export { id: ID @primaryKey name: String }` with one row seeded, a 5 s warm-up run, then one GET and one PUT run. `GET /Probe/1` is never queued and records `duration` only; `PUT /Probe/1` goes through the throttle queue and records `request-time` too.

## Result, 2026-10-14

Two-worker instances on an M-series laptop, both builds compiled against the same `node_modules`, two runs where shown.

| build, analytics       | GET req/s       | GET p50 ms  | PUT (queued) req/s | PUT p50 ms  |
| ---------------------- | --------------- | ----------- | ------------------ | ----------- |
| merge-base f038807, on | 31,663 / 30,906 | 1.25 / 1.21 | 22,731 / 22,695    | 1.96 / 1.96 |
| branch, on             | 30,913 / 31,048 | 1.25 / 1.22 | 24,948 / 24,897    | 1.79 / 1.78 |
| branch, off            | 30,891          | 1.21        | 25,748             | 1.73        |

GET is inside run-to-run noise: the unqueued path has no new work. The queued path is faster on the branch than on its merge-base because the branch carries main's commits since the fork; the branch's own cost of analytics on that path, every record it makes including `request-time`, is about 3% of throughput against analytics off.
