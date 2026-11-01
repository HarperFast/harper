# Dedicated Linux observations

Status: observed on 2026-11-01; synthetic catalog evidence, not release qualification. Owner: Kyle.

Two observed HTTP workers; 8 CPU quota, 6 GiB cgroup memory limit; Node 24.16.0. Each query bucket has 1,000 matches. Catalog buckets rotate deterministically. Filesystem cache was not evicted; no cold-cache claim. Feature cells admit for 30 seconds; baseline cells for 35 seconds, with drain included in reported throughput. These are separate process runs with different cell matrices/order, not controlled latency regression estimates.

| Run      | Query      | Clients | Target writes/s | Read p95 ms | Successful reads/s | Read rejections | Write rejections | Unknown counts |
| -------- | ---------- | ------: | --------------: | ----------: | -----------------: | --------------: | ---------------: | -------------: |
| feature  | relevance  |       8 |               0 |        4.62 |            3512.52 |               0 |                0 |              0 |
| feature  | relevance  |       8 |              10 |        4.57 |            3499.09 |               0 |               10 |              0 |
| feature  | relevance  |      32 |               0 |       14.95 |            4192.12 |               8 |                0 |              0 |
| feature  | relevance  |      32 |              10 |       14.84 |            4150.88 |               6 |               10 |              0 |
| feature  | sort       |       8 |               0 |      102.63 |             153.68 |               0 |                0 |              0 |
| feature  | sort       |       8 |              10 |       84.34 |             177.35 |               0 |               10 |              0 |
| feature  | sort       |      32 |               0 |      222.82 |             184.34 |               0 |                0 |              0 |
| feature  | sort       |      32 |              10 |      283.38 |             178.79 |               2 |                7 |              0 |
| feature  | highlights |       8 |               0 |      104.20 |             148.11 |               0 |                0 |              0 |
| feature  | highlights |       8 |              10 |       98.63 |             162.84 |               0 |               10 |              0 |
| feature  | highlights |      32 |               0 |      267.26 |             172.83 |               0 |                0 |              0 |
| feature  | highlights |      32 |              10 |      234.49 |             170.52 |               1 |                6 |              0 |
| feature  | exact      |       8 |               0 |       85.20 |             171.89 |               0 |                0 |              0 |
| feature  | exact      |       8 |              10 |      114.16 |             134.29 |               0 |                9 |              0 |
| feature  | exact      |      32 |               0 |      259.00 |             175.44 |               2 |                0 |              2 |
| feature  | exact      |      32 |              10 |      260.05 |             159.69 |               0 |                8 |              0 |
| feature  | structured |       8 |               0 |       99.16 |             190.46 |               0 |                0 |              0 |
| feature  | structured |       8 |              10 |       96.67 |             188.20 |               0 |                0 |              0 |
| feature  | structured |      32 |               0 |      219.02 |             202.70 |               0 |                0 |              0 |
| feature  | structured |      32 |              10 |      223.22 |             201.16 |               0 |                0 |              0 |
| baseline | relevance  |      32 |               0 |       15.81 |            3676.55 |               0 |                0 |              0 |
| baseline | relevance  |      32 |              10 |       16.01 |            3730.77 |               2 |               10 |              0 |
| baseline | structured |      32 |               0 |      300.15 |             202.96 |               0 |                0 |              0 |
| baseline | structured |      32 |              10 |      206.96 |             206.46 |               0 |                0 |              0 |

`throughput` measures successful reads over actual admission-plus-drain duration. Target write rate is not achieved throughput; see full reports for completed writes and latencies. Stored-field sort/exact-count feature behavior has no baseline equivalent here. Baseline relevance and structured queries provide context only.

## Failures and memory scope

Feature recorded 70 write `DERIVED_INDEX_LAGGING` errors, 17 read transport `terminated` errors and two unknown bounded counts. Baseline recorded 10 write `DERIVED_INDEX_LAGGING` errors and two read transport `terminated` errors. Both retain every original error record. The shared classes occur on baseline too; this does not prove identical root causes. Cells with rejection or unknown-count failures remain unqualified.

Cgroup high-water marks were 1,432,571,904 bytes (feature) and 1,286,000,640 bytes (baseline). Both report zero OOM/kill events. These include harness/client/server and page cache; they are not isolated server allocation peaks or leak bounds. `serverRssPeakBytes` in the reports is a sampled process RSS maximum. Proc I/O samples cover only the documented mid-run observation interval. `io.stat` was unavailable. Measurement receipts preserve raw selected snapshots and source hashes.

## Provenance and sanitization

Both runs report identical native runtime capabilities: fulltext 0.8.0, Tantivy 0.27.0, ABI 13 and query API 7. Native addon SHA-256 is identical: `fb2486eda7522fdfa5ac3844f43837dc7d40688c7f3817bccd67c451f659e103`. Every harness hash also matches between these two runs, both measured at [b5f6659](https://github.com/HarperFast/harper/commit/b5f6659f7d1ed33670d63a31807aacf5c7d8e2d5). They are not current-harness measurements: later commits add the opt-in row ceiling and disk-walk race handling; original measured digests remain in the reports. See each compressed provenance JSON for the Harper commit, compiled hashes and complete runtime limits.

Only host identity strings were eligible for redaction; none occurred in the selected artifacts. No metric or error record was removed. The manifest lists selected paths and raw-private, sanitized-payload and gzip SHA-256 hashes. Gzip payloads preserve original bytes. Excluded files: run/build logs, monitor logs/registry, configuration, authentication, environment and command lines.

## Sources and open items

Sources: [feature report](feature/1000000.json.gz), [errors](feature/errors.ndjson.gz), [provenance](feature/provenance.json.gz), [measurement receipt](feature/measurement-receipt.json); [baseline report](baseline/1000000.json.gz), [errors](baseline/errors.ndjson.gz), [provenance](baseline/provenance.json.gz), [measurement receipt](baseline/measurement-receipt.json); [summary](summary.json) and [sanitization manifest](sanitization-manifest.json).

The complete matrix contains 544,401 validated responses; the baseline contains 274,011. Both retain all failures. These measurements demonstrate two observed HTTP workers, not balanced timed-query traffic. The first run stays below its memory allocation; its mid-run server read-byte counter did not increase, so it does not demonstrate query-driven disk pressure. Representative scale, active working sets above memory, OS-cold behavior, sustained memory and admission fairness remain open under [Qualify native full-text filtering and catalog-scale operation for v5.4](https://github.com/HarperFast/harper/issues/2512).

The [larger-catalog flag smoke and failed 10M setup](setup-attempt/README.md) are retained separately. The setup failed on a disappearing temporary file during disk measurement; it produced no timed query cells.

The disk classifier was also checked at [c09243d1e](https://github.com/HarperFast/harper/commit/c09243d1e4f9915a0e3b933dc01d45afa24faec0) through a [real Node child-process replay](disk-guard-verification.json) of the failed `du` output. Permission errors and exit 2 were rejected. A five-case 1,000-row HTTP smoke passed at that commit; it did not deliberately force filesystem retirement. Neither check is large-catalog performance qualification.

The [completed 10M retry](retry-10m/README.md) returned 63,897 validated pages across five read-only/eight-client cells with no errors or unknown totals. It preserves per-case coverage and does not establish an above-memory working set.
