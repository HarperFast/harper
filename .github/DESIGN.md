# .github/ — Design notes

CI workflows.

**Read this when:** a workflow that installs dependencies fails on one Node line but not another, when changing which npm writes `package-lock.json`, when changing how the Docker image is built, smoke-tested or published, or when `Unit tests: lmdb` hits its cap or a new unit suite seeds or clears rows.

Index of every design note: [DESIGN.md](../DESIGN.md).

---

## The lock file must pass `npm ci` under npm 10 and npm 11 (`workflows/lockfile-npm-compat.yml`)

npm 11 accepts some lock files that npm 10's `npm ci` rejects as out of sync. Renovate and the Sync Lock File workflow (`.node-version`) write the lock with npm 11, but harper supports Node 22, which ships npm 10. harper#3006 auto-merged such a lock: the root `utf-8-validate` 6.x didn't satisfy the `^5.0.2` optional peer of the `ws@7` copies in the react-native subtree, so npm 10 wants a nested 5.x where npm 11 doesn't. harper#3015 removed that root declaration. `lockfile-npm-compat.yml` runs `npm ci --dry-run` on Node 22 and Node 24 for every PR and `main` push, with no path filter so it can be a required check.

When the Node 22 leg fails, remove the version conflict at its source. Regenerating the lock with npm 10 doesn't hold: the next npm 11 write prunes the npm-10-only entries again. Release bundling follows production reachability rather than trusting `dev` flags: native-containing trees remain unbundled so the consumer selects its own platform.

## A release copies to Docker Hub only the image it booted (`workflows/docker-smoke.yml`, `workflows/publish-docker.yaml`)

The smoke checks exist because the image's dependency tree was resolved fresh at build time (harper#1960), and harper#2565 widened them to release-branch pushes; this note extends the same checks to the publish path.

`publish-docker.yaml`'s `build` job is `docker-smoke.yml` called with `publish: true`. Outside pull requests the smoke job builds each platform image once, pushes it by digest to a registry on the runner (`localhost:5000`), pulls that digest for every smoke step, and only after all of them pass copies the same index (layers, config, provenance attestation) to Docker Hub by digest with `imagetools create -t harperfast/harper@<digest>`, which pushes no tag. The digest artifact `merge` tags is uploaded after that copy. Pushing a second, cache-hit build after the smoke was rejected: BuildKit may evict cache between the two solves, the Dockerfile is not reproducible (floating `node:24`, latest Bun fetched at build time), and an identity check after the push comes after the irreversible write. Pushing the loaded image itself drops the provenance attestation, which the daemon's image store cannot hold.

Pushes to `main` and release branches run the same staging path, copying into a second repository on the same local registry, so staging, the smoke from the staged digest and the digest-only copy all run before a release does; the Docker Hub login and copy, the digest upload and `merge` still run first at a release. Pull requests still load the image straight into the daemon. Two consequences of the staging registry: provenance subjects are named `pkg:docker/localhost:5000/harperfast/harper…`, since BuildKit takes the subject name from the build's image name; and `docker-smoke.yml`'s concurrency group has a literal prefix, because a called workflow sees the caller's `github.workflow` and a group equal to the caller's cancels the run as a deadlock. A release runs the workflow file at its tag, so the gate covers only releases tagged from a branch that contains it.

## Unit-test fixtures don't spend `Unit tests: lmdb` on one durable commit per row (`workflows/unit-test.yml`)

`test:unit:lmdb` re-runs `unitTests/resources`, `unitTests/apiTests` and `unitTests/bin` on LMDB, where every awaited commit waits on a disk sync. A fixture that seeds or clears one row per transaction costs seconds on the default engine and minutes on LMDB, and a runner with slow fsync multiplies exactly that part. `subscriptionPreviousCountScanBound.test.js` (harper#2826), `subscriptionSuperseded.test.js` (harper#2887) and `calibrationStore.test.js` each pushed the step past its cap this way. Nothing enforces this; the step's `timeout-minutes` is the only detector.

Write a fixture's rows in one transaction and await a write only before the step that reads it. Empty a table with `Table.clear()`, or with every delete in one transaction where the table has a full-text index (`clear()` refuses it) or the suite reads the deletes from the audit log (`clear()` writes none). Where a test checks write order (calibration discovery scans decisions by time), keep those writes serial and let the independent ones commit alongside them. Before raising the cap, compare each suite's time in the `lmdb` step with the same suite in `resources (core)`/`resources (indexes)` of the same job, and fix the suite whose LMDB time grew.
