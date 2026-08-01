#!/usr/bin/env node
// Compares installed dependency versions in an extracted harper package against the
// shrinkwrap pins frozen at pack time (npm-shrinkwrap.packed.json). Used by
// docker-smoke.yml to prove the image's install actually honored the shrinkwrap rather
// than re-resolving fresh -- comparing against the live npm-shrinkwrap.json would be
// vacuous, since npm rewrites that file in place to match whatever it installs.
//
// Canary-based rather than whole-tree: a whole-tree comparison was tried and reverted.
// It's permanently red today because the still-open react-native-fs gap
// (dependencies.md, "Docker image") makes npm re-resolve that subtree fresh on every
// build -- and that isn't confined to dead react-native code. @endo/static-module-record
// is a real production dependency (used by the SES sandbox, security/jsLoader.ts) that
// also needs @babel/parser, @babel/traverse and @babel/types, so a whole-tree comparison
// correctly flags those as mismatched too: this is live drift risk in a security-relevant
// parser, not harmless collateral, and it's a second concrete reason (beyond rocksdb-js)
// the react-native gap needs closing, not just a reason this particular check is noisy.
// Revisit the whole-tree comparison once that gap is closed.
//
// A canary only proves anything while its own pin lags the registry, so this also
// verifies each canary is still capable of catching a regression -- see
// verifyCanariesDiscriminate below -- rather than silently becoming a no-op once a lock
// bump happens to land on registry-latest.
//
// Usage: node check-shrinkwrap-pins.mjs <package-root>

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const CHECKED_DEPS = ['@harperfast/rocksdb-js', 'fastify'];

const pkgRoot = process.argv[2];
if (!pkgRoot) {
	console.error('::error::usage: check-shrinkwrap-pins.mjs <package-root>');
	process.exit(1);
}

const packed = JSON.parse(readFileSync(`${pkgRoot}/npm-shrinkwrap.packed.json`, 'utf8'));

let failed = false;
const pins = {};
for (const dep of CHECKED_DEPS) {
	const pinned = packed.packages?.[`node_modules/${dep}`]?.version;
	if (!pinned) {
		console.error(`::error::${dep} not found in the packed shrinkwrap -- the check itself needs updating, not just the image`);
		failed = true;
		continue;
	}
	pins[dep] = pinned;

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

// A canary only proves the check works while its pin lags the registry -- if a lock bump
// ever lands both canaries on registry-latest, the pin-match loop above would pass on a
// reverted, broken Dockerfile just as easily as on this one. Fail loudly rather than let
// that happen silently.
verifyCanariesDiscriminate(pins);

process.exit(failed ? 1 : 0);

function verifyCanariesDiscriminate(pins) {
	const latest = {};
	for (const [dep, pinned] of Object.entries(pins)) {
		try {
			latest[dep] = execFileSync('npm', ['view', dep, 'version'], { encoding: 'utf8' }).trim();
		} catch (e) {
			console.log(`::warning::could not check registry-latest for ${dep} (${e.message}) -- skipping discrimination check for it`);
		}
	}
	const checkable = Object.keys(latest);
	if (checkable.length === 0) {
		console.log('::warning::registry unreachable -- could not verify the canary set still discriminates');
		return;
	}
	const stillDiscriminates = checkable.some((dep) => latest[dep] !== pins[dep]);
	if (!stillDiscriminates) {
		console.error(
			`::error::every checked canary (${checkable.join(', ')}) is now pinned at registry-latest -- this check would pass even on a reverted, unpinned install. Pick a new canary whose shrinkwrap pin lags its registry latest.`
		);
		failed = true;
	}
}
