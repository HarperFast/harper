# .github/ — Design notes

CI workflows.

**Read this when:** a workflow that installs dependencies fails on one Node line but not another, when changing which npm writes `package-lock.json`, or when changing how the Docker image is built, smoke-tested or published.

Index of every design note: [DESIGN.md](../DESIGN.md).

---

## The lock file must pass `npm ci` under npm 10 and npm 11 (`workflows/lockfile-npm-compat.yml`)

npm 11 accepts some lock files that npm 10's `npm ci` rejects as out of sync. Renovate and the Sync Lock File workflow (`.node-version`) write the lock with npm 11, but harper supports Node 22, which ships npm 10. harper#3006 auto-merged such a lock: the root `utf-8-validate` 6.x didn't satisfy the `^5.0.2` optional peer of the `ws@7` copies in the react-native subtree, so npm 10 wants a nested 5.x where npm 11 doesn't. harper#3015 removed that root declaration. `lockfile-npm-compat.yml` runs `npm ci --dry-run` on Node 22 and Node 24 for every PR and `main` push, with no path filter so it can be a required check.

When the Node 22 leg fails, remove the version conflict at its source. Regenerating the lock with npm 10 doesn't hold: the next npm 11 write prunes the npm-10-only entries again. Release bundling follows production reachability rather than trusting `dev` flags: native-containing trees remain unbundled so the consumer selects its own platform.

## A release copies to Docker Hub only the image it booted (`workflows/docker-smoke.yml`, `workflows/publish-docker.yaml`)

`publish-docker.yaml`'s `build` job is `docker-smoke.yml` called with `publish: true`. Outside pull requests the smoke job builds each platform image once, pushes it by digest to a registry on the runner (`localhost:5000`), pulls that digest for every smoke step, and only after all of them pass copies the same index (layers, config, provenance attestation) to Docker Hub by digest with `imagetools create -t harperfast/harper@<digest>`, which pushes no tag. The digest artifact `merge` tags is uploaded after that copy. Pushing a second, cache-hit build after the smoke was rejected: BuildKit may evict cache between the two solves, the Dockerfile is not reproducible (floating `node:24`, latest Bun fetched at build time), and an identity check after the push comes after the irreversible write. Pushing the loaded image itself drops the provenance attestation, which the daemon's image store cannot hold.

Pushes to `main` and release branches run the same staging path, copying into a second local repository, so the release transport is exercised before a release depends on it. Pull requests still load the image straight into the daemon. Two consequences of the staging registry: provenance subjects are named `pkg:docker/localhost:5000/harperfast/harper…`, since BuildKit takes the subject name from the build's image name; and `docker-smoke.yml`'s concurrency group has a literal prefix, because a called workflow sees the caller's `github.workflow` and a group equal to the caller's cancels the run as a deadlock. A release runs the workflow file at its tag, so the gate covers only releases tagged from a branch that contains it.
