#!/usr/bin/env node
// Compares installed dependency versions in an extracted harper package against the
// shrinkwrap pins frozen at pack time (npm-shrinkwrap.packed.json). Used by
// docker-smoke.yml to prove the image's install actually honored the shrinkwrap rather
// than re-resolving fresh -- comparing against the live npm-shrinkwrap.json would be
// vacuous, since npm rewrites that file in place to match whatever it installs.
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
