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

Two-worker instances on an M-series laptop. The baseline is the branch's merge-base with main (3fd9ae9d6), both builds compiled against the same `node_modules`; two runs where shown; only 2xx responses count, and every run reported `failed: 0`.

| build, analytics       | GET req/s       | GET p50 ms  | PUT (queued) req/s | PUT p50 ms  |
| ---------------------- | --------------- | ----------- | ------------------ | ----------- |
| merge-base 3fd9ae9, on | 30,069 / 31,034 | 1.40 / 1.40 | 24,901 / 24,744    | 1.78 / 1.78 |
| branch, on             | 31,026 / 31,774 | 1.25 / 1.25 | 24,851 / 25,105    | 1.78 / 1.78 |
| branch, off            | 31,186          | 1.20        | 25,321             | 1.75        |

Both paths are inside run-to-run noise. The unqueued GET path has no new work; the queued PUT path, which records `request-time`, costs under 2% of throughput with analytics on against analytics off, and matches the merge-base.
