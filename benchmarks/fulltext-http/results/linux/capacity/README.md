# Observed 10M-row capacity envelope

Status: observed 2026-11-01, independently checked against retained reports; both complete runs are unqualified. Owner: Kyle. These measurements establish passing and failing workload cells, not release qualification.

## Result

| Run      | Persisted cells | Passing observed cells | Validated reads | Failed reads | Successful writes | Failed writes |
| -------- | --------------: | ---------------------: | --------------: | -----------: | ----------------: | ------------: |
| Feature  |              36 |                     17 |         585,663 |          280 |             9,830 |           105 |
| Baseline |              12 |                      7 |         392,921 |          112 |             3,307 |            30 |

Every full-text form passed without writes at one and eight clients. Every 32-client full-text cell failed. Every full-text nominal-10-writes/s cell failed. This is a single bounded observation per cell, not a recommended production concurrency limit.

Feature read failures were 273 terminated responses (122 relevance, 92 sort, 59 highlights), five unknown exact totals and two exact-query native-busy 503 responses. All 105 failed writes were `503 DERIVED_INDEX_LAGGING`. Baseline reproduced 112 terminated relevance responses and 30 lagging writes. Shared failure classes predate this change; these runs do not establish identical causes or statistical performance equivalence.

Three feature structured write cells had no errors but missed the achieved write-service minimum: leading 32 clients 5.900/s; trailing eight clients 9.192/s; trailing 32 clients 4.687/s. Baseline structured 32-client writes similarly achieved only 5.502/s. Their raw harness verdicts remain qualified; the stricter capacity analysis rejects them. Configured load alone is insufficient.

## Fixed protocol and acceptance

Both installs seeded 10,000,000 records per table, with 1,000 matches per deterministic query bucket. The full-text table and matched table without full-text indexing are both seeded. An unmatched writer row exercises publication load while preserving query cardinality; matching-row mutation and representative customer distributions are untested.

- Dedicated Linux host; eight CPU quota shared by server, harness and clients; hard memory 4 GiB, `memory.high=max`, swap zero.
- Actual fixture roots verified on NVMe/ext4. No cache eviction, global policy changes or competing benchmark. Two HTTP workers observed in one server process; balanced timed traffic is untested.
- Clients one/eight/32; target writes zero/ten per second; each cell admits for 60 seconds plus bounded drain. Feature order: structured, relevance, sort, highlights, exact, structured. Baseline order: structured, relevance. Each case spans all six client/write combinations. Repeated controls retain distinct occurrences.
- Setup deadline 15 minutes, disk 12 GiB, free-space minimum 2 GiB, request timeout 45 seconds and original diagnostic/RSS guards remain enforced. Feature setup took 646.277 seconds; baseline 695.481 seconds.
- External stop: memory pressure-stall `some.avg10 >=40%` continuously for 15 seconds triggers one SIGINT, with at most 90 seconds cleanup before stopping only the owned unit. Four synthetic watchdog checks passed. Parent oomd policy was read, not changed. Neither primary run triggered that stop, OOM or unexpected worker identity.

A passing observed cell requires a qualified cell verdict, nonempty validated reads, zero read/write failures and zero unknown totals. Nominal-ten-write cells additionally require successful completed writes divided by actual admission-plus-drain seconds to be at least 9.5/s. The 60-second admission population is reported separately; 570 completed writes alone is not sufficient. This tolerance tests achieved demand, not a business latency objective.

Full-run qualification additionally requires a qualified final verdict, no recorded fatal/guard failure, every expected ordered cell and every cell passing. Earlier successful cells do not erase failures elsewhere. Both matrices completed, with no recorded fatal failure, but workload failures make both final verdicts unqualified. No automatic retry or larger-memory run followed.

## Resources and interpretation

| Observation                            | Feature | Baseline |
| -------------------------------------- | ------: | -------: |
| Observed memory PSI some.avg10 maximum |   0.00% |    0.00% |
| CPU throttled time, whole scope        | 0.389 s |  1.025 s |
| Kernel OOM/kill events                 |       0 |        0 |
| Memory hard-limit events               |   1,903 |      206 |

Feature cache reclaim/refaults and process-memory growth occurred, but sampled pressure did not show sustained stalls. Server read-byte counters increased about 79 MiB between the first and last feature cell boundaries; engine activity is included. These are NVMe-resident, largely cache-served observations, not above-RAM or OS-cold I/O qualification. Low CPU-quota throttling does not exclude individual-thread or event-loop bottlenecks. These observations do not justify increasing RAM as a demonstrated remedy.

