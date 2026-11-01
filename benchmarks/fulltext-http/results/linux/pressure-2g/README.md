# Failed Linux pressure control — setup OOM

Status: observed setup failure; no timed query cells. Owner: Kyle. Observed 2026-11-01.

Harper commit [c09243d1e](https://github.com/HarperFast/harper/commit/c09243d1e4f9915a0e3b933dc01d45afa24faec0); [complete report](10000000.json.gz), [provenance](provenance.json.gz), [pressure samples](pressure-observations.ndjson.gz), [owned-unit OOM journal](owned-unit-oom-journal.txt.gz).

**Zero timed cells or first-query observations completed.** The kernel OOM killer killed processes in the owned scope during setup at approximately 18:49:59 UTC. The journal records result `oom-kill`, 5 minutes 19.254 seconds wall time, 10 minutes 34.853 seconds CPU time and rounded `2G` memory peak. The report's `fetch failed` is a consequence observed by the harness, not a query latency result.

The actual configured hard maximum was 2,147,483,648 bytes (2 GiB), swap zero, eight CPU quota. The intended 768 MiB `memory.high` cutover never occurred: the controller recorded `memory.high=max` and `cutoverVerified=false`. Therefore this is an **invalid soft-threshold pressure control**, and a real setup-capacity failure at the hard limit. It does not qualify query behavior under sustained cache pressure or demonstrate a query regression.

The fixture used the host temporary directory on tmpfs, charging memory-backed catalog files as shmem. This OOM describes that setup layout; it is not an above-memory NVMe workload result. See the later [storage-location audit](../storage-location/README.md).

## Counters and observation boundaries

All 150 pressure samples and 4,288 report diagnostics are preserved. Last pressure sample at 18:49:58.500839 UTC preceded the kill: `memory.current=2,143,174,656`, `memory.peak=2,147,508,224` bytes; `memory.events max=170`, `oom=0`, `oom_kill=0`. Those pre-kill zero counters do not contradict the later kernel OOM journal. There was no surviving post-kill cgroup snapshot. Generic inactive-unit properties collected later are not historical limits or counters.

That sample recorded anon 710,320,128 bytes, file 1,409,806,336 bytes, including shmem 1,407,729,664 bytes. File therefore must not be described as entirely ordinary evictable disk cache. These setup observations do not establish a production memory-pressure model. Proc I/O is partial first-to-last sampling; `io.stat` unavailable. Setup-five-minute API metrics/footprints are not completed-catalog or timed-cell data; API record counts are estimates.

Cleanup evidence records scope inactive and owned server/harness processes absent; no automatic retry. Empty errors.ndjson is retained and does not mean setup succeeded.

## Preservation and privacy

Full selected reports, diagnostic/error records, provenance/harness hashes, API setup snapshot, controller observations and cleanup classification are preserved. Cgroup/proc/footprint text snapshots and their input hashes are normalized into the [measurement receipt](measurement-receipt.json). The manifest records raw-private and sanitized/compressed SHA-256 hashes, selection boundaries and replacement counts.

Three journal lines establishing OOM/result/CPU-wall-memory metrics are retained with hostnames redacted. The startup line containing a command line is excluded explicitly, with whole-source and selected-source hashes recorded. Other logs, monitor registry, configuration, authentication, environment and command lines are excluded. Raw source files remain unchanged.
