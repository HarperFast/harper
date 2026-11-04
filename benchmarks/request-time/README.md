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

The same comparison on the other two request paths, same instances and driver, analytics on:

| path                                          | build      | GET req/s       | PUT or POST (queued) req/s |
| --------------------------------------------- | ---------- | --------------- | -------------------------- |
| uWS HTTP port (`HARPER_UWS_HTTP=1`)           | merge-base | 30,359 / 30,302 | 25,077 / 26,945            |
| uWS HTTP port (`HARPER_UWS_HTTP=1`)           | branch     | 30,617 / 30,271 | 25,438 / 24,899            |
| Fastify, operations API `POST /` describe_all | merge-base |                 | 17,214                     |
| Fastify, operations API `POST /` describe_all | branch     |                 | 17,320                     |

Run the operations-API case with `BENCH_PATH=/ BENCH_AUTH=admin:<password> BENCH_BODY='{"operation":"describe_all"}'` against the operations port; its POSTs go through the throttle queue and are handed to Fastify, which records `request-time` from the dispatch stamp. The uWS flag was verified by the absence of Node's `Connection`, `Keep-Alive` and `Transfer-Encoding` headers on the port. All three paths are inside noise.
