# Linux large-catalog flag smoke and failed 10M pilot

Status: observed 2026-11-01; no completed 10M query result. Owner: Kyle.

## Failed pilot

Harper commit [31e3ffab8](https://github.com/HarperFast/harper/commit/31e3ffab8c054764cde062951ceba5cda04dfb2f); Node 24.16.0, 8 CPU quota / 6 GiB cgroup limit / no swap. Intended size: 10 million rows per table. Elapsed scope approximately 9 minutes 18 seconds. **Zero timed cells and zero first-query observations completed. No 10M query qualification resulted.**

Setup failed because `du -sk <HARPER_TEST_ROOT>` returned exit 1 when a transient Tantivy `.tmp` file disappeared during traversal. No timeout/kill signal was recorded for that command. `diskBytes` retained the last available snapshot; it is not an exact completed-catalog footprint. This is a harness measurement failure, not evidence of database correctness failure or a demonstrated memory-pressure failure.

The diagnostic trace implies approximately 9,640,500 seeded rows per table (965 completed guard batches); this is trace-derived, not a verified post-setup record count or strict index-ready state. The setup-five-minute API snapshot independently reports 5,429,500 records per table at that earlier point. Neither proves completion.

Sampled process RSS maximum: 1,433,665,536 bytes. Cgroup high-water: 3,999,924,224 bytes. Zero OOM/kill events; final observed anon 1,339,736,064 bytes, file cache 2,471,596,032 bytes. These setup observations do not establish sustained query memory or pressure behavior. Empty errors.ndjson is preserved and does not mean setup succeeded.

## Flag smoke

1,000 rows, one client, no writes, two observed HTTP workers, `largeCatalog=true`, five one-second cells. All five harness verdicts qualified with no recorded errors. This validates flag plumbing, not large-catalog capacity.

| Query      | Read p95 ms | Completed reads | Rejections | Unknown counts |
| ---------- | ----------: | --------------: | ---------: | -------------: |
| relevance  |       1.944 |             803 |          0 |              0 |
| sort       |       8.008 |             189 |          0 |              0 |
| highlights |       7.897 |             184 |          0 |              0 |
| exact      |       6.271 |             225 |          0 |              0 |
| structured |       2.777 |             534 |          0 |              0 |

## Preserved evidence and sanitization

Reports retain every diagnostic, metric, failure message/stack and harness hash. Both empty error streams are retained. Provenance records exact commits, compiled hashes and native runtime/addon identity. Measurement receipts preserve selected cgroup/proc/footprint snapshots and input hashes. The failed setup API snapshot is explicitly scoped to seed progress. `io.stat` is unavailable; proc I/O scope is partial and recorded in external-observation.json.

The manifest records selected relative paths, replacement counts/categories and raw-private, sanitized-payload and compressed SHA-256. Only ephemeral test-root paths required replacement. No metric values or failure signatures were removed. Raw-private sources remain unchanged. Logs, configurations, authentication, environment, command lines and monitor registry are excluded. Normalized receipt JSON uses repository formatting; embedded snapshots and input hashes are unchanged.

## Sources and open items

Sources: [failed report](failed-pilot/10000000.json.gz), [errors](failed-pilot/errors.ndjson.gz), [provenance](failed-pilot/provenance.json.gz), [receipt](failed-pilot/measurement-receipt.json), [setup API snapshot](failed-pilot/system-information-setup-5min.json.gz), [setup summary](failed-pilot/setup-summary.json.gz), [external observation](failed-pilot/external-observation.json.gz); [smoke report](flag-smoke/1000.json.gz), [errors](flag-smoke/errors.ndjson.gz), [provenance](flag-smoke/provenance.json.gz), [receipt](flag-smoke/measurement-receipt.json); [manifest](sanitization-manifest.json).

The disk-walk correction and a completed larger retry require their own exact-head verification. This failed setup supplies no query latency, no active-working-set qualification and no readiness proof for the intended 10M corpus.
