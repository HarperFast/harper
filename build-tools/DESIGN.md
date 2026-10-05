# build-tools/ — Design notes

Packaging and the published artifacts (npm dependency bundle, Docker image).

**Read this when:** touching dependency bundling, `build.sh` or the `Dockerfile`.

Index of every design note: [DESIGN.md](../DESIGN.md).

---

## Release dependencies are bundled without host binaries (`bundleDependencies.ts`)

`build.sh` installs the repository lock with `npm ci`, builds Harper and Studio, and stages npm's own source-file selection. Only the staged manifest declares `bundleDependencies`; a root `npm pack` remains a source package and cannot capture the development dependency tree. `prepareBundle` copies the locked, production-reachable JavaScript closure at its original nested/hoisted paths, leaving development-only entries behind. `checkBundle` validates both the stage and the extracted final archive against the checkout's lock. `bundleDependencies.test.mjs` covers a real pack → consumer install → offline `npm ci`, nested copies, native rejection and deliberate version corruption.

Native-containing roots remain ordinary dependencies with exact versions from the lock in the release manifest. This includes JavaScript wrappers (`msgpackr`, `cbor-x`, `structon`, `ws`) and the Bare-runtime optional trees of `tar-fs` and `tar-stream`. Shared direct packages (`@harperfast/extended-iterable`, `ordered-binary`, `weak-lru-cache`) also stay unbundled. Installation checks compare the resolution paths of the storage engines' shared iterables/encoder modules with Harper's, including a consumer layout where npm hoists native roots out of Harper's directory. `SKIP` itself is already a global Symbol; duplicate module copies do not create distinct sentinels.

The bundle must be closed over declared dependencies and optional dependencies, including foreign-platform lock records. Missing optional peers remain externally supplied, as with `node-fetch`'s optional `encoding` peer. Native selectors, install-phase lifecycle hooks, Bare addons, `binding.gyp`, native file extensions and ELF/Mach-O/PE signatures fail preparation or archive inspection. A new native transitive therefore fails packaging instead of silently shipping a host binary. Add its containing root to the unbundled policy deliberately.

Copied manifests omit only unused optional `react-native-fs` edges and optional-peer-only `utf-8-validate` references. Explicit producers are preserved and can fail the native guard. Shared children survive because reachability is computed after cutting those declarations. This replaces shrinkwrap pruning: the omitted edges are absent from the bundled manifests themselves, so npm does not reintroduce the React Native tree. Retire the React Native rule when AlaSQL stops declaring that optional dependency.

The Docker image uses a normal global tarball install. Bundled JavaScript versions stay fixed on npm 10, 11 and 12, but **the unbundled native subtrees and externally supplied peers can still resolve ranged transitives**; exact root pins do not make the entire image reproducible. A consumer's conflicting dependencies/overrides can also split shared unbundled modules, which the installation checker reports. Bundled CVE fixes require a Harper lock update and release; rebuilding an unchanged tarball keeps the same JavaScript bytes. Bundles are not deduplicated with the consumer's packages.

The PR-gated consumer matrix installs the Linux-produced archive on Linux/npm 10, 11 and 12 and Windows/npm 11, runs consumer `npm ci`, verifies the bundle and module resolution, opens both engines and checks filtering, then tests a global install. Docker smoke repeats the installed-version/resolution checks against the source lock on the image's platform; nightly downstream application tests use the same artifact.

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
