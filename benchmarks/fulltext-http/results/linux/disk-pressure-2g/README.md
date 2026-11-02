# Corrected disk-backed 10M pressure control — partial failure

Status: observed partial pressure failure; no final verdict. Owner: Kyle. Observed 2026-11-01.

Harper commit [c09243d1e](https://github.com/HarperFast/harper/commit/c09243d1e4f9915a0e3b933dc01d45afa24faec0); [full report](10000000.json.gz), [provenance](provenance.json.gz), [pressure cutover](pressure-cutover.json.gz), [mount/proc/cgroup receipt](measurement-receipt.json), [owned-unit oomd journal](owned-unit-oomd-journal.txt.gz).

The actual fixture mount was **ext4 on `/dev/nvme0n1p2`**, unlike the earlier tmpfs runs. Eight CPU quota, 2 GiB hard cgroup maximum, no swap; intended ten-million-row tables, two observed HTTP workers, eight clients and no writes. Setup took **709.209 seconds**; strict index readiness completed after process restart. API record counts remain estimates, not an exact cardinality audit.

**Four cells persisted, totaling 43,604 successful reads and 79 failed attempts. No fifth (structured) cell or final report verdict persisted.** Userspace **systemd-oomd** killed five processes in the owned unit at approximately **19:12:12 UTC**. This was not a kernel OOM kill: last sampled kernel `oom` and `oom_kill` counters remained zero. The journal result `oom-kill` alone must not be used to classify the killer.

## Timing and observed cells

The verified `memory.high` change from `max` to **805,306,368 bytes (768 MiB)** occurred at **19:09:55.313115 UTC**. Relevance completed beforehand. Sort began at approximately 19:09:53.532 UTC, so its first **1.781 seconds** ran before cutover: that cell is a mixed-limit observation. Subsequent highlight and exact cells ran after cutover, but do not constitute a completed clean pressure matrix.

| Query      | Successful reads | Failed attempts | Unknown counts (included in failures) | Success p95 ms | Failure p95 ms | Successful reads/s |
| ---------- | ---------------: | --------------: | ------------------------------------: | -------------: | -------------: | -----------------: |
| relevance  |           41,457 |               0 |                                     0 |          9.396 |          0.000 |            1381.64 |
| sort       |            1,544 |              11 |                                     0 |        240.779 |       6270.484 |              44.72 |
| highlights |              485 |              13 |                                     0 |       2170.552 |       6287.262 |              15.49 |
| exact      |              118 |              55 |                                    42 |       1112.539 |       6664.749 |               3.26 |

The error stream records 11 sort transport `terminated` failures, 13 highlight transport `terminated` failures, and 55 exact failures: 42 bounded counts remained unknown plus 13 native busy 503 errors. Unknown counts are allowed by the advisory count contract, but this qualification harness marks them failed because it asks for an exact total. Successful-response percentiles exclude these failures; failure latencies are retained separately. Client timeout counters remained zero and must not be conflated with transport/native failures.

## Pressure, I/O and termination evidence

At the last boundary (19:12:11.588021 UTC), `memory.events high=328,655`, `max=2,984`, `oom=0`, `oom_kill=0`; memory PSI some/full avg10 were **73.13% / 72.43%**. This records substantial reclaim/stall pressure before the userspace kill. It does not establish an application memory leak or baseline regression. The owned journal records 14 minutes 45.309 seconds wall time, 25 minutes 50.974 seconds CPU time and rounded `2G` cgroup peak; sampled detailed counters remain separately preserved.

Restarted server process `read_bytes` increased by **14,468,247,552 bytes** from cell-1 boundary at 19:09:54.115137 to latest boundary at 19:12:11.588021 UTC. This includes all server process I/O in that interval, potentially background engine work; it is not attributable solely to queries. Proc counters are partial-boundary observations, not whole-run physical disk totals. `io.stat` was unavailable.

Four accepted vanished-file disk walks were recorded in the raw report. This run naturally encountered the narrowly guarded `du` race; that is distinct from proving pressure query correctness. Mount/footprint timestamps and unavailable later API snapshots remain explicit. Cleanup records owned processes absent and fixture removed after failure. No automatic retry.

The missing structured timed control precludes attributing the pressure failures specifically to full-text. Comparing this run directly with the successful 6 GiB tmpfs run would change both storage medium and memory limits, so it is not a controlled A/B regression estimate. Successful-response tail latency is not a reliability pass.

This dataset remains bound to that recorded source. That harness had a final guard-sampling race that could omit a last guard failure from its final verdict; a later harness fix does not retroactively reverify these samples. Here the process kill left no final verdict in any case. All recorded failures and missing outcomes remain explicit.

## Preservation and privacy

All four cells, report diagnostics, every error record, pressure samples/cutover, boundary proc I/O/PSI, provenance/harness hashes and available API snapshots are preserved. Missing API samples remain represented by unavailable receipts. The manifest records raw-private, sanitized-payload and gzip SHA-256 plus replacement counts/JSON pointers. Recursive API identity redaction preserves all numeric values, keys and array ordering. Host, user, home and ephemeral-root strings are redacted; the source files remain unchanged.

Only three owned-unit journal lines establishing userspace oomd/result/resource metrics are retained; startup command lines are excluded with raw whole/selected hashes. Run/server/monitor logs, registry, config/auth/environment/cmdline are excluded. TMPDIR environment-value text is excluded; actual-fixture mount proof provides filesystem evidence.
