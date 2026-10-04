# integrationTests/ — Design notes

The end-to-end suite: fixtures, deployed components, and the harness that starts real Harper
instances.

**Read this when:** adding or regenerating a fixture under `integrationTests/fixtures/`.

Index of every design note: [DESIGN.md](../DESIGN.md).

---

## A deployed fixture must not install from the npm registry (`integrationTests/fixtures/`)

`deploy_component` runs a real `npm install` for a package that declares production dependencies and
ships no `node_modules`, putting the public npm registry on a test's critical path. A stalled
registry socket outlives every deadline the test can set: Harper's own spawn bound is
`DEFAULT_COMMAND_TIMEOUT_MS = 60 * 60 * 1000` (`components/Application.ts`), so the client gives up
first — `main` went red this way at 576d33330 on one leg of 36, five minutes of silence and
`UND_ERR_HEADERS_TIMEOUT`.

A fixture therefore declares no production dependencies, resolves them from local files the archive
carries (`deploy/redeploy-runtime-equivalence.test.ts` builds a `file:vendor/...` dependency, which
exercises the automatic install path without a registry), neutralizes the install with
`install_command` (`components/early-hints.test.ts`), or vendors its dependencies into the archive so
`installApplication` takes its `node_modules`-present early return.
`template-redirector-3.0.1-vendored.tgz` is the last case: the published `template-redirector@3.0.1`
plus `node_modules/papaparse` at the version its manifest pins, which is why its name diverges from
the package it came from — regenerating it with `npm pack` alone would silently restore the flake.

Nothing enforces this across fixtures, and two suites still violate it: `mqtt/mqtt.test.ts` and
`components/acl-connect.test.ts` deploy fixtures whose manifests pin `@harperdb/acl-connect` and
`jsonwebtoken` with no committed `node_modules`, so a hang in either deploy is worth checking
against the instance log's `spawn:npm` line before it is diagnosed as a new bug.

For the redirector archive specifically, `components/redirector.test.ts` asserts the instance log
contains `already has node_modules; skipping install` and no `[redirector:spawn:npm]` line.
