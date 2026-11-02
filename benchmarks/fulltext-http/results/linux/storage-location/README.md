# Linux fixture storage-location correction

[Selected cleanup-time findmnt evidence](selected-findmnt.json) records `/tmp` mounted as `tmpfs` (source `tmpfs`) at **2026-11-01T18:56:25.743555Z**. It is a later mount observation, not a contemporaneous filesystem snapshot for every prior benchmark.

[Historical location traces](location-evidence.json) independently preserve normalized `/tmp/<HARPER_TEST_ROOT>` roots from the failed 10M pilot's error and the pressure setup footprint. Raw private basenames are replaced by a stable location label; source hashes, occurrence counts and private-root digests remain. No log, registry, environment or command-line content is exported.

The shared integration fixture helper normally creates `harper-integration-test-*` under `HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR` when set, otherwise `os.tmpdir()`. The receipt includes narrowly selected local helper lines and their source hash as explanatory evidence, explicitly not an exact historical remote dependency/environment receipt.

## What the evidence supports

Prior Linux results should be labeled **tmpfs-backed fixture observations, rather than disk-backed or cold-storage qualification**. This is directly backed by concrete `/tmp` roots for the failed pilot and pressure run plus the later mount inspection. Applying that correction to the earlier successful smoke, 1M feature/baseline and 10M retry runs is a bounded inference from their shared/default fixture setup; selected completed reports do not retain an independent concrete root or contemporaneous mount capture for each run. [Per-run provenance and evidence strength](run-location-scope.json) make that distinction explicit.

Consequently, previous `du` footprint values are tmpfs fixture sizes, not physical-disk throughput/capacity evidence. Cgroup `file` memory can include tmpfs/shmem pages; it must not be described wholly as ordinary evictable disk cache. The failed 2 GiB control was a real setup OOM, but does not validate intended disk-cache pressure. The 6 GiB successful retry does not demonstrate memory pressure or cold disk operation.

A corrected disk-backed control is separate work and is not included here. This receipt does not change prior raw measurements or imply they were rerun. Raw sources remain unchanged. Hash/selection metadata is in [the manifest](sanitization-manifest.json).
