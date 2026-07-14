#!/usr/bin/env node
// Remove dev-only packages from the shrinkwrap that ships in the published package.
//
// npm generates the lockfile from the package.json manifest, so `npm prune --omit=dev`
// does NOT strip dev entries from it — prune only touches node_modules, not the lockfile.
// A published npm-shrinkwrap.json therefore vendors dev-only packages, including
// platform-specific optionals (e.g. @esbuild/* pulled in via tsx). When a consumer's
// lockfile is generated with npm 11, npm can fold that subtree in and drop the
// "optional" flag, so `npm ci` then fails everywhere with EBADPLATFORM. See #1780, #1782.
//
// This enforces the invariant that the published shrinkwrap describes only the production
// tree a consumer installs: every package reachable solely through devDependencies is
// marked "dev": true, so removing those (plus the root devDependencies block) leaves
// production and prod-optional (devOptional) entries untouched.
//
// Usage: node build-tools/prune-shrinkwrap-dev.mjs [npm-shrinkwrap.json]
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2] ?? 'npm-shrinkwrap.json';
const lock = JSON.parse(readFileSync(file, 'utf8'));

if (lock.lockfileVersion < 2 || !lock.packages) {
	throw new Error(`unsupported lockfileVersion ${lock.lockfileVersion}; expected >= 2 with a "packages" map`);
}

let removed = 0;
for (const key of Object.keys(lock.packages)) {
	if (key === '') continue; // root manifest node
	if (lock.packages[key].dev === true) {
		delete lock.packages[key];
		removed++;
	}
}
if (lock.packages['']?.devDependencies) delete lock.packages[''].devDependencies;

writeFileSync(file, JSON.stringify(lock, null, 2) + '\n');
console.log(`Pruned ${removed} dev-only entries from ${file}`);
