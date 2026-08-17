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
// A canary only proves anything while its own pin lags what a broken install would
// actually resolve, so this also verifies each canary is still capable of catching a
// regression -- see verifyCanariesDiscriminate below -- rather than silently becoming a
// no-op once a lock bump happens to catch up. That's checked against the max version
// satisfying the dependency's declared range in package.json, not the registry's bare
// "latest" dist-tag: if the range excludes a newer major, a broken install could never
// reach it either, so comparing to absolute latest would flag a canary as fine when it
// has actually gone vacuous within the range that matters.
// Exact manifest specs remain in the installed-version check, but cannot discriminate a
// shrinkwrap install from a fresh resolution, so the discrimination check skips them.
//
// Usage: node check-shrinkwrap-pins.mjs <package-root>

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const CHECKED_DEPS = ['@harperfast/rocksdb-js', 'fastify', '@aws-sdk/client-s3'];
const REGISTRY_QUERY_ATTEMPTS = 3;
const retryWait = new Int32Array(new SharedArrayBuffer(4));

const pkgRoot = process.argv[2];
if (!pkgRoot) {
	console.error('::error::usage: check-shrinkwrap-pins.mjs <package-root>');
	process.exit(1);
}

const packed = JSON.parse(readFileSync(`${pkgRoot}/npm-shrinkwrap.packed.json`, 'utf8'));
if (packed.lockfileVersion !== 3) {
	console.error(
		`::error::npm-shrinkwrap.packed.json has lockfileVersion ${packed.lockfileVersion}, expected 3 -- this script assumes the v3 "packages" map layout and would silently check nothing (or throw confusingly) against a different format`
	);
	process.exit(1);
}
const manifest = JSON.parse(readFileSync(`${pkgRoot}/package.json`, 'utf8'));

let failed = false;
const pins = {};
for (const dep of CHECKED_DEPS) {
	const pinned = packed.packages?.[`node_modules/${dep}`]?.version;
	if (!pinned) {
		console.error(
			`::error::${dep} not found in the packed shrinkwrap -- the check itself needs updating, not just the image`
		);
		failed = true;
		continue;
	}
	const range = manifest.dependencies?.[dep];
	if (!range) {
		console.error(
			`::error::${dep} not found in package.json's dependencies -- the check itself needs updating, not just the image`
		);
		failed = true;
		continue;
	}
	pins[dep] = { pinned, range };

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

	const status = isExactVersion(range) ? 'shrinkwrap pin matches (exact manifest spec)' : 'shrinkwrap honored';
	console.log(`${status}: ${dep}@${installed} matches the packed pin`);
}

// A canary only proves the check works while its pin lags the registry -- if a lock bump
// ever lands every ranged canary on registry-latest, the pin-match loop above would pass on a
// reverted, broken Dockerfile just as easily as on this one. Fail loudly rather than let
// that happen silently.
verifyCanariesDiscriminate(pins);

process.exit(failed ? 1 : 0);

function verifyCanariesDiscriminate(pins) {
	const rangedPins = Object.fromEntries(Object.entries(pins).filter(([, { range }]) => !isExactVersion(range)));
	if (Object.keys(rangedPins).length === 0) {
		console.error(
			'::error::every checked canary has an exact declared version -- exact dependencies cannot distinguish a shrinkwrap install from a fresh resolution. Add a canary with a ranged manifest spec.'
		);
		failed = true;
		return;
	}

	// What a broken/reverted install would actually resolve to: the max version satisfying
	// the declared range, not the registry's bare "latest" dist-tag (which could be a newer
	// major the range excludes, and a broken install could never reach that either).
	const rangeLatest = {};
	const failedQueries = [];
	for (const [dep, { range }] of Object.entries(rangedPins)) {
		for (let attempt = 1; attempt <= REGISTRY_QUERY_ATTEMPTS; attempt++) {
			try {
				// `npm view <dep>@<range> version --json` returns every matching version, not
				// just the max, and the order isn't a documented contract (it can track
				// publish/insertion order rather than semver order, e.g. a backported patch
				// published after a newer minor) -- compare them ourselves rather than trust
				// the last array entry.
				const out = execFileSync('npm', ['view', `${dep}@${range}`, 'version', '--json'], { encoding: 'utf8' });
				const versions = JSON.parse(out);
				if (Array.isArray(versions) && versions.length === 0) {
					console.error(
						`::error::${dep}@${range} matches no published version -- correct the declared range in package.json`
					);
					failed = true;
					return;
				}
				rangeLatest[dep] = Array.isArray(versions)
					? versions.reduce((max, v) => (compareVersions(v, max) > 0 ? v : max))
					: versions;
				break;
			} catch (e) {
				console.log(
					`::warning::registry query attempt ${attempt}/${REGISTRY_QUERY_ATTEMPTS} failed for ${dep}@${range} (${e.message})`
				);
				if (attempt === REGISTRY_QUERY_ATTEMPTS) failedQueries.push(`${dep}@${range}`);
				else Atomics.wait(retryWait, 0, 0, 1000 * attempt);
			}
		}
	}
	const checkable = Object.keys(rangeLatest);
	const stillDiscriminates = checkable.some((dep) => rangeLatest[dep] !== pins[dep].pinned);
	if (stillDiscriminates) return;
	if (failedQueries.length > 0) {
		console.error(
			`::error title=Retry dependency canary check::Could not verify that the shrinkwrap canaries still discriminate after ${REGISTRY_QUERY_ATTEMPTS} registry query attempts for ${failedQueries.join(', ')}. Retry this job; if the error persists, check npm registry availability and confirm the listed package ranges match published versions.`
		);
		failed = true;
		return;
	}
	console.error(
		`::error::every checked canary (${checkable.join(', ')}) is now pinned at the latest version its declared range allows -- this check would pass even on a reverted, unpinned install. Pick a new canary whose shrinkwrap pin lags what its range allows.`
	);
	failed = true;
}

function isExactVersion(range) {
	return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(range);
}

// Numeric major.minor.patch comparison, ignoring any prerelease/build suffix -- sufficient
// for the stable releases this check compares (avoids depending on a semver-parsing
// package that may not be resolvable from this script's own location).
function compareVersions(a, b) {
	const partsA = a.split(/[-+]/)[0].split('.').map(Number);
	const partsB = b.split(/[-+]/)[0].split('.').map(Number);
	for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
		const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}
