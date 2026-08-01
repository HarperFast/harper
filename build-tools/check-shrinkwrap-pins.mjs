#!/usr/bin/env node
// Compares installed dependency versions in an extracted harper package against the
// shrinkwrap pins frozen at pack time (npm-shrinkwrap.packed.json). Used by
// docker-smoke.yml to prove the image's install actually honored the shrinkwrap rather
// than re-resolving fresh -- comparing against the live npm-shrinkwrap.json would be
// vacuous, since npm rewrites that file in place to match whatever it installs.
//
// Canary-based rather than whole-tree: a whole-tree comparison was tried and reverted --
// it's permanently red today, because the still-open react-native-fs gap (dependencies.md,
// "Docker image") causes npm to re-resolve that whole subtree fresh on every build, which
// drags shared transitive deps like @babel/* along at newer versions than the shrinkwrap
// pins for them. (The Dockerfile also strips devDependencies from its own extracted copy
// before installing, which closes a *second*, independent source of the same kind of
// drift -- confirmed empirically that removed a chunk of the mismatches but not all of
// them; the remainder is the react-native chain.) A canary only proves the regression
// it's checking for while its own pin lags the registry (see #1960's follow-up
// discussion), so revisit this once the react-native gap is closed and a whole-tree
// comparison stops false-positiving.
//
// Usage: node check-shrinkwrap-pins.mjs <package-root>

import { readFileSync } from 'node:fs';

const CHECKED_DEPS = ['@harperfast/rocksdb-js', 'fastify'];

const pkgRoot = process.argv[2];
if (!pkgRoot) {
	console.error('::error::usage: check-shrinkwrap-pins.mjs <package-root>');
	process.exit(1);
}

const packed = JSON.parse(readFileSync(`${pkgRoot}/npm-shrinkwrap.packed.json`, 'utf8'));

let failed = false;
for (const dep of CHECKED_DEPS) {
	const pinned = packed.packages?.[`node_modules/${dep}`]?.version;
	if (!pinned) {
		console.error(`::error::${dep} not found in the packed shrinkwrap -- the check itself needs updating, not just the image`);
		failed = true;
		continue;
	}

	let installed;
	try {
		installed = JSON.parse(readFileSync(`${pkgRoot}/node_modules/${dep}/package.json`, 'utf8')).version;
	} catch (e) {
		console.error(`::error::${dep} is not installed: ${e.message}`);
		failed = true;
		continue;
	}

	if (installed !== pinned) {
		console.error(
			`::error::${dep} resolved to ${installed} but the packed shrinkwrap pins ${pinned} -- the image is not honoring npm-shrinkwrap.json (see #1960)`
		);
		failed = true;
		continue;
	}

	console.log(`shrinkwrap honored: ${dep}@${installed} matches the packed pin`);
}

process.exit(failed ? 1 : 0);
