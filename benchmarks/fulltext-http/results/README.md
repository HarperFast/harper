# Qualification observations

Status: local measurements complete; dedicated Linux observations are [recorded separately](linux/README.md). Full-text qualification remains open. These observations do not close the catalog-scale release gate.

The runtime is [414b4ff](https://github.com/HarperFast/harper/commit/414b4ff9866556cc450ca32482c9b42ce929303e). No production code changed for these runs. Raw reports are gzip-compressed without changing their contents. Published provenance paths use worktree placeholders; artifact digests are unchanged. HTTP timing here uses a single observed post-restart worker: macOS disables shared-port reuse. Earlier worker IDs sampled across the restart do not prove concurrent worker coverage. The host is an Apple M4 Pro with 24 GiB RAM; ordinary background processes remained active. Runs are sequential except for one explicitly invalidated HTTP pilot cell. Filesystem cache was not evicted.

## Sustained single-process controls

All cells use 9,000 matching records, 32 stored sort clauses and four concurrent query loops. Each response validates the selected IDs and stored ordering. The collector retains a 20 ms memory series plus rolling query-boundary peaks; it may miss synchronous allocation peaks. Latency arrays remain retained, so these are bounded-duration observations, not an instrumentation-free leak test.

| Raw report                                                                               | Duration | Writes/s achieved |  Query p99 | Queries/s | Errors |
| ---------------------------------------------------------------------------------------- | -------: | ----------------: | ---------: | --------: | -----: |
| [sustained-read-300s.json.gz](sustained-read-300s.json.gz)                               |    300 s |                 0 |  291.10 ms |     15.74 |      0 |
| [strict-write-180s.json.gz](strict-write-180s.json.gz)                                   |    180 s |              9.95 | 1063.23 ms |      3.98 |      0 |
| [bounded-nowait-write-180s.json.gz](bounded-nowait-write-180s.json.gz)                   |    180 s |              9.99 |  335.28 ms |     14.90 |      0 |
| [lag-plus-wait-180s-invalid-control.json.gz](lag-plus-wait-180s-invalid-control.json.gz) |    180 s |              9.94 | 1067.87 ms |      3.99 |      0 |

The last row is **not a bounded-lag control**: a positive wait budget takes precedence over lag tolerance. It repeats the waiting path and is retained to prevent that invalid interpretation. The corrected control uses an untimed strict readiness barrier, then omits the wait option during measurement.

Observed memory: the read-only run's first/last-minute median RSS was 619.91/582.75 MiB, with a 632.41 MiB sampled peak. The strict-write run's medians were 622.66/528.25 MiB; the corrected no-wait run's were 611.86/583.34 MiB. The duplicate waiting-path run's medians rose from 537.61 to 674.00 MiB; later 30-second medians plateaued near 672–674 MiB while heap usage varied. This does not establish a leak, and it prevents a general claim that every workload has stable RSS. Longer post-GC/native-memory qualification remains open.

The native writer uses a fixed schedule and can catch up after stalls. The HTTP writer paces actual completions without catch-up bursts; their arrival processes are different. The corrected no-wait control reduces p99 from 1,063 to 335 ms and raises throughput from 3.98 to 14.90 queries/s, supporting publication waiting as a major contributor. It does not isolate every contributor or prove a before/after runtime regression.

Harness SHA-256: read-only `1637d08d38c00e733aecf2334857e09c8117bf29113bca0c5940d8b37cb680d6`; strict-write and duplicate control `83a46cb805be6a439b497e532429ecbe99cd348fa456d258ede08f1734df872f`. The corrected no-wait run uses the harness at [8cbd52d](https://github.com/HarperFast/harper/commit/8cbd52d94ce5ec42b50ffc8e7eb9b97330fdedab). Reports include native runtime, query limits, CPU and event-loop metrics.

## Million-row HTTP observations

Each of two tables contains 1M small synthetic records. Each query matches 1,000 records and returns 20; this does not measure a million-match exhaustive query. The full-text cases use `Product`; the structured rank-sort control uses `PlainProduct` with the same stored schema and secondary indexes. Default freshness/limits apply. The fixture is approximately 260 MiB, below host RAM. One post-restart serving worker is observed; configured thread count two is not simultaneous HTTP-worker coverage on macOS.

The table selects the first run's relevance/sort/highlight cells and the continuation's exact/structured cells: 20 cells from **two separate installs**, each with a 30-second admission window plus drain. It is not an uninterrupted matrix. The [summary](summary.json) identifies each raw report and all per-cell metrics. Latencies below describe successful responses; failure counts are separate and no timed request is retried.

| Case       | p99 ms: 8 clients / 0 writes | 8 / 10 | 32 / 0 | 32 / 10 | Read failures (unknown totals included) | Unknown totals | Write failures |
| ---------- | ---------------------------: | -----: | -----: | ------: | --------------------------------------: | -------------: | -------------: |
| relevance  |                         3.49 |   3.52 |  14.06 |   14.07 |                                     119 |              0 |             20 |
| sort       |                        83.10 |  82.97 | 194.12 |  196.48 |                                       1 |              0 |             18 |
| highlights |                        79.30 |  80.08 | 200.67 |  200.02 |                                       0 |              0 |             16 |
| exact      |                        72.22 |  75.24 | 224.13 |  252.44 |                                      33 |             30 |             19 |
| structured |                        94.96 |  99.88 | 197.26 |  229.24 |                                       0 |              0 |              0 |

Observed selected-cell totals: 761,915 successful queries, 120 transport failures, three explicit native-busy HTTP 503 responses, 30 unknown totals and 73 rejected writes. All four structured controls have zero errors. No incorrect known total or row was observed. Full-text cells with rejections/degradation remain unqualified; successful-response p99 is not an overall reliability verdict. Sampled server RSS peaked near 1.09 GiB including setup; no 6-GiB RSS or 12-GiB disk guard fired. This bounded run does not prove leak freedom.

The original 15-cell run stopped when the old oracle treated its first unknown total as fatal: 723,686 successes, 120 transport failures, one unknown total and 64 rejected writes. Its complete raw report remains [scale-1m-partial.json.gz](scale-1m-partial.json.gz). The corrected eight-cell continuation records 50,377 successes, three explicit native-busy HTTP 503 responses, 30 unknown totals and 19 rejected writes in [scale-1m-continuation.json.gz](scale-1m-continuation.json.gz). Across all 23 raw cells (including repeated count cells), there are 774,063 successes, 120 transport failures, three explicit native-busy HTTP 503 responses, 31 unknown totals and 83 rejected writes. The selection above is for a complete scenario table, not for discarding failed samples.

Server logs correlate native full-text busy events with the original relevance transport errors; the public mapping combines queue-full, timeout and resource-limit causes. Write errors explicitly report `DERIVED_INDEX_LAGGING`; observed trips recover near one second later. The recorded client message `terminated` alone does not establish the transport mechanism. The base-branch comparison below reproduces both observed failure classes.

## 100k pilot and exclusions

The 15-second/eight-client pilot returned 232,473 successful queries with no read/write errors. Its sort/no-write cell overlapped a separate native smoke at 16:24:57–16:25:05 UTC and is excluded from timing claims. A clean repeat returned 3,245 correct pages with p99 73.66 ms. The repeat's older two-worker guard failed after the workload; its timing is single-serving-worker evidence, not a qualified two-worker run. [Qualification notes](pilot-qualification-notes.json) retain both corrections. Other pilot p99 observations: relevance 3.28/3.33 ms (0/10 writes), highlights 74.06/78.25 ms, exact counts 74.91/84.48 ms and structured 62.36/61.51 ms. These are smaller/shorter pilot observations, not a controlled before/after comparison with the 1M runs.

## Base-branch comparison

An isolated build of the [PR merge base](https://github.com/HarperFast/harper/commit/3e8a2fa199c9b0ba920cf25e7e1bcea5a49a0548) ran the same 1M-record fixture with 32 clients, relevance/structured requests and 0/10 writes per second. These four cells used 35-second windows, not the feature run's 30 seconds; this establishes failure presence on the base, not a precise latency regression comparison.

Baseline results: 425,535 successful queries, 185 read transport errors (`terminated`) and ten `DERIVED_INDEX_LAGGING` write rejections. Both structured controls completed with zero errors. Thus those failure classes predate this PR. This does not explain the native busy/HTTP transport mechanism, prove that every frequency is unchanged, or establish a before/after comparison for sorting/counts that the base cannot serve.

[Comparison receipt](baseline-comparison.json), [dependency receipt](baseline-dependencies.json), [raw report](baseline-1m.json.gz) and [provenance](baseline-1m-provenance.json) retain evidence. Node 24.16.0, fulltext 0.8.0, rocksdb-js 2.13.0 and integration-testing 1.0.3 match. Native runtime metadata and addon SHA-256 match exactly (`1be756e4ab8ad471d29dc6d2f2af97eb44ddb0d0fc85aa389a52eb8cec3c0849`); compiled implementation digests differ as expected. Baseline sampled RSS peaked near 1.20 GiB including setup. Owned server/monitor cleanup completed.

## Harness verification

Eight pure tests cover deterministic membership/order, wrong known totals, documented unknown totals, wrong rows despite unknown totals, bounded histograms, stop handling, report publication after cleanup failures, the explicit larger-catalog ceiling and fail-closed disk-walk parsing. Live smoke validates real HTTP requests. The installed integration-testing 1.0.3 lifecycle (`dist/harperLifecycle.js`, SHA-256 `4cf198a2773839231898fd5594c11dae99baf98c02f8bcc70e610b256d57f2a9`) publishes `dataRootDir` before `launchHarper` at lines 385–388, and teardown is now called unconditionally; the lifecycle owns its partial-setup guard. Owned servers/monitor registries were checked after teardown. Post-measurement fixes delegate partial cleanup to the lifecycle, choose platform-appropriate defaults and normalize metadata paths. A two-cell live smoke passed after these narrow fixes; the timed matrices retain their original harness digests.

## Open qualification

[Qualify native full-text filtering and catalog-scale operation for v5.4](https://github.com/HarperFast/harper/issues/2512) remains open for representative catalog scale, working sets above RAM, OS-cold I/O, sustained native memory, admission fairness and agreed latency targets. The Linux runs observe both HTTP workers; balanced timed-query distribution is untested. Fresh-process results do not establish OS-cold behavior. A local 1M-row synthetic catalog does not establish representative 100M-row capacity.
