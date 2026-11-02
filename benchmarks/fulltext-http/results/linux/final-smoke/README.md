# Final Linux harness smoke and pure tests

Status: observed five-case smoke and nine pure tests; not scale qualification. Owner: Kyle. Observed 2026-11-01.

Exact head [82d13ca6f](https://github.com/HarperFast/harper/commit/82d13ca6f0b42db3e68a73a9acef899e56a2d851); [complete report](1000.json.gz), [provenance](provenance.json.gz), [cleanup provenance](cleanup-provenance.json.gz), [measurement/mount/test receipt](measurement-receipt.json).

Five one-second query cells completed **1,835 successful reads**, zero errors, zero unknown counts and a qualified harness verdict. This was a 1,000-row smoke corpus, one client and no writes; it validates final harness plumbing, not catalog scale, sustained pressure or production latency. Two HTTP workers were required and observed.

| Query      | Completed reads | Read p95 ms | Errors | Unknown counts |
| ---------- | --------------: | ----------: | -----: | -------------: |
| relevance  |             760 |       2.011 |      0 |              0 |
| sort       |             188 |       8.376 |      0 |              0 |
| highlights |             162 |       9.552 |      0 |              0 |
| exact      |             211 |       7.332 |      0 |              0 |
| structured |             514 |       2.865 |      0 |              0 |

The retained `pure-tests.txt` output reports **nine tests passed, zero failed**, including the in-flight sampler guard failure during cleanup. The final smoke runs that head; earlier scale/pressure measurements remain bound to their recorded older harness heads and were not retroactively rerun or reclassified.

Actual fixture mount and CPU/memory controls are retained in the receipt. Cleanup provenance records the exact head, runtime/addon comparison and owned scope/fixture cleanup. Empty errors.ndjson is preserved. Raw reports, hashes and all selected metric values remain unchanged apart from private identity/path strings. Manifest records raw-private, sanitized-payload and gzip SHA-256 plus replacement counts. Recursive API identity handling applies even though this smoke has no API snapshot files.

Run/monitor logs, raw registry, configuration/authentication/environment/command lines are excluded. No additional workload or review was run while preparing this bundle.
