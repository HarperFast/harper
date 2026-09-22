# build-tools/ — Design notes

Packaging and the published artifacts (npm tarball, shrinkwrap, Docker image).

**Read this when:** touching the shrinkwrap scripts, `build.sh` or the `Dockerfile`.

Index of every design note: [DESIGN.md](../DESIGN.md).

---

## The published shrinkwrap governs registry installs but not tarball installs (`build-tools/`)

npm decides whether to honor a dependency's bundled `npm-shrinkwrap.json` from the `_hasShrinkwrap`
flag in the **registry packument**, metadata the registry sets at publish time — not by looking
inside the tarball. So `npm install harper` from the registry installs exactly the tree the
shrinkwrap describes, including honoring _omissions_ (it will not re-resolve an optional dependency
that has been pruned out). But `npm install ./harper-*.tgz` has no packument, so npm never learns the
shrinkwrap exists and re-resolves the whole tree from `package.json`. Verified on one published
5.1.23 artifact: via the registry it honored the pin (fastify 5.8.5), from the tarball it resolved
fresh (fastify 5.10.0, then-latest).

Three consequences worth knowing before touching packaging:

- `overrides` in harper's `package.json` are **root-only** and do nothing for anyone installing
  harper. The shrinkwrap is the only lever that reaches consumers, which is why the react-native
  prune lives in `build-tools/prune-shrinkwrap-react-native.mjs` rather than in `overrides` (#1937).
- The published shrinkwrap is deliberately _not_ what `npm shrinkwrap` produced — `build.sh`
  post-processes it (dev prune #1783, react-native prune #1937) to enforce that it describes only the
  production tree a consumer installs. Anything added there must keep it internally consistent; a
  pruned entry that something still requires would ship a broken tree to every consumer.
- The Dockerfile extracts the local tarball into a project directory and runs `npm install` there
  (rather than `npm install --global <tarball>`), so it reads `npm-shrinkwrap.json` off disk like any
  checked-out project and gets version pinning (#1960). It does **not** get the omission half: `npm
install` (unlike a registry install of harper as _someone else's_ dependency) reconciles the local
  project's own `package.json` against the lockfile, and the packed `package.json` prunes nothing —
  only the shrinkwrap does. `alasql`'s packed manifest still declares the react-native-fs optional
  edge, so plain `npm install` silently re-adds that whole pruned subtree to satisfy it. Closing that
  gap needs `npm ci` against a package.json where `alasql`'s own packed manifest has also had the edge
  removed — a bigger change to the published tarball than this dance, and not yet done. The Dockerfile
  does strip `devDependencies` from its _own extracted copy_ of `package.json` before installing (not
  the published tarball — registry consumers never see this) — not for `npm ci`'s sake, but because
  without it `npm install` still resolves dev edges to compute the ideal tree even under `--omit=dev`,
  which could silently lift a _production_ package that a devDependency also happens to want above its
  shrinkwrap pin. Confirmed empirically before landing: a hoisted production package's installed
  version tracked a devDependency's looser range instead of the shrinkwrap pin without this strip.
- Pinning inverts the old incident-remediation path, worth knowing before reaching for it: before
  #1960, rebuilding the image picked up any newer in-range dependency automatically, which is how a
  bad pin got fixed in production by "refresh/rebuild the image" alone. After #1960, the _pinned_ part
  of the tree is frozen to the shrinkwrap, so a remediation of that shape now needs a lock bump and a
  re-release — a rebuild alone reproduces the same tree, bug included. This does **not** apply to the
  react-native residual two bullets up: that subtree is still re-resolved fresh on every build, so a
  bug specific to it (not that anyone should want one there) actually would clear on a rebuild.

## The published image runs `tini -g` as PID 1, not Harper (`Dockerfile`)

Harper used to be PID 1 in the published image. It is now started under `tini -g`, and that is
user-visible in four ways worth knowing before changing the entrypoint:

- **The restart watchdog depends on it.** `bin/restartExitWatchdog.ts` refuses to arm when
  `process.pid <= 1`, and the SIGKILL it delivers would be ignored by PID 1 anyway (the kernel
  drops unhandled signals to the init process). Harper being a _child_ is what makes a wedged
  restart teardown forcibly exit rather than hang until the orchestrator's own timeout.
- **`-g` forwards `docker stop`'s SIGTERM to Harper's process group**, not just Harper. This reaches
  descendants a component spawns in-group — they now receive SIGTERM directly instead of only seeing
  their parent go away — and is the boundary most likely to change behaviour for such a component. It
  does **not** reach Harper-managed subprocesses: `utility/processManagement/processManagement.js`
  forks them `detached: true`, which `setsid()`s them into their own group and session, so tini's
  group signal never arrives.
- **`docker exec … ps` and anything keying off PID 1** now sees `tini`, not `node`.
- **`docker run --init` nests a second init** above `tini`. Harmless, but redundant.

Volumes written by older PID-1 images stay compatible: `utility/processManagement` treats a pid
file naming PID 1 as stale when PID 1 is an init process, so a container restarted onto such a
volume does not refuse to start on a "still running" pid that is now `tini`.
