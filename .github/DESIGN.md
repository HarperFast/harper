# .github/ — Design notes

CI workflows.

**Read this when:** a workflow that installs dependencies fails on one Node line but not another, or when changing which npm writes `package-lock.json`.

Index of every design note: [DESIGN.md](../DESIGN.md).

---

## The lock file must pass `npm ci` under npm 10 and npm 11 (`workflows/lockfile-npm-compat.yml`)

npm 11 accepts some lock files that npm 10's `npm ci` rejects as out of sync. Renovate and the Sync Lock File workflow (`.node-version`) write the lock with npm 11, but harper supports Node 22, which ships npm 10. harper#3006 auto-merged such a lock: the root `utf-8-validate` 6.x didn't satisfy the `^5.0.2` optional peer of the `ws@7` copies in the react-native subtree, so npm 10 wants a nested 5.x where npm 11 doesn't. harper#3015 removed that root declaration. `lockfile-npm-compat.yml` runs `npm ci --dry-run` on Node 22 and Node 24 for every PR and `main` push, with no path filter so it can be a required check.

When the Node 22 leg fails, remove the version conflict at its source. Regenerating the lock with npm 10 doesn't hold: the next npm 11 write prunes the npm-10-only entries again. npm 10 also marks the `@cbor-extract/*` prebuilt binaries `dev`, so `build-tools/prune-shrinkwrap-dev.mjs` drops them from the published shrinkwrap.