Leading/trailing structured controls are retained for drift, not causal attribution. Read p95 at 32 clients without writes rose from 222.56 to 242.88 ms; with writes it rose from 234.88 to 440.40 ms while successful write service fell. A single fixed-order matrix cannot separate cache, maintenance, workload-order and time effects. Successful-response latency excludes failures; failure counts and latency distributions remain in the analysis and raw reports.

## Provenance and sources

Feature harness/source: [final sampler fix](https://github.com/HarperFast/harper/commit/82d13ca6f0b42db3e68a73a9acef899e56a2d851); production unchanged since [final-page eligibility](https://github.com/HarperFast/harper/commit/414b4ff9866556cc450ca32482c9b42ce929303e). Baseline: [merge-base snapshot](https://github.com/HarperFast/harper/commit/3e8a2fa199c9b0ba920cf25e7e1bcea5a49a0548), separately compiled with only the identical benchmark fixture/harness overlaid. Dependencies deliberately share identical contents. Actual server executable and all seven mapped native addon hashes match, as do harness digests. Node 24.16.0; fulltext 0.8.0, Tantivy 0.27.0, ABI 13/query API 7. Both restarted servers reported a 1 GiB block-cache capacity.

- [Derived analysis](analysis.json): all 48 cells, success/failure tails, achieved service, attempted bucket coverage, run barriers, 12 common first-occurrence comparisons and six trailing controls. It binds original private report/provenance hashes; publication manifests map these to redacted payloads.
- Feature: [report](feature-10m-4g/10000000.json.gz), [all errors](feature-10m-4g/errors.ndjson.gz), [provenance](feature-10m-4g/provenance.json.gz), [observer stream](feature-10m-4g/external-observations.ndjson.gz), [manifest](feature-10m-4g/sanitization-manifest.json).
- Baseline: [report](baseline-10m-4g/10000000.json.gz), [all errors](baseline-10m-4g/errors.ndjson.gz), [provenance](baseline-10m-4g/provenance.json.gz), [observer stream](baseline-10m-4g/external-observations.ndjson.gz), [manifest](baseline-10m-4g/sanitization-manifest.json).

[Archive index](archive-index.json) binds the feature and baseline `measurement-evidence.tar.gz` files and their member lists. These archives hold the per-cell boundaries, process maps, cache, mount, cgroup and watchdog snapshots; extract each into its containing run directory before validating every manifest entry. Reports, errors, provenance and observer streams stay directly accessible. Archive construction verified byte-for-byte member equality.

Manifests preserve raw-private, sanitized-payload and compressed hashes. Recursive identity redaction includes dictionary keys and nested API host/user fields; numerical samples, array order and outcomes are unchanged. Configuration, authentication, environment values, command lines and logs/registries are excluded. Observer source is identified by hash, not published. The [cleanup receipt](preflight/combined-preflight-final-cleanup.json.gz) records owned process, fixture and scope cleanup; [cross-run gates](preflight/combined-preflight-primary-cross-run-gates.json.gz) bind the matched artifacts and cache settings.

## Preflight and review

The [preflight manifest](preflight/sanitization-manifest.json) retains both exact-envelope 1,000-row/one-second smoke matrices and the intentionally stopped initial baseline seed. Feature smoke: 36 cells, one terminated highlight read; baseline smoke: 12 clean cells. Their short duration cannot satisfy capacity acceptance. The initial baseline was operator-aborted before timed cells to adopt the reviewed external controls; its zero-cell report retains the resulting fetch failure. It is not a measured capacity failure. No smoke retry hid the failed request.

Independent local readers checked acceptance, numerical preservation, manifests, privacy and this summary. An attempted external Claude documentation check was blocked by automatic approval review because exporting these measurement reports was outside its interpretation of earlier source/diff authorization; no evidence export or outside documentation review completed. The prior code reviews and Claude protocol planning review remain distinct.

## Open items

No sustained soak, leak bound, OS-cold or physical-above-RAM qualification, matched-row write churn, balanced worker traffic, randomized/repeated performance A/B or agreed latency SLO is claimed. Baseline has no equivalent for the new sort/exact forms. Transport/admission investigation and broader qualification remain in [Qualify native full-text filtering and catalog-scale operation for v5.4](https://github.com/HarperFast/harper/issues/2512). Existing Harper/fulltext/Tantivy ownership and budgets are unchanged.

Comment generated by kAIle (GPT-6)
