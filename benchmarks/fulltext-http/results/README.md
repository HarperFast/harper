# Local qualification observations

Status: measurements in progress. These observations do not close the catalog-scale release gate.

The runtime is [414b4ff](https://github.com/HarperFast/harper/commit/414b4ff9866556cc450ca32482c9b42ce929303e). No production code changed for these runs. Raw JSON is gzip-compressed without changing its contents. The host is an Apple M4 Pro with 24 GiB RAM; ordinary background processes remained active. Runs are sequential except for one explicitly invalidated HTTP pilot cell. Filesystem cache was not evicted.

## Sustained single-process controls

All cells use 9,000 matching records, 32 stored sort clauses and four concurrent query loops. Each response validates the selected IDs and stored ordering. The collector retains a 20 ms memory series plus rolling query-boundary peaks; it may miss synchronous allocation peaks. Latency arrays remain retained, so these are bounded-duration observations, not an instrumentation-free leak test.

| Raw report                                   | Duration | Writes/s achieved |  Query p99 | Queries/s | Errors |
| -------------------------------------------- | -------: | ----------------: | ---------: | --------: | -----: |
| `sustained-read-300s.json.gz`                |    300 s |                 0 |  291.10 ms |     15.74 |      0 |
| `strict-write-180s.json.gz`                  |    180 s |              9.95 | 1063.23 ms |      3.98 |      0 |
| `lag-plus-wait-180s-invalid-control.json.gz` |    180 s |              9.94 | 1067.87 ms |      3.99 |      0 |

The last row is **not a bounded-lag control**: a positive wait budget takes precedence over lag tolerance. It repeats the waiting path and is retained to prevent that invalid interpretation. The corrected control uses an untimed strict readiness barrier, then omits the wait option during measurement.

Observed memory: the read-only run's first/last-minute median RSS was 619.91/582.75 MiB, with a 632.41 MiB sampled peak. The strict-write run's medians were 622.66/528.25 MiB. The duplicate waiting-path run's medians rose from 537.61 to 674.00 MiB; later 30-second medians plateaued near 672–674 MiB while heap usage varied. This does not establish a leak, and it prevents a general claim that every workload has stable RSS. Longer post-GC/native-memory qualification remains open.

The native writer uses a fixed schedule and can catch up after stalls. The HTTP writer paces actual completions without catch-up bursts; their arrival processes are different. Strict-write latency near one second is consistent with publication waiting, but these controls alone do not isolate that mechanism.

Harness SHA-256: read-only `1637d08d38c00e733aecf2334857e09c8117bf29113bca0c5940d8b37cb680d6`; strict-write and duplicate control `83a46cb805be6a439b497e532429ecbe99cd348fa456d258ede08f1734df872f`. Reports include native runtime, query limits, CPU and event-loop metrics.

## Open qualification

[Qualify native full-text filtering and catalog-scale operation for v5.4](https://github.com/HarperFast/harper/issues/2512) remains open for representative catalog scale, working sets above RAM, OS-cold I/O, sustained native memory, admission fairness and agreed latency targets. Fresh-process results do not establish OS-cold behavior. A local 1M-row synthetic catalog does not establish representative 100M-row capacity.
