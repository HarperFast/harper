# Completed Linux 10M retry observation

Status: observed 2026-11-01; five read-only cells, not release qualification. Owner: Kyle.

Harper commit [c09243d1e](https://github.com/HarperFast/harper/commit/c09243d1e4f9915a0e3b933dc01d45afa24faec0); [complete report](10000000.json.gz), [provenance](provenance.json.gz), [measurement receipt](measurement-receipt.json). Node 24.16.0; native fulltext 0.8.0 / Tantivy 0.27.0. Eight CPU quota, 6 GiB cgroup limit, swap disabled. Two HTTP workers were observed after the controlled post-seed process restart.

Ten million intended seeded rows per table; 1,000 matching records per query bucket; 10,000 available catalog buckets. Setup took **582.278 seconds**. Strict index readiness completed before timed queries. API `recordCount` at post-restart/last boundaries was 9,887,203 per table; this is an estimated count, not an exact cardinality audit. Filesystem cache was not evicted; this is not an OS-cold observation.

## Timed read-only cells

Eight clients; no writes; each admission window 30 seconds, followed by drain. All **63,897 reads completed**, with **zero error records, rejection, timeout or unknown count**. This qualifies the measured cells under the harness checks, not every workload or production SLO.

| Query      | Completed reads | Distinct buckets attempted / 10,000 | Read p50 ms | p95 ms |  p99 ms | Successful reads/s | Sampled process RSS max bytes |
| ---------- | --------------: | ----------------------------------: | ----------: | -----: | ------: | -----------------: | ----------------------------: |
| relevance  |          45,055 |                              10,000 |       5.005 |  8.684 |  12.542 |            1501.57 |                   616,538,112 |
| sort       |           4,644 |                               4,644 |      49.873 | 85.000 |  99.222 |             154.57 |                   978,870,272 |
| highlights |           3,878 |                               3,878 |      67.240 | 98.566 | 109.052 |             129.17 |                 1,289,695,232 |
| exact      |           4,470 |                               4,470 |      59.703 | 94.110 | 108.069 |             148.79 |                 1,455,742,976 |
| structured |           5,850 |                               5,850 |      39.977 | 79.167 |  96.797 |             194.68 |                 1,916,555,264 |

Successful reads/s uses actual admission-plus-drain duration. Distinct bucket coverage is per cell, not universal catalog coverage for all query forms. Relevance cycled through all 10,000; the other cells reached the listed subsets. The first relevance request after process restart took 11.709 ms; subsequent query-form first requests were not fresh-process observations.

## Memory, disk and scope

Whole-scope cgroup high-water was **4,761,116,672 bytes (4.434 GiB)** under the 6 GiB maximum. This includes setup/client/harness/server and file cache. Highest sampled timed-cell process RSS was **1,916,555,264 bytes**, in the final structured cell; samples are not exact allocation peaks or a leak test. Cgroup OOM/kill counters remained zero. The run stayed below its hard memory limit; these observations do **not** establish query-driven memory-pressure qualification. A separate pressure control is outside this evidence bundle.

The report disk snapshot was 2,594,402,304 bytes; later external du snapshots have their own boundaries in the receipt. Snapshot races, elapsed timing and index compaction preclude treating these as exact physical-capacity guarantees. Proc I/O is partial first-to-last observation per PID, explicitly distinguishing setup and restarted server; `io.stat` unavailable. No whole-run I/O or cold-storage claim.

The raw report has no `diskSamplesWithVanishedFiles` field. Under the exact recorded `run.mts` harness hash (`7e2760e9eb7398c5894cc1b65f176e7c45635ef9d272d6a97afe660c6795fbd5`), that counter increments when `guardDisk` accepts an exit-1 vanished-file walk. Its absence therefore means **no accepted vanished-file walk was recorded** (derived count zero), rather than an explicit raw zero. This successful retry did not demonstrate a natural hit of the recovery branch; a separate real child-process check covers the classifier.

## Preservation and sanitization

Every report metric/diagnostic and error stream is preserved. API boundary snapshots remain labeled setup-five-minute, post-restart, first-cell and last. Selected proc/cgroup/footprint contents and input hashes are preserved in the receipt. The manifest records raw-private, sanitized-payload and compressed SHA-256 plus replacement counts/categories. No host/private-path replacements were required in selected artifacts. Logs/config/auth/environment/cmdline and monitor registry are excluded. Raw sources were not modified. Normalized receipt JSON follows repository formatting; embedded input snapshots and their hashes are unchanged.

Sources also include [errors](errors.ndjson.gz), [summary](summary.json), [manifest](sanitization-manifest.json), [external observations](external-observation.json.gz) and the API snapshots from [setup](system-information-setup-5min.json.gz), [post-restart](system-information-post-restart.json.gz), [first cell](system-information-first-cell.json.gz) and [last](system-information-last.json.gz). Exact cardinality audit, all-bucket coverage for every case, sustained memory and OS-cold behavior remain untested.
