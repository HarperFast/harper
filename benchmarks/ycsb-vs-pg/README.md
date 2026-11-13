# Harper vs. a conventional Node stack (YCSB over REST)

A rough head-to-head: the same YCSB-style REST workload driven against

| Target                      | What answers the request                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `harper`                    | Harper core (this checkout's `dist/`), `usertable` over REST — database, cache and app in one process |
| `harper-sized`              | Same, with `storage.recordCacheSize` raised to the next power of two ≥ the record count               |
| `harper-uws`                | `harper` with its plaintext HTTP port on uWebSockets.js (`HARPER_UWS_HTTP=1`) instead of Node's HTTP  |
| `harper-uws-sized`          | `harper-uws` with the sized record cache                                                              |
| `harper-base`               | Another Harper build (`--base-harper=<dist/bin/harper.js>`), driven by this harness                   |
| `harper-uws-rc3g-4t`        | `harper-uws` with a 768 MiB record cache on each of 4 threads (3 GiB in all), see below               |
| `harper-uws-rc3g-2t`        | The same 3 GiB on 2 threads, 1.5 GiB each                                                             |
| `harper-uws-rc3g-4t-vt128k` | `harper-uws-rc3g-4t` with the default 128K-slot verification table                                    |
| `harper-uws-vt16m`          | `harper-uws` with only the verification table enlarged, to 16M slots                                  |
| `harper-uws-2t`             | `harper-uws` on 2 threads, stock record cache                                                         |
| `pg-redis`                  | Fastify → Redis look-aside cache → Postgres                                                           |
| `pg-only`                   | Fastify → Postgres (no cache), to isolate what the cache is buying                                    |

**Which change moved Harper's read numbers in September 2026.** The read-only gain
then (workload C 30.5k → 42k ops/s; Harper CPU-seconds 58 → 42) came from the HTTP
layer, not the record cache: Fastify's HTTP layer alone was 40.3 of the stack's 60.8
CPU-seconds on C, and serving Harper over uWebSockets.js moved C from 1.03x to 1.41x
of `pg-redis`. Sizing the record cache on top of uWS added about 12% (42.1k → 46.8k).
The `harper-uws*` targets keep that comparison in every run.

It reuses `benchmarks/ycsb` for the load generator, key distributions, workload
mixes and the 10 × 100 B record shape. The only variable is the server. See
`benchmarks/ycsb/README.md` for the workload definitions and the REST operation
mapping.

## Results: full matrix on GCP (2026-11-12)

harper-uws, harper (Node's HTTP server) and pg-redis, each on its own 4-core VM, on seven workloads at three dataset sizes: 3 targets × 7 workloads × 3 points × 3 reps, `--auth=token`. Run with `gcp/run-matrix.sh --all` (matrix `ycsb-20261113-0157-cf6c`). Profiles of warm C and chain-4 are in [PROFILE.md](PROFILE.md#warm-c-and-chain-4-on-gcp-token-auth-2026-11-12).

**Where each side wins.**

- **Warm, one stored record per request (C, B, inspect, F): pg-redis, by 14–20%.** Each read is one Redis `GET` that returns the record's stored bytes. Harper's fixed cost per request is about 11 µs/op higher: its read transaction, the RocksDB get path and the record cache. uWS and Harper's token cache win part of that back. On C both retire about 231k instructions per op; the gap is in instructions per cycle, 1.22 against 1.53 on these VMs. Part of that is the harper VM's host: the counting A/B's harper VM ran C at IPC 1.30–1.36, for a ratio of 0.91 instead of 0.84.
- **Warm, dependent reads: Harper, by 4% at chain-1 rising to 39% at chain-4.** Each extra read costs harper-uws 43k instructions and 8.3 µs/op of CPU, against 100k and 15.6 µs/op for pg-redis. The stack's extra read is a Redis round trip, a `JSON.parse` and the garbage collection they cause. Harper's is an in-process read through the request's own transaction.
- **2x and 8x, dataset larger than memory: Harper, on every workload.** C is 1.48× and 1.63×, chain-4 1.89× and 1.88×, F 1.05× and 1.15×. Redis holds 3 GiB of a 17 or 69 GB dataset, so about 40% (2x) and 45% (8x) of single-record reads miss it. Each miss goes to Postgres on the same VM and then fills Redis. Harper's misses stay in-process: a record-cache miss is a RocksDB block-cache, page-cache or SSD read. On C the stack retires 400k instructions per op at 2x, against 232k warm; Harper 293k, against 230k.
- **harper-uws over harper: uWS by 2–14% warm and 8–20% at 2x and 8x.** Node's HTTP server costs Harper 18–70k more instructions per request.

Throughput ratios, median reps:

| workload | warm uws/pg-redis | warm uws/harper | 2x uws/pg-redis | 2x uws/harper | 8x uws/pg-redis | 8x uws/harper |
| -------- | ----------------: | --------------: | --------------: | ------------: | --------------: | ------------: |
| C        |              0.84 |            1.11 |            1.48 |          1.20 |            1.63 |          1.18 |
| B        |              0.85 |            1.14 |            1.30 |          1.18 |            1.39 |          1.19 |
| inspect  |              0.83 |            1.06 |            1.46 |          1.17 |            1.64 |          1.16 |
| chain-1  |              1.04 |            1.13 |            1.55 |          1.13 |            1.76 |          1.11 |
| chain-2  |              1.11 |            1.03 |            1.74 |          1.14 |            1.77 |          1.09 |
| chain-4  |              1.39 |            1.02 |            1.89 |          1.09 |            1.88 |          1.08 |
| F        |              0.88 |            1.10 |            1.05 |          1.08 |            1.15 |          1.09 |

Cost of each additional dependent read, from the median reps. (chain-4 − C) / 4 also charges the stack one `JSON.parse` that C skips (its C returns Redis's bytes), so the chain-1 column compares requests of one shape:

| point | target     | instructions/op C, chain-1, chain-4 | per extra read | same, from chain-1 | CPU µs/op C, chain-1, chain-4 | per extra read | same, from chain-1 |
| ----- | ---------- | ----------------------------------: | -------------: | -----------------: | ----------------------------: | -------------: | -----------------: |
| warm  | harper-uws |              230.4k, 297.4k, 402.4k |          43.0k |              35.0k |              48.5, 59.0, 81.8 |            8.3 |                7.6 |
| warm  | harper     |              262.2k, 316.5k, 421.7k |          39.9k |              35.1k |              55.6, 65.8, 82.2 |            6.6 |                5.5 |
| warm  | pg-redis   |              231.6k, 352.5k, 630.1k |          99.6k |              92.6k |             39.0, 59.4, 101.5 |           15.6 |               14.0 |
| 2x    | harper-uws |              292.7k, 376.9k, 512.9k |          55.1k |              45.4k |             67.9, 93.3, 123.5 |           13.9 |               10.0 |
| 2x    | harper     |              348.6k, 421.3k, 555.2k |          51.7k |              44.6k |            81.9, 105.3, 137.1 |           13.8 |               10.6 |
| 2x    | pg-redis   |              399.7k, 584.5k, 924.3k |         131.2k |             113.3k |           105.4, 150.1, 231.7 |           31.6 |               27.2 |
| 8x    | harper-uws |              301.0k, 384.8k, 524.5k |          55.9k |              46.6k |             69.3, 96.9, 130.7 |           15.4 |               11.3 |
| 8x    | harper     |              358.4k, 433.3k, 572.5k |          53.5k |              46.4k |            83.0, 109.2, 144.5 |           15.4 |               11.8 |
| 8x    | pg-redis   |              435.4k, 643.0k, 994.1k |         139.7k |             117.0k |           119.8, 180.2, 252.8 |           33.2 |               24.2 |

**Not settled or short.**

- pg-redis chain-4 at 2x and 8x hit the warmup ceiling (12 chunks) in all three reps. Its Redis hit rate was still climbing, 72% → 84% at 8x and still gaining 0.3–0.4 points a chunk, while its throughput was flat in two of the three reps. The cells are measured but not settled.
- 2x chain-2 pg-redis has 2 reps. The third failed at start when Postgres's `memory.swap.max` still read `max`; the stack now re-reads its container limits for up to 5 s (`settledMemoryLimit`).
- F at 2x and 8x: Harper's read p99 is 25–35 ms against the stack's 10–12 ms, while its p50 is lower (0.7 against 1.6 ms). Each Harper window carried 45–48 RocksDB flushes and 15–21 compactions (3–5 GB written). Not investigated here.

**Conditions.**

- GCP us-central1-c, every set. Each target on its own `c4-standard-8-lssd` VM: 4 physical cores (SMT off) of an Intel Xeon 6985P-C (Granite Rapids), 30 GB, one local SSD. Every target runs under the 8 GiB cap. Topology (a): Fastify, Redis and Postgres share the stack's VM.
- One VM set per matrix set: a generator, a harper VM (harper-uws and harper take turns on it) and a stack VM. The six sets ran at the same time on 18 VMs.
- Generators: `c4-standard-32` for warm and `c4-standard-16` for 2x and 8x, Emerald Rapids, Node's sharded driver. Each set's own client-ceiling check picked its shard count (table below). Every cell stayed under half its generator's ceiling.
- `--auth=token`, 3 reps per cell, targets interleaved within each session (forward and reversed per rep), Harper's default record cache. Linux 7.0.0-1017-gcp, Node v26.13.1, Harper `f39c1a1831` (main), harness `da839bf`.
- Hardware events counted over each target VM's cpus (`--perf-scope=host`; see "Counting on a VM" under [Remote targets and GCP](#remote-targets-and-gcp---hosts-gcp)). An earlier run of this matrix counted per cgroup, and that counting slowed both targets, the stack more. Its ops/s, latencies and CPU µs/op are discarded. Its instructions/op agree with these within 4%, most cells within 2%. With host counting, every target's 2x and 8x measured windows averaged 99–101% of their own warmup chunks, where the stack's had run at 80–86%.
- **Turbo stays on, and VMs share physical hosts**, so a VM's speed varies by host and over time. Target VMs ran at 3.78–4.08 GHz, by cycles per target CPU-second. Across VM sets, unbiased warm-C ratios came out at 0.84 and 0.91, while instructions/op agreed within 2%. Read instructions/op as the host-independent cost, and ops/s ratios as ±10%.

<details><summary>Per set: zone, VMs, generator, shards, clock</summary>

| set        | zone          | target VMs                                                                                        | generator                                                               | target CPU                             | kernel         | Node     | target VM clock and IPC (medians)                   |
| ---------- | ------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------- | -------------- | -------- | --------------------------------------------------- |
| warm       | us-central1-c | harper c4-standard-8-lssd (Intel Granite Rapids), stack c4-standard-8-lssd (Intel Granite Rapids) | c4-standard-32 (Intel Emerald Rapids), 32 shards, ceiling 307,341 ops/s | Intel(R) Xeon(R) 6985P-C CPU @ 2.30GHz | 7.0.0-1017-gcp | v26.13.1 | harper 3.90 GHz, IPC 1.21, stack 3.90 GHz, IPC 1.53 |
| 2x         | us-central1-c | harper c4-standard-8-lssd (Intel Granite Rapids), stack c4-standard-8-lssd (Intel Granite Rapids) | c4-standard-16 (Intel Emerald Rapids), 16 shards, ceiling 218,431 ops/s | Intel(R) Xeon(R) 6985P-C CPU @ 2.30GHz | 7.0.0-1017-gcp | v26.13.1 | harper 3.89 GHz, IPC 1.04, stack 4.02 GHz, IPC 0.95 |
| 8x-cb      | us-central1-c | harper c4-standard-8-lssd (Intel Granite Rapids), stack c4-standard-8-lssd (Intel Granite Rapids) | c4-standard-16 (Intel Emerald Rapids), 8 shards, ceiling 238,428 ops/s  | Intel(R) Xeon(R) 6985P-C CPU @ 2.30GHz | 7.0.0-1017-gcp | v26.13.1 | harper 3.87 GHz, IPC 1.03, stack 4.04 GHz, IPC 0.86 |
| 8x-fi      | us-central1-c | harper c4-standard-8-lssd (Intel Granite Rapids), stack c4-standard-8-lssd (Intel Granite Rapids) | c4-standard-16 (Intel Emerald Rapids), 8 shards, ceiling 228,083 ops/s  | Intel(R) Xeon(R) 6985P-C CPU @ 2.30GHz | 7.0.0-1017-gcp | v26.13.1 | harper 4.08 GHz, IPC 0.84, stack 3.94 GHz, IPC 0.81 |
| 8x-chain12 | us-central1-c | harper c4-standard-8-lssd (Intel Granite Rapids), stack c4-standard-8-lssd (Intel Granite Rapids) | c4-standard-16 (Intel Emerald Rapids), 16 shards, ceiling 216,083 ops/s | Intel(R) Xeon(R) 6985P-C CPU @ 2.30GHz | 7.0.0-1017-gcp | v26.13.1 | harper 3.88 GHz, IPC 1.02, stack 3.78 GHz, IPC 0.95 |
| 8x-chain4  | us-central1-c | harper c4-standard-8-lssd (Intel Granite Rapids), stack c4-standard-8-lssd (Intel Granite Rapids) | c4-standard-16 (Intel Emerald Rapids), 16 shards, ceiling 221,789 ops/s | Intel(R) Xeon(R) 6985P-C CPU @ 2.30GHz | 7.0.0-1017-gcp | v26.13.1 | harper 3.88 GHz, IPC 1.02, stack 4.03 GHz, IPC 0.98 |

</details>

<details><summary>Every cell, warm</summary>

Median rep by ops/s; spread is (max − min) / median of the three reps; latency is the primary operation's (read, inspect or chain).

| workload | target     |  ops/s | spread | p50 ms | p99 ms | CPU µs/op | instructions/op | notes |
| -------- | ---------- | -----: | -----: | -----: | -----: | --------: | --------------: | ----- |
| C        | harper-uws | 76,589 |   6.3% |   0.55 |   3.74 |      48.5 |          230.4k |       |
| C        | harper     | 69,209 |  14.7% |   0.66 |   3.83 |      55.6 |          262.2k |       |
| C        | pg-redis   | 91,628 |   7.8% |   0.51 |   3.50 |      39.0 |          231.6k |       |
| B        | harper-uws | 59,734 |   1.6% |   0.72 |   3.97 |      61.6 |          262.7k |       |
| B        | harper     | 52,172 |   1.3% |   0.85 |   3.91 |      70.1 |          289.2k |       |
| B        | pg-redis   | 70,251 |   1.1% |   0.58 |   3.83 |      51.7 |          258.8k |       |
| inspect  | harper-uws | 74,441 |   8.6% |   0.57 |   3.86 |      48.4 |          236.7k |       |
| inspect  | harper     | 70,009 |  15.3% |   0.62 |   3.87 |      50.8 |          254.9k |       |
| inspect  | pg-redis   | 89,901 |  10.0% |   0.49 |   3.76 |      40.6 |          248.2k |       |
| chain-1  | harper-uws | 62,974 |   1.0% |   0.67 |   4.48 |      59.0 |          297.4k |       |
| chain-1  | harper     | 55,843 |  14.5% |   0.79 |   4.67 |      65.8 |          316.5k |       |
| chain-1  | pg-redis   | 60,658 |  13.0% |   0.72 |   5.61 |      59.4 |          352.5k |       |
| chain-2  | harper-uws | 53,478 |   7.4% |   0.77 |   4.71 |      66.8 |          335.9k |       |
| chain-2  | harper     | 51,884 |  16.7% |   0.86 |   5.14 |      72.9 |          358.2k |       |
| chain-2  | pg-redis   | 47,982 |  11.7% |   0.89 |   6.31 |      72.9 |          445.3k |       |
| chain-4  | harper-uws | 46,131 |   2.9% |   0.96 |   5.41 |      81.8 |          402.4k |       |
| chain-4  | harper     | 45,162 |   7.8% |   1.01 |   5.14 |      82.2 |          421.7k |       |
| chain-4  | pg-redis   | 33,305 |   5.4% |   1.32 |   8.52 |     101.5 |          630.1k |       |
| F        | harper-uws | 20,809 |   8.3% |   0.43 |   2.72 |     173.5 |          572.4k |       |
| F        | harper     | 18,972 |   1.7% |   0.51 |   2.86 |     196.0 |          612.8k |       |
| F        | pg-redis   | 23,761 |   2.3% |   0.95 |   5.10 |     154.7 |          587.4k |       |

</details>

<details><summary>Every cell, 2x</summary>

| workload | target     |  ops/s | spread | p50 ms | p99 ms | CPU µs/op | instructions/op | notes                     |
| -------- | ---------- | -----: | -----: | -----: | -----: | --------: | --------------: | ------------------------- |
| C        | harper-uws | 54,498 |   3.6% |   0.81 |   5.17 |      67.9 |          292.7k |                           |
| C        | harper     | 45,335 |   4.4% |   0.98 |   6.34 |      81.9 |          348.6k |                           |
| C        | pg-redis   | 36,801 |   0.9% |   1.31 |   6.74 |     105.4 |          399.7k |                           |
| B        | harper-uws | 41,884 |   4.0% |   1.11 |   6.25 |      88.0 |          336.3k |                           |
| B        | harper     | 35,475 |   1.2% |   1.32 |   7.33 |     104.5 |          391.9k |                           |
| B        | pg-redis   | 32,327 |   2.1% |   1.42 |   7.94 |     118.5 |          424.2k |                           |
| inspect  | harper-uws | 53,949 |   1.7% |   0.85 |   5.09 |      68.7 |          287.3k |                           |
| inspect  | harper     | 46,133 |   4.6% |   0.97 |   6.16 |      80.8 |          333.4k |                           |
| inspect  | pg-redis   | 37,056 |   1.1% |   1.27 |   6.61 |     104.2 |          407.0k |                           |
| chain-1  | harper-uws | 39,978 |   2.8% |   1.16 |   6.71 |      93.3 |          376.9k |                           |
| chain-1  | harper     | 35,254 |   1.6% |   1.24 |   7.61 |     105.3 |          421.3k |                           |
| chain-1  | pg-redis   | 25,730 |   2.1% |   1.89 |   9.43 |     150.1 |          584.5k |                           |
| chain-2  | harper-uws | 35,718 |   0.6% |   1.29 |   7.78 |     105.1 |          427.8k |                           |
| chain-2  | harper     | 31,241 |   3.1% |   1.45 |   8.73 |     120.1 |          478.8k |                           |
| chain-2  | pg-redis   | 20,506 |   7.2% |   2.31 |  12.15 |     185.7 |          720.1k | 2 reps; 1 failed at start |
| chain-4  | harper-uws | 29,935 |   0.9% |   1.41 |   9.19 |     123.5 |          512.9k |                           |
| chain-4  | harper     | 27,387 |   2.3% |   1.61 |  10.35 |     137.1 |          555.2k |                           |
| chain-4  | pg-redis   | 15,881 |  11.5% |   3.31 |  13.65 |     231.7 |          924.3k | 3/3 warmup-ceiling        |
| F        | harper-uws | 15,054 |   1.1% |   0.69 |  28.39 |     208.3 |          663.6k |                           |
| F        | harper     | 13,941 |   5.3% |   0.76 |  25.79 |     229.8 |          710.7k |                           |
| F        | pg-redis   | 14,369 |   2.4% |   1.56 |  10.18 |     240.2 |          803.7k |                           |

</details>

<details><summary>Every cell, 8x</summary>

| workload | target     |  ops/s | spread | p50 ms | p99 ms | CPU µs/op | instructions/op | notes              |
| -------- | ---------- | -----: | -----: | -----: | -----: | --------: | --------------: | ------------------ |
| C        | harper-uws | 52,959 |   0.5% |   0.91 |   5.14 |      69.3 |          301.0k |                    |
| C        | harper     | 44,811 |   8.3% |   1.00 |   6.30 |      83.0 |          358.4k |                    |
| C        | pg-redis   | 32,464 |   5.3% |   1.51 |   7.48 |     119.8 |          435.4k |                    |
| B        | harper-uws | 41,046 |   3.1% |   1.16 |   6.52 |      88.5 |          352.0k |                    |
| B        | harper     | 34,616 |   3.9% |   1.31 |   7.96 |     105.5 |          421.6k |                    |
| B        | pg-redis   | 29,566 |   2.6% |   1.65 |   8.55 |     131.0 |          457.4k |                    |
| inspect  | harper-uws | 55,940 |   1.4% |   0.88 |   4.83 |      66.6 |          293.6k |                    |
| inspect  | harper     | 48,138 |   4.9% |   0.95 |   5.88 |      77.8 |          342.3k |                    |
| inspect  | pg-redis   | 34,119 |   2.3% |   1.48 |   7.00 |     114.3 |          438.7k |                    |
| chain-1  | harper-uws | 37,815 |   1.4% |   1.24 |   6.64 |      96.9 |          384.8k |                    |
| chain-1  | harper     | 33,943 |   1.5% |   1.33 |   7.64 |     109.2 |          433.3k |                    |
| chain-1  | pg-redis   | 21,531 |   0.7% |   2.29 |  10.80 |     180.2 |          643.0k |                    |
| chain-2  | harper-uws | 32,056 |   0.9% |   1.39 |   8.05 |     112.7 |          449.6k |                    |
| chain-2  | harper     | 29,494 |   1.5% |   1.50 |   9.06 |     126.1 |          496.4k |                    |
| chain-2  | pg-redis   | 18,157 |   2.7% |   2.77 |  12.80 |     212.2 |          775.0k |                    |
| chain-4  | harper-uws | 27,969 |   1.9% |   1.46 |  10.20 |     130.7 |          524.5k |                    |
| chain-4  | harper     | 25,909 |   7.8% |   1.62 |  10.91 |     144.5 |          572.5k |                    |
| chain-4  | pg-redis   | 14,843 |   5.4% |   3.49 |  14.97 |     252.8 |          994.1k | 3/3 warmup-ceiling |
| F        | harper-uws | 15,322 |   4.0% |   0.70 |  32.35 |     198.2 |          680.7k |                    |
| F        | harper     | 14,111 |   3.3% |   0.77 |  32.37 |     220.9 |          736.3k |                    |
| F        | pg-redis   | 13,279 |   1.0% |   1.79 |  11.92 |     260.3 |          842.3k |                    |

</details>

Reproduce (from the operator's host, with a service account active in its own gcloud directory):

```sh
CLOUDSDK_CONFIG=<dir> YCSB_GCP_PROJECT=<project> YCSB_GCP_ZONES="us-central1-c us-central1-a us-central1-b us-central1-f" \
  systemd-run --user --unit=ycsb-matrix benchmarks/ycsb-vs-pg/gcp/run-matrix.sh --all
node benchmarks/ycsb-vs-pg/gcp/matrix-report.mts --base=<the matrix base>
node benchmarks/ycsb-vs-pg/profile-report.mts gcp/runs/<base>-warm/results/<the profile phase's file> --summary --pipeline
```

## Running

```sh
npm run build                     # dist/bin/harper.js, which the harper target spawns
npm ci --prefix benchmarks/ycsb-vs-pg/pg-app   # Fastify, pg, ioredis for the conventional stack
docker --version                  # postgres + redis run via docker compose
node benchmarks/ycsb-vs-pg/run-compare.mts --scale=standard
node benchmarks/ycsb-vs-pg/run-compare.mts --scale=quick --workloads=C,A --targets=harper,pg-redis
node benchmarks/ycsb-vs-pg/memory-sweep.mts --ratios=0.5,2,8   # dataset larger than memory, below
```

User systemd (`systemd-run --user`, memory controller delegated to the user manager)
is required: every host process runs in its own capped scope.

All `benchmarks/ycsb` flags apply, plus:

| Flag                           | Default           | Meaning                                                                                                     |
| ------------------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------- |
| `--targets`                    | `harper,pg-redis` | Targets to compare (table above)                                                                            |
| `--harper-memory`              | `capped`          | `capped` (8 GiB cgroup) or `measured` (no cap)                                                              |
| `--target-cpus=K`              | `4`               | Size of the CPU set every target runs on                                                                    |
| `--serverCpus`, `--driverCpus` | derived           | Explicit CPU lists instead of `--target-cpus`                                                               |
| `--cache`                      | `warm`            | `warm` or `cold` (below)                                                                                    |
| `--base-harper`                | —                 | `dist/bin/harper.js` of the build `harper-base` runs                                                        |
| `--shards`                     | generator CPUs    | Load-generator processes: one per generator CPU, at most `--concurrency` (below)                            |
| `--reps`                       | `1`               | Independent samples per target × workload                                                                   |
| `--perf-counters`              | off               | `perf stat` per component over each measured run                                                            |
| `--profile=<dir>`              | off               | Counters, then a sampled profile window (below)                                                             |
| `--profile-ops`                | `1000000`         | Ops in each of the two profile windows                                                                      |
| `--auth`                       | `none`            | `none` or `token` (below); recorded in every row                                                            |
| `--host-quiet-cores=N`         | off               | Before each sample, wait for the rest of the host to use < N cores; refuses a shared cgroup, like the sweep |
| `--host-quiet-max-min`         | `20`              | Longest that wait, in minutes                                                                               |
| `--hosts=<file>`               | off               | Remote-target mode: targets on other hosts, this host only generates load (below)                           |

`--threads` (Harper's worker threads and the Fastify cluster size) defaults to K.
Results land in `benchmarks/ycsb-vs-pg/results/`, written after every sample, with
a printed table at the end. Runtime scales with reps × workloads × targets: every
sample starts a fresh server and reloads the dataset.

### Load generator

`shardedDriver.mts` keeps `--concurrency` requests in flight from `--shards` Node processes, each with its
own `KeyState` and REST client. Every key, op, record and link comes from `../ycsb/workload.mts`, and
`--shards` defaults to one process per generator CPU (at most `--concurrency`). A measured window opens
as the shards start a phase's requests and closes as they finish, and the shards' CPU over it is the
row's generator CPU.

**Shards matter.** Measured on the XPS (i7-12700H) at turbo off, with the generator on 8 CPUs (two
P-cores with their SMT siblings, plus four E-cores), 64 requests in flight and `--auth=token`, 2 runs each:

| shards |         client-ceiling C | harper-uws warm C | pg-redis warm C |
| ------ | -----------------------: | ----------------: | --------------: |
| 4      | 56k ops/s, 3.7 CPUs busy |               50k |             49k |
| 8      | 66k ops/s, 6.7 CPUs busy |               59k |             52k |

Four shards, the old default, held harper-uws on 4 target cores below what it serves, and moved the
warm-C harper-uws/pg-redis ratio from 1.13 to about 1.02. Rows recorded with 4 shards (`meta.shards`)
understate Harper on read-only workloads. Run `client-ceiling.mts` on the generator's CPUs before trusting
a cell that comes within reach of its ceiling.

## Method

- **Equal CPU budget.** Each target, as a whole, runs on the same K CPUs:
  the Harper process, or the Fastify cluster plus the Postgres and Redis
  containers together (compose `cpuset`, no per-service quota — the stack
  picks its own split). The K CPUs are one logical CPU on each of K physical
  cores from the fastest core class (so the machine needs more than K physical
  cores); their SMT siblings stay idle. The load
  generator and the harness run on every CPU of the remaining physical cores.
  Affinity is set when each process is created (a `taskset` wrapper for Harper,
  `taskset -c` for Fastify, compose `cpuset` for containers) and every thread is
  checked before measuring; a sample with a thread outside its set fails.
- **Equal memory budget, enforced.** 8 GiB per target, every target. Every component runs in its
  own memory cgroup with a hard cap and swap off: Harper in a user systemd scope
  capped at 8 GiB, the Fastify cluster in one capped at 1 GiB, Postgres and Redis
  under compose `mem_limit` with `memswap_limit` equal to it. run-compare's stack
  splits are `pg-redis` = Fastify 1 GiB + Postgres 6 GiB (`shared_buffers=4GB`) +
  Redis 1 GiB (`maxmemory 768mb`), and `pg-only` = Fastify 1 GiB + Postgres 7 GiB
  (its idle Redis container is not charged). Each cap, swap limit and ancestor limit is checked before a
  sample runs. Harper sizes its RocksDB block cache and worker heaps from the
  cgroup limit, as it would in an 8 GiB container. (One cgroup spanning host
  processes and containers would need root; one per process does not.)
  `--harper-memory=measured` lifts Harper's cap for comparison runs (its ancestor
  cgroups must still allow 8 GiB); such results are not equal-memory.
- **Memory is what the cgroup is charged**, the same way for every component:
  anonymous memory plus page cache (a file page is charged to the cgroup that first
  touches it) plus shared memory (`shared_buffers`). Each sample reports the 2 s
  peak and mean over the measured window, the anon/file split at its end, the
  lifetime peak, and OOM-kill events; an OOM kill invalidates the sample. Results
  before methodology v2 summed PSS for host processes, which omits page cache.
- **Headline is throughput at equal cores.** CPU µs/op (server CPU only), peak
  memory, Redis hit rate and p50/p99 of the primary operation sit beside it.
- **Cache state is set, not inherited.** After the load, a pass reads every key
  once. `--cache=warm` then requires the Redis hit rate over the measured run to
  be ≥ 99% (the sample fails otherwise) and records it; run `harper` and
  `harper-sized` to see Harper with the stock and a dataset-sized record cache.
  `--cache=cold` refuses `pg-redis` (cold Postgres is `pg-only`) and runs
  `harper` with `storage.recordCacheSize: 4`. That is reduced retention, not a
  true cold: the record cache cannot be disabled, and entries beyond the strong
  set stay reachable on WeakRefs until GC. Both "cold" engines still read from
  memory (RocksDB block cache, `shared_buffers`) when the dataset fits.
- **Postgres is vacuumed after the load.** `VACUUM (ANALYZE)` sets hint bits and
  planner statistics before measuring, as an operator would after a bulk load,
  and keeps an autovacuum triggered by the load out of the measured run.
- **Interleaved reps.** Reps are the outer loop: every (rep, workload, target)
  is a fresh server, dataset and read-all pass, then one measured run. Target
  order is forward on even reps and reversed on odd ones; each sample records
  its position. The table reports the median rep by throughput.

## How the conventional stack is built

`pg-app/server.mjs` is what a competent team would write, not a strawman:

- Fastify 5, one process per `--threads` with `SO_REUSEPORT` (kernel-balanced,
  no primary-process hop) — structurally the closest match to Harper's threads.
- `pg` with a connection pool and **named prepared statements**, so Postgres
  skips parse/plan on every request.
- `ioredis` with auto-pipelining. Reads are cache-aside; writes are
  write-through (upsert the row, then replace the cache line), which maximizes
  hit rate on the read-heavy workloads.
- Scans (`workload E`) bypass Redis, as they must — a range query can't be
  served from a key-value cache.

## Fairness notes

- **Same storage medium, and it is a real disk.** Both engines write under
  `YCSB_VS_PG_DATA_DIR` (default `benchmarks/ycsb-vs-pg/data`), and the runner
  refuses to start if that path is tmpfs or if the two data directories land on
  different devices. This is load-bearing: on tmpfs an `fsync` is a no-op, so
  Postgres would get `synchronous_commit=on` for free while Harper still paid
  real RocksDB compaction, quietly tilting every write-bearing workload.
- **Same durability setting.** Postgres keeps `fsync=on` /
  `synchronous_commit=on`, matching Harper's default `storage.writeAsync=false`.
- **Postgres is tuned, Harper is not.** `shared_buffers` and
  `effective_cache_size` are sized to the container's share — the stock 128 MB
  would make it a page-fault benchmark. Harper runs stock apart from
  `threads.count` and log level.
- **Identical response bodies.** The Fastify handler selects `id` alongside the
  fields so both targets return the same JSON keys and roughly the same bytes.
- **Every sample gets its own freshly started server, dataset and read-all pass.**
  This is the expensive option and it is load-bearing. Sharing one instance across workloads let each one inherit
  the last one's state — the record cache left resident by a preceding read
  sweep, the compaction backlog left by a preceding write burst — and the
  distortion was big enough to invert rankings: a 95%-read workload measured
  _slower_ than a 50%-write one, and a 100%-read workload measured 2.5x slower
  than the 95%-read workload that followed it.
- **The read-all pass touches every key through the target's own read path** —
  Redis for `pg-redis`, Postgres for `pg-only`, the record cache and RocksDB for
  Harper — so first-touch costs land before the measured run.
- **Everything is on one host**, including the load generator (unless `--hosts`, below). Run
  `client-ceiling.mts` to confirm the reported numbers are server-bound rather
  than client-bound:

  ```sh
  node benchmarks/ycsb-vs-pg/client-ceiling.mts --target-cpus=4 --concurrency=64
  ```

  It serves a fixed in-memory record from a `node:http` cluster on the target
  CPUs and drives it with the same sharded driver on the same generator CPUs,
  for workload C (all shards) and E (one shard, since it inserts). Every route
  returns one ~1 KB record, so it bounds the generator's request rate, not the
  cost of receiving E's multi-record scan bodies. Each line reports the shards'
  busy cores; `--max-generator-busy=<fraction>` exits 1 when C kept more than
  that share of the driver's capacity busy (one core per shard, at most one per CPU).

## Authentication (`--auth`)

`--auth=none` (the default) is what every earlier row measured: Harper serves loopback
requests as its fixed local-trust principal, and the Fastify app checks nothing.

`--auth=token` makes both sides verify a bearer credential on every request, and the
generator sends the same `Authorization: Bearer <token>` header to both:

- **Harper** runs with `authentication.authorizeLocal: false`. After start the harness creates
  a role that is not `super_user` and can only read, insert and update the benchmark table
  (no delete, no other table; B's updates need the write grant), a user in it, and that user's
  operation token from `create_authentication_tokens`: a JWT signed RS256 (`jsonwebtoken`).
  Harper verifies a token once and caches the header → user mapping per thread
  (`authorizationCache`, cleared every `authentication.cacheTTL`, 30 s); each request then pays
  the cache lookup, an expiry and current-user check, a copy of the user view, and the
  role-permission checks on the table.
- **Fastify** registers `@fastify/jwt` (fast-jwt) with a per-session random secret and
  verifies the HS256 signature in an `onRequest` hook on every request, with the plugin's
  default of no verified-token cache. The harness mints the token.

Before loading, each target must answer a request without the header with 401 or 403, and
the same request with it, or the sample fails.

The `inspect` caller is the verified principal: the harness adds 20 Harper users `owner00`..`owner19`
(same role) with their own operation tokens, and mints 20 HS256 tokens with those subjects for
Fastify; an inspect request carries its caller's token. Under `--auth=none` both sides take the
caller from an `x-caller` header instead.

## Dependent reads: `inspect`, `chain-N`, `F`

The read workloads above return a record as stored, the stack's best case: Fastify sends Redis's
JSON bytes without parsing them. These workloads make the application read a record before it can
answer, with the same code on both sides (`../ycsb/app/dependentReads.mjs`; Harper's
`../ycsb/app/resources.js` and the Fastify routes differ only in how they fetch a record):

- **`inspect`**: read the record, answer 403 unless the caller owns it (one request in 20 comes
  from another owner), otherwise a projection of four fields.
- **`chain-N`** (N = 1, 2, 4): read the record, take the next key from its `field0`, read that,
  N times; one response with a projection of all N + 1 records. Each read waits for the one
  before. Harper reads through `tables.usertable.get` inside the request's transaction; Fastify
  reads each record cache-aside (Redis `GET` and `JSON.parse`; a miss reads Postgres and fills
  Redis, as the read route does).
- **`F`**: YCSB F as defined, a client-side `GET` then `PUT` of the record (non-atomic).

The link graph is the same on every target and rep (see `../ycsb/README.md`). Every workload's
records carry the link now, C and B included; rows measured before 2026-11-01 had a random `field0`
of the same length. Before measuring an
`inspect` or `chain` sample, the harness checks the target: three chains of 4 hops must match the
links computed independently, inspect must answer the owner with the projection and another owner
with 403, a record without a link must answer 500 and leave the server serving, and under
`--auth=token` neither route may answer an anonymous request.

Harper's chain reads share one snapshot (the request's transaction); the stack's are independent
reads. These workloads do not write, so both return the same data.

What this does and does not claim. Reads that do not depend on each other could be batched
(pipelining, `MGET`), and a stack designer could denormalize or cache the composed response; those
are outside these workloads. The claim is about reads that depend on each other and on record
contents.

## Dataset larger than memory (`memory-sweep.mts`)

A Redis holding the whole dataset is the cache-aside stack's upper bound. The sweep
lets the hit rate come out of memory instead: same 4 cores and 8 GiB per target,
dataset sized as a multiple of the budget (`--ratios`, logical payload of the
10 × 100 B records), zipfian reads, workloads C and B.

- **Stack split, chosen once:** `pg-redis` = Fastify 1 GiB + Redis 3.5 GiB
  (`maxmemory 3gb`) + Postgres 3.5 GiB (`shared_buffers=1GB`); `pg-only` = Fastify
  1 GiB + Postgres 7 GiB (`shared_buffers=2GB`). Harper: one 8 GiB cgroup.
- **One load per engine and size, restored per sample.** A capped `harper` and a
  `pg-only` each load the dataset over REST, then quiesce (CPU under 0.1 core for
  5 s), shut down cleanly and keep the data directory as a snapshot. Every
  (target, workload) sample copies that snapshot into a fresh data directory
  from inside its own cgroup, before the server starts — in Harper's launch
  wrapper, in Postgres' container entrypoint — so the copy's page cache is
  charged to the sample, not to a copier outside the budget. All targets of a
  size read byte-identical, compacted data. Redis starts empty.
- **Warmup to a plateau, then one measured run.** Chunks of 1M record reads
  (`--warmup-chunk`; a `chain-4` chunk is 200k ops) of the workload's own zipfian
  mix until the last three agree (throughput within 5%, and for `pg-redis` the
  Redis hit rate within 0.5 points), up to `--warmup-max-chunks`. A sample that
  hits the ceiling is reported with `!` and is not a settled result. The measured
  run is 1M record reads too. B's is bounded, not a write steady state; Postgres
  checkpoints in the window are recorded.
- **No hit-rate gate.** The Redis hit rate per sample is the output. Harper's
  record-cache hit rate needs a temporary probe in `dist/` (see the tuned-cache section).
- **A failed sample** (errors, OOM kill, crash) is recorded with its phase and the
  session continues — unless its scopes or containers are still running, in which
  case the session stops. `--sized-ratios` limits the sized targets to some sizes.
- **Harper is always capped here.** `--harper-memory=measured` is refused unless
  `--allow-uncapped` is also given, and then every row carries `allowUncapped`.
  A restored target still busy when the 10-minute quiesce wait ends is measured but
  marked `status: quiesce-timeout` and `settled: false`; warmup without a plateau is
  `warmup-ceiling`, a snapshot that never went quiet `snapshot-not-quiet`, and a run
  whose noisy-host retries ran out `host-busy`.
- **Reruns and a shared host.** `--cells=0.5:B:harper-uws,8:B:pg-redis` runs exactly
  those samples, `--reps` times each. Before every sample the run waits (up to
  `--host-quiet-max-min`, 20) until the rest of the host has used under
  `--host-quiet-cores` (1) over 30 s: host busy time from `/proc/stat` minus this
  run's own cgroup and the target's. Run it under
  `bench-run`, which gives it a cgroup of its own: from a login or tmux session, that
  cgroup also holds whatever else the session started, and the gate would not see it.
  The sweep refuses to start when its cgroup holds any process that is not its own
  ancestor or descendant (a `| tee` in the same scope counts), unless
  `--allow-shared-cgroup` is given, and then every row carries `sharedCgroup`; a row
  also carries it when a process joined the cgroup by the start or end of its sample. Load that arrives mid-run is caught after it:
  a measured run with the rest of the host over the threshold is measured again on
  the warm target, up to `--noisy-retries` (2) times, and the discarded runs stay in
  the row (`noisyWindows`, `hostQuiet`). Harper rows also record RocksDB flushes and
  compactions per phase, from the info LOG.

## A Redis-sized record cache (`harper-uws-rc3g-*`)

Harper's record cache is per worker thread and sized in entries (`storage.recordCacheSize`,
default 32,768 ring positions, about 13k records at ~1 KiB). The tuned targets give it the
share Redis gets in the sweep, 3 GiB, and stay inside the same 8 GiB cap and 4 cores. Each
target's settings are in its `TARGETS` descriptor, and every row records what it launched
with (`measured.harperSettings`; `meta.harperSettings` per target):

|                                                           |     `-rc3g-4t` |     `-rc3g-2t` |          stock |
| --------------------------------------------------------- | -------------: | -------------: | -------------: |
| `threads.count`                                           |              4 |              2 |              4 |
| `storage.recordCacheSize` (2 positions per ~1 KiB record) |        820,000 |      1,640,000 |         32,768 |
| records held strongly per thread                          | 410k (768 MiB) | 820k (1.5 GiB) |           ~13k |
| `threads.maxHeapMemory` (MB)                              |           1152 |           2240 |  744 (derived) |
| `storage.rocks.blockCacheSize`                            |        512 MiB |        512 MiB |    2 GiB (25%) |
| verification table slots                                  |            16M |            16M | 512K (derived) |

- A cached record costs 1,965 heap bytes (measured; [PROFILE.md](PROFILE.md) has the method).
- A cache hit is cheap only when rocksdb-js's verification table still vouches for the cached
  version. That table is process-wide, direct-mapped and overwritten by every cold read. Harper
  sizes it from `storage.recordCacheSize` and its thread count (512K slots for the stock cache on
  4 threads). A target that pins it instead loads `vtPreload.mjs` with
  `--import` into Harper's main thread, which sets the size before Harper opens a database and
  drops Harper's own request.
- The controls separate the causes: `-vt128k` is B without the larger table, `harper-uws-vt16m`
  is the stock cache with it, and `harper-uws-2t` is the stock cache on 2 threads.
- `--cache=cold` refuses the tuned targets.
- Rows also record each component's page-cache refaults during the measured run
  (`refaultFilePages`, from `memory.stat`): file pages read again after the cgroup evicted
  them, the reads that went to disk.
- The record-cache counts in [PROFILE.md](PROFILE.md) come from a temporary probe patched
  into `dist/` for those runs, never committed. `meta.harper.digests` holds the SHA-256 of the
  two files such probes patch, so a results file says whether its build was instrumented.

## Remote targets and GCP (`--hosts`, `gcp/`)

Single-host mode shares one machine between the target and the load generator. With `--hosts=<file>`,
`run-compare.mts`, `memory-sweep.mts` and their flags work the same way, but this host only runs the
orchestrator and the load generator. Each target host runs a target agent (`targetAgent.mts`, started
over `ssh <host> -- node ...`). The agent launches its part with the single-host code: the same capped
scopes, compose cpusets, restore inside the sample's cgroup, credentials and teardown. It takes that
part's readings on its host: cgroup CPU and memory, perf counters and records, thread affinity, and
the host-quiet gate. Nothing crosses the network while a window runs except the load: each host's
readings for a window are taken in one call before it and one after it. The hosts file names a host
for each role:

```json
{
	"repoDir": "/opt/ycsb/harper",
	"roles": {
		"harper": {
			"ssh": "ycsb@10.77.0.3",
			"address": "10.77.0.3",
			"dataDir": "/mnt/ycsb/data",
			"requireMount": "/mnt/ycsb"
		},
		"stack": { "ssh": "ycsb@10.77.0.4", "address": "10.77.0.4" },
		"redis": { "ssh": "ycsb@10.77.0.5", "address": "10.77.0.5" },
		"postgres": { "ssh": "ycsb@10.77.0.6", "address": "10.77.0.6" }
	}
}
```

`address` is where the target listens and other hosts reach it. Without it, the host keeps
single-host loopback addresses, which is how the local validation runs both "hosts" on one
machine (`"ssh": "localhost"`, or `"command": ["node", "benchmarks/ycsb-vs-pg/targetAgent.mts"]`
without sshd, plus `serverCpus` and `--driverCpus` to pin as single-host mode does). On a host with
exactly `--target-cpus` physical cores, the target gets all of them and the agent shares them. Each
row then records the agent's own CPU (`agentCores`) apart from the target's and the rest of the
host's. Remote mode needs `--auth=token` for Harper on a non-loopback address: local trust covers
loopback peers only. It counts perf events unless given `--no-perf-counters`, since instructions/op is
the stable metric where turbo stays on, and counts each target host's cpus as a whole rather than each
component's cgroup (`--perf-scope=host`, below). Rows add `perfClockGHz` (cycles over CPU-seconds) under
per-cgroup counting only. Run remote mode on a network of its own, as `gcp/` does: Harper's operations API listens on the bound address too, with the test helper's fixed admin password until the harness replaces it moments after startup, and topology b's Postgres keeps its fixed benchmark credential.

**Counting on a VM (`--perf-scope`).** `perf stat --for-each-cgroup` switches a cgroup's events out and in
whenever a cpu moves between cgroups, and on a GCP VM's virtual PMU every counter write traps to the
hypervisor. That slows the counted target. It slows the stack most, since every request moves between
Fastify, Redis and Postgres; Harper's work stays in one cgroup. Counting the target cpus whole programs
each counter once. Measured on c4-standard-8-lssd targets, 2026-11-13: warm, `--auth=token`, 3 rounds per
mode in a Latin-square order, medians in ops/s:

| cell               | per cgroup | host cpus (`host`) | no counters | per cgroup vs none | host vs none |
| ------------------ | ---------: | -----------------: | ----------: | -----------------: | -----------: |
| harper-uws C       |     85,428 |             88,989 |      88,369 |              −3.3% |        +0.7% |
| pg-redis C         |     90,548 |             98,326 |      97,210 |              −6.9% |        +1.1% |
| harper-uws chain-4 |     46,368 |             50,750 |      51,165 |              −9.4% |        −0.8% |
| pg-redis chain-4   |     29,854 |             33,108 |      33,287 |             −10.3% |        −0.5% |

Instructions/op were the same in every mode. The trap's cost does not run guest instructions, so instruction
counts from either mode compare. At 2x and 8x, where Postgres reads from disk, the stack's measured windows
under per-cgroup counting ran at 80–86% of its own warmup chunks (which count nothing), against 94–101% for
Harper. Remote sessions therefore default to `host`. Its counts cover everything on the target cpus: the
target, its agent, and kernel work outside the target's cgroups (I/O completion, network softirqs); in the
A/B that came to about 1% more instructions/op. Single-host sessions keep per-cgroup counting
(`cgroups`), the only way to split one host's CPU between components. A profile's counters-only window still
counts per cgroup for its per-component instructions, so read that window's CPU µs/op as inflated.

**Topologies.** A target name alone is topology (a). A name with `@b` (stack targets only) is
topology (b). One session can interleave both: `--targets=harper-uws,pg-redis,pg-redis@b`.

- **(a) co-located, the publishable one.** Each target gets its own target VM of the same shape.
  Harper runs alone on its VM; Fastify, Redis and Postgres share theirs. The rules are the ones
  above: 4 cores and 8 GiB per target, and the stack's per-component split (memory-sweep: Fastify
  1 GiB, Redis 3.5 GiB with `maxmemory 3gb`, Postgres 3.5 GiB). The stack's hops stay on loopback.
- **(b) separate hosts.** Fastify runs on the stack VM; Redis and Postgres each run on a VM of the
  same shape in the same zone and placement group, with the same per-component memory caps.
  Every (b) row carries `topology: "b"`, a `note` saying what it is, and `rtt`: TCP ping-pong
  p50/p99 from Fastify's host to Redis's and Postgres's, before each sample. Session meta holds
  the same at session start, the generator's round trip to every host, and the probe's
  loopback floor.

What (b) does and does not claim. It measures a common production layout: a cache-aside app whose
cache and database are network services. It gives the stack three VMs, so 3x the cores of (a),
on purpose. Its numbers are therefore a deployment comparison, not an equal-budget one, and the
(b)/(a) ratio is not the cost of the network hops alone: hops and cores change together. Per-component
CPU in each row shows whether the stack was CPU-bound in (a). Attributing a gap to the hops alone would
need a matched-resource variant, for example (b) with its components pinned to 4 cores in total, which
this harness does not run.

**GCP.** The `gcp/` scripts provision a run with the gcloud CLI. The project comes from
`YCSB_GCP_PROJECT`; zone, shapes and limits are in `gcp/config.sh`.

- `provision.sh --run-id=<id> --topology=a|ab [--commit=<sha>]` creates a network of its own
  (internal traffic between the run's VMs, SSH only from this host's address), one compact
  placement policy, and VMs `generator`, `harper`, `stack` (plus `redis` and `postgres` for ab).
  Every VM is labeled `ycsb-bench=true,ycsb-run=<id>,ycsb-role=<role>` and created with
  `--max-run-duration` (12 h) and `--instance-termination-action=DELETE`, so GCE deletes it even if no script
  ever runs again. A failure part way tears the run down. `--dry-run` prints the gcloud commands.
- `startup.sh` (the VMs' startup script) mounts the local SSD at `/mnt/ycsb`, installs Docker, the
  latest Node of CI's major, perf for the running kernel and git. It sets up user `ycsb` (docker, user
  systemd with the memory controller delegated, linger), checks out the harness at the run's commit and
  builds what the role runs.
- `teardown.sh <id>` deletes the run's VMs by label, then its placement policy, firewall rules,
  subnet, network and disks by name (none of those take labels). It fails unless none is left.
  `teardown.sh --all --yes` does the same for every run.
- `run-estimate.sh` is the short estimate. It provisions both topologies, checks the generator's
  ceiling over the VPC (`client-ceiling.mts --serve` on the harper VM, `--base-url` from the generator)
  at one shard per generator vCPU and at half that. The measured cells take whichever served more on C
  among runs without request errors (half the shards only when more than 5% faster), and nothing is measured
  if that is under `YCSB_MIN_CEILING_OPS` (150k; the fastest cells, warm C, serve about 90k). Busy cores do
  not decide: against a server faster than the driver, one shard per vCPU always reads as saturated. It then
  runs a smoke pass, then harper-uws, pg-redis and pg-redis@b on C, inspect and chain-4, warm and 2x,
  `--auth=token`, 3 reps. Results come back to `gcp/runs/<id>/results/` (phase logs to `logs/`) after every phase. Teardown
  runs on exit, after one last copy. Teardown needs a working gcloud session: when it fails, GCE still
  deletes the VMs at `--max-run-duration`, and `teardown.sh <id>` removes the network, firewall rules and
  placement policy.
- `run-matrix.sh` is the full matrix, topology (a): harper-uws, harper and pg-redis on C, B, inspect,
  chain-1, chain-2, chain-4 and F, at warm, 2x and 8x, `--auth=token`, 3 reps, targets interleaved. One
  VM set in sequence would take about a day, so it runs six sets in parallel (`--plan` lists them), each
  one session on its own generator, harper and stack VMs: warm (then perf profiles of warm C and chain-4
  for harper-uws and pg-redis), 2x, and 8x split four ways by workload. The 8x split is for time: every
  8x sample restores a 138 GiB Harper snapshot at local-SSD write speed (330 MiB/s documented, about
  7 minutes). Each set loads each engine's dataset once and restores it for every sample, checks its
  generator's ceiling, and runs a smoke pass of its own phases first. `--all` starts every set and waits;
  `--set=<set>` runs one. `--resume` picks a set up after its orchestrator died without tearing down: it
  provisions nothing, and phases that already ended on the generator are read, not run again. Every set of
  an `--all` matrix builds the commit HEAD was at when the matrix started (`runs/<base>.commit`), and waits up
  to 8 hours for zone capacity (`YCSB_CAPACITY_WAIT_MIN`). Run the orchestrator under `systemd-run --user`,
  since any exit it sees tears its run down.
- **SSH.** Every script reaches the VMs with plain ssh, never `gcloud compute ssh`. The startup script
  publishes each VM's ed25519 host key as a guest attribute; `provision.sh` reads it through the API and
  pins it in `runs/<id>/known_hosts` (and the targets' keys on the generator, for the agents' ssh). Nothing
  reads `~/.ssh`, so a resumed session in a fresh `$HOME` still verifies every host, and polls and copies
  keep working if the operator's gcloud session expires mid-run.
- **Zones.** `YCSB_GCP_ZONES` (space-separated, one region) is tried in order: a zone without capacity
  for the run's shapes gets that run's VMs deleted and the next zone tried. When none has capacity, the
  list is tried again every `YCSB_CAPACITY_RETRY_S` (600) until `YCSB_CAPACITY_WAIT_MIN` minutes have
  passed (0 for `provision.sh` alone, 480 under `run-matrix.sh`). The zone a run got is in
  `runs/<id>/zone` and its manifest.

Choices, recorded per run in `gcp/runs/<id>/manifest.json` and in every results file (`meta.remote`):

- **Target VM: `c4-standard-8-lssd`, `--threads-per-core=1`, `--performance-monitoring-unit=architectural`.**
  That is 4 physical cores with SMT off, 30 GB and one 375 GiB Titanium local SSD. C4 is the series
  that exposes a PMU to a VM of this size (C3 VMs have none), and instructions/op needs one. On a
  4-core VM, the kernel's network work for the target's traffic (gVNIC interrupts, softirq) lands
  on the target's own cores, as in a real 4-core deployment.
- **Data disk: local SSD on every VM.** The shape fixes it, so identical VMs get identical disks with
  nothing to provision. It is local NVMe, like the XPS where every earlier row was measured. Unlike a
  network disk, it adds no network round trip to each page-cache miss, which would mix a disk-latency
  term into the dependent-read chains the 2x and 8x points measure. 375 GiB holds 8x on per-engine VMs
  (Harper 138 GiB snapshot plus its restored copy). Documented limits: 150k read IOPS, 625 MiB/s read. When that shape is out of capacity, `YCSB_DATA_DISK_KIND=hyperdisk` gives every target-shaped VM the plain `c4-standard-8` and one Hyperdisk Balanced volume with fixed provisioned IOPS and throughput (`YCSB_HYPERDISK_IOPS`, 25,000, and `YCSB_HYPERDISK_MIBPS`, 480: the VM's steady-state limit, so no burst credit varies the results). That adds a network round trip to each page-cache miss, so results record the kind (`dataDisk`).
- **Generator: `c4-standard-32`** (16 cores, SMT on). The sharded driver spent 70–100 µs of CPU per op on
  the XPS (above), so a 4-core target serving 60–80k ops/s needs up to about 8 of its cores. The ceiling
  check is the gate; `YCSB_GEN_MACHINE_TYPE` changes the shape. No VM gets a
  service account: none calls a GCP API, and the guest attributes go through the metadata server.
- **Turbo stays on** (GCP has no control for it). Targets interleave within a session, forward and
  reversed per rep, 3 reps per cell, and perf counts the cycles each window ran.
- Every results file records each host's machine type, zone and CPU platform (GCP metadata
  server), CPU model, kernel, Node version, target and agent cpus, and data-dir mount. It also
  records the measured round trips.

## Profiling (`--profile`)

`--profile=<dir>` starts every target with V8's perf-map flags and, after each
measured run, runs `--profile-ops` more under `perf stat` alone (steady-state counters:
the measured run can still carry JIT warmup) and then `--profile-ops` more under
`perf record` on the target cores, folded per component into `<dir>`.
`profile-report.mts <results.json> --svg-dir=<dir>` turns those into CPU µs/op per
bucket (HTTP, routing, auth, transactions, record cache, RocksDB, decode, JSON, the
stack's Redis and Postgres, event loop, GC, JIT), RocksDB sub-parts, Harper's
pipeline by inclusive cost, counters, GC by phase (scavenge, major marking, clearing weak
references, compaction, sweeping), and flame graphs. `--pipeline` adds Harper's samples
by request-pipeline layer (uWS, `http.ts`, authentication, REST, transaction, resource
resolution, `Table.get`, record cache, RocksDB, decode, serialization), each charged to the
innermost layer on its stack: work resumed after an `await` has lost its callers' frames, so
a layer's cost "with inner layers" is a sum down the chain, not stack containment. Needs
`kernel.perf_event_paranoid <= 0`. [PROFILE.md](PROFILE.md) holds the results.
