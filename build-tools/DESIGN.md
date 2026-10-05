# build-tools/ — Design notes

Packaging and the published artifacts (npm dependency bundle, Docker image).

**Read this when:** touching dependency bundling, `build.sh` or the `Dockerfile`.

Index of every design note: [DESIGN.md](../DESIGN.md).

---

## Release dependencies are bundled without host binaries (`bundleDependencies.ts`)

`build.sh` installs the repository lock with `npm ci`, builds Harper and Studio, and stages npm's own source-file selection. Only the staged manifest declares `bundleDependencies`; a root `npm pack` remains a source package and cannot capture the development dependency tree. `prepareBundle` copies the locked, production-reachable JavaScript closure at its original nested/hoisted paths, leaving development-only entries behind. `checkBundle` validates both the stage and the extracted final archive against the checkout's lock. `bundleDependencies.test.mjs` covers a real pack → consumer install → offline `npm ci`, nested copies, native rejection and deliberate version corruption.

Native-containing roots remain ordinary dependencies with exact versions from the lock in the release manifest. This includes JavaScript wrappers (`msgpackr`, `cbor-x`, `structon`, `ws`) and the Bare-runtime optional trees of `tar-fs` and `tar-stream`. Shared direct packages (`@harperfast/extended-iterable`, `ordered-binary`, `weak-lru-cache`) also stay unbundled. Installation checks compare the resolution paths of the storage engines' shared iterables/encoder modules with Harper's, including a consumer layout where npm hoists native roots out of Harper's directory. `SKIP` itself is already a global Symbol; duplicate module copies do not create distinct sentinels.

<<<<<<< HEAD
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

## The image's shrinkwrap check must prove it could fail (`build-tools/check-shrinkwrap-pins.mjs`)

`docker-smoke.yml` runs this against the built image. Matching pins prove nothing where an unpinned
install would resolve the same versions, so the check also resolves the same `package.json` fresh
(lock-only, no shrinkwrap) and fails unless at least one checked edge differs there. That
requirement is why the check walks the whole packed tree, not a few named packages:

- **Direct dependencies cannot carry the proof.** Renovate's weekly non-major group moves every
  ranged direct dependency to its newest release that is at least 7 days old. The former
  hand-picked canaries went vacuous three times. On 2026-09-28, 27 of 28 ranged direct dependencies
  were at the newest version their range allowed. Transitive pins lag because renovate's
  `lockFileMaintenance` is off. If it is turned on, expect this check to fail right after each
  full refresh, until some pinned package publishes again.
- **Edges, not locations.** Each packed dependency edge is resolved node_modules-style in the packed
  map and in the installed tree. npm re-hoisting a pinned package to another path is not drift.
- **The exemption comes only from optional edges to `react-native-fs`**, the edge
  `prune-shrinkwrap-react-native.mjs` severs from any dependent (today only alasql declares one).
  The image re-adds that subtree (previous note), and it lifts shared pins such as the `@babel/*`
  packages `@endo/static-module-record` uses. Edges into that subtree, and the packed edges of a
  pinned package it lifted, are not pin-checked; a lifted shared pin prints a `::warning::`. A
  required edge the install resolved without a packed pin fails the check wherever it points:
  seeding the exemption from "anything unpinned" would exempt exactly the regression the check
  exists to catch. The exempt set becomes empty once alasql drops the optional edge.
=======
The bundle must be closed over declared dependencies and optional dependencies, including foreign-platform lock records. Missing optional peers remain externally supplied, as with `node-fetch`'s optional `encoding` peer. Native selectors, install-phase lifecycle hooks, Bare addons, `binding.gyp`, native file extensions and ELF/Mach-O/PE signatures fail preparation or archive inspection. A new native transitive therefore fails packaging instead of silently shipping a host binary. Add its containing root to the unbundled policy deliberately.

Copied manifests omit only unused optional `react-native-fs` edges and optional-peer-only `utf-8-validate` references. Explicit producers are preserved and can fail the native guard. Shared children survive because reachability is computed after cutting those declarations. This replaces shrinkwrap pruning: the omitted edges are absent from the bundled manifests themselves, so npm does not reintroduce the React Native tree. Retire the React Native rule when AlaSQL stops declaring that optional dependency.

The Docker image uses a normal global tarball install. Bundled JavaScript versions stay fixed on npm 10, 11 and 12, but **the unbundled native subtrees and externally supplied peers can still resolve ranged transitives**; exact root pins do not make the entire image reproducible. A consumer's conflicting dependencies/overrides can also split shared unbundled modules, which the installation checker reports. Bundled CVE fixes require a Harper lock update and release; rebuilding an unchanged tarball keeps the same JavaScript bytes. Bundles are not deduplicated with the consumer's packages.

The PR-gated consumer matrix installs the Linux-produced archive on Linux/npm 10, 11 and 12 and Windows/npm 11, runs consumer `npm ci`, verifies the bundle and module resolution, opens both engines and checks filtering, then tests a global install. Docker smoke repeats the installed-version/resolution checks against the source lock on the image's platform; nightly downstream application tests use the same artifact.
>>>>>>> c328f6f18 (Publish a portable locked JavaScript dependency bundle)

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

## `build.sh` packages only a clean, error-free build (`build.sh`)

`build.sh` deletes `dist/` and stops when `npm run build` fails, so `npm run package` stops at a type error, and with it the release workflow, `npm-package-app-e2e` and the Docker image. It used to run `npm run build || true`. `tsc` emits even while reporting errors, so a failed build was still packaged, and a stale `dist/` could hide a declaration file the compiler had stopped emitting. TypeScript 6.0+ did exactly that for `dist/resources/Table.d.ts` until #2904 gave `makeTable()` an explicit public type. A local `npm run package` over a tree with type errors now fails instead of packaging; fix the error rather than restoring the tolerance.
