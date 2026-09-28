#!/usr/bin/env node
// Verifies that an installed harper package honored the shrinkwrap frozen at pack time
// (npm-shrinkwrap.packed.json; npm rewrites the live npm-shrinkwrap.json to match whatever it
// installs). docker-smoke.yml runs it against the built image. Why it walks the whole tree,
// resolves fresh, and exempts only the react-native-fs residual: build-tools/DESIGN.md, "The
// image's shrinkwrap check must prove it could fail".
//
// Usage: node check-shrinkwrap-pins.mjs <package-root>

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The edge build-tools/prune-shrinkwrap-react-native.mjs severs.
const RESIDUAL_OPTIONAL_EDGE = 'react-native-fs';
const ROCKSDB_SINGLE_INSTANCE_DEPS = ['@harperfast/extended-iterable', 'msgpackr'];
const FRESH_RESOLVE_ATTEMPTS = 3;
const FRESH_RESOLVE_TIMEOUT_MS = 180_000;
const retryWait = new Int32Array(new SharedArrayBuffer(4));
const installedManifests = new Map();

const pkgRoot = process.argv[2];
if (!pkgRoot) {
	console.error('::error::usage: check-shrinkwrap-pins.mjs <package-root>');
	process.exit(1);
}

const packed = JSON.parse(readFileSync(`${pkgRoot}/npm-shrinkwrap.packed.json`, 'utf8'));
if (packed.lockfileVersion !== 3 || !packed.packages) {
	console.error(
		`::error::npm-shrinkwrap.packed.json has lockfileVersion ${packed.lockfileVersion}, expected 3 with a "packages" map -- this script assumes the v3 layout and would silently check nothing (or throw confusingly) against a different format`
	);
	process.exit(1);
}
const packedPackages = packed.packages;
const manifest = JSON.parse(readFileSync(`${pkgRoot}/package.json`, 'utf8'));
const requireFromRoot = createRequire(realpathSync(resolve(pkgRoot, 'package.json')));

let failed = false;

const freshPackages = resolveFresh();
const edges = walkPackedTree();
const exempt = installedClosure(edges.filter(isResidualRoot).map((edge) => edge.installedTarget));
verifyEdges();
verifyRocksDbDependencyAlignment();

process.exit(failed ? 1 : 0);

function verifyEdges() {
	let checked = 0;
	let discriminating = 0;
	let waived = 0;
	let violations = 0;
	const reportedDrift = new Set();
	for (const edge of edges) {
		const { packedTarget, installedTarget } = edge;
		// A lifted parent's packed edges describe a version that is not the one installed.
		if (
			exempt.has(edge.parentInstalled) &&
			installedManifest(edge.parentInstalled).version !== packedPackages[edge.parentPacked].version
		) {
			waived++;
			continue;
		}
		if (!packedTarget) {
			if (!installedTarget) continue;
			if (isResidualRoot(edge) || (edge.optional && exempt.has(installedTarget))) {
				waived++;
				continue;
			}
			console.error(
				`::error::${describe(edge)} resolved to ${installedManifest(installedTarget).version} but the packed shrinkwrap has no pin for it -- the shrinkwrap is missing an entry the install needed`
			);
			violations++;
			continue;
		}
		const pinned = packedPackages[packedTarget].version;
		if (!installedTarget) {
			if (edge.optional) continue;
			console.error(`::error::${describe(edge)} (pinned ${pinned}) is not installed`);
			violations++;
			continue;
		}
		const installed = installedManifest(installedTarget).version;
		if (exempt.has(installedTarget)) {
			waived++;
			if (installed !== pinned && !reportedDrift.has(installedTarget)) {
				reportedDrift.add(installedTarget);
				console.log(
					`::warning::${describe(edge)} is pinned at ${pinned} but installed at ${installed}, lifted by the unpinned react-native-fs subtree the image's npm install re-adds -- this pin is not enforced until that gap closes (dependencies.md, "Docker image")`
				);
			}
			continue;
		}
		if (installed !== pinned) {
			console.error(
				`::error::${describe(edge)} resolved to ${installed} but the packed shrinkwrap pins ${pinned} -- the image is not honoring npm-shrinkwrap.json (see #1960)`
			);
			violations++;
			continue;
		}
		checked++;
		if (edge.freshTarget && freshPackages[edge.freshTarget].version !== pinned) discriminating++;
	}
	console.log(
		`shrinkwrap pins: ${checked} dependency edges match, ${violations} do not; ${discriminating} matching edges resolve differently without the shrinkwrap; ${waived} edges in or into the react-native-fs residual (${exempt.size} installed packages) are not pin-checked`
	);
	if (violations > 0) {
		failed = true;
	} else if (!freshPackages) {
		console.error(
			`::error title=Retry shrinkwrap check::Could not resolve package.json without the shrinkwrap after ${FRESH_RESOLVE_ATTEMPTS} attempts, so there is no proof this check can tell a pinned install from an unpinned one. Retry this job; if the error persists, check npm/registry/runner configuration.`
		);
		failed = true;
	} else if (discriminating === 0) {
		console.error(
			'::error::no checked dependency edge resolves to a different version without the shrinkwrap -- this check would pass even on a reverted, unpinned install. Expected only right after a full lockfile refresh; it clears once any pinned dependency publishes a newer in-range version.'
		);
		failed = true;
	}
}

function isResidualRoot(edge) {
	return !edge.packedTarget && edge.installedTarget && edge.optional && edge.name === RESIDUAL_OPTIONAL_EDGE;
}

// What the same install would produce without the shrinkwrap, i.e. what a regression back to
// a fresh resolution would put in the image.
function resolveFresh() {
	for (let attempt = 1; attempt <= FRESH_RESOLVE_ATTEMPTS; attempt++) {
		const dir = mkdtempSync(join(tmpdir(), 'harper-fresh-resolve-'));
		try {
			writeFileSync(join(dir, 'package.json'), readFileSync(`${pkgRoot}/package.json`));
			execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
				cwd: dir,
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: FRESH_RESOLVE_TIMEOUT_MS,
			});
			const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
			if (lock.lockfileVersion !== 3 || !lock.packages?.['']) {
				throw new Error(`npm wrote lockfileVersion ${lock.lockfileVersion} without a v3 root entry`);
			}
			return lock.packages;
		} catch (e) {
			const detail = e.stderr?.toString().trim().split('\n').slice(-3).join(' | ') || e.message;
			console.log(`::warning::fresh resolve attempt ${attempt}/${FRESH_RESOLVE_ATTEMPTS} failed (${detail})`);
			if (attempt < FRESH_RESOLVE_ATTEMPTS) Atomics.wait(retryWait, 0, 0, 1000 * attempt);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
	return null;
}

function walkPackedTree() {
	const walked = [];
	const visited = new Set();
	const queue = [{ packedLocation: '', installedLocation: '', freshLocation: freshPackages ? '' : null }];
	while (queue.length > 0) {
		const { packedLocation, installedLocation, freshLocation } = queue.pop();
		const key = `${packedLocation}\0${installedLocation}`;
		if (visited.has(key)) continue;
		visited.add(key);
		// The root's edges come from the package.json npm actually installed from.
		const declaring = packedLocation === '' ? manifest : packedPackages[packedLocation];
		for (const [name, optional] of dependencyEdges(declaring)) {
			const edge = {
				parentPacked: packedLocation,
				parentInstalled: installedLocation,
				name,
				optional,
				packedTarget: resolveLocation(packedLocation, name, (location) => location in packedPackages),
				installedTarget: resolveLocation(installedLocation, name, isInstalled),
				freshTarget:
					freshLocation === null ? null : resolveLocation(freshLocation, name, (location) => location in freshPackages),
			};
			walked.push(edge);
			if (edge.packedTarget && edge.installedTarget) {
				queue.push({
					packedLocation: edge.packedTarget,
					installedLocation: edge.installedTarget,
					freshLocation: edge.freshTarget,
				});
			}
		}
	}
	return walked;
}

function installedClosure(roots) {
	const reached = new Set();
	const stack = [...roots];
	while (stack.length > 0) {
		const location = stack.pop();
		if (reached.has(location)) continue;
		reached.add(location);
		for (const [name] of dependencyEdges(installedManifest(location))) {
			const target = resolveLocation(location, name, isInstalled);
			if (target) stack.push(target);
		}
	}
	return reached;
}

function dependencyEdges(entry) {
	const edges = new Map();
	for (const name of Object.keys(entry.dependencies ?? {})) edges.set(name, false);
	for (const name of Object.keys(entry.optionalDependencies ?? {})) if (!edges.has(name)) edges.set(name, true);
	for (const name of Object.keys(entry.peerDependencies ?? {})) {
		const optionalPeer = entry.peerDependenciesMeta?.[name]?.optional === true;
		edges.set(name, (edges.get(name) ?? true) && optionalPeer);
	}
	return edges;
}

function resolveLocation(from, name, exists) {
	const segments = from === '' ? [] : from.split('/node_modules/');
	for (let depth = segments.length; depth >= 0; depth--) {
		const prefix = segments.slice(0, depth).join('/node_modules/');
		const candidate = `${prefix ? `${prefix}/` : ''}node_modules/${name}`;
		if (exists(candidate)) return candidate;
	}
	return null;
}

function installedManifest(location) {
	if (!installedManifests.has(location)) {
		const path = `${pkgRoot}/${location}/package.json`;
		let installed = null;
		if (existsSync(path)) {
			try {
				installed = JSON.parse(readFileSync(path, 'utf8'));
			} catch (e) {
				throw new Error(`${path} is not a readable package manifest: ${e.message}`, { cause: e });
			}
		}
		installedManifests.set(location, installed);
	}
	return installedManifests.get(location);
}

function isInstalled(location) {
	return installedManifest(location) !== null;
}

function describe(edge) {
	const parent = edge.parentInstalled;
	return `${parent === '' ? 'harper' : parent.slice(parent.lastIndexOf('node_modules/') + 'node_modules/'.length)} -> ${edge.name}`;
}

function verifyRocksDbDependencyAlignment() {
	let rocksdbManifest;
	let satisfies;
	let validRange;
	let requireFromRocksDb;
	const rocksdbManifestPath = `${pkgRoot}/node_modules/@harperfast/rocksdb-js/package.json`;
	try {
		rocksdbManifest = JSON.parse(readFileSync(rocksdbManifestPath, 'utf8'));
		({ satisfies, validRange } = requireFromRoot('semver'));
		requireFromRocksDb = createRequire(realpathSync(rocksdbManifestPath));
	} catch (e) {
		console.error(`::error::could not inspect rocksdb-js dependency alignment: ${e.message}`);
		failed = true;
		return;
	}

	for (const dep of ROCKSDB_SINGLE_INSTANCE_DEPS) {
		const rootSpec = manifest.dependencies?.[dep];
		const rocksdbSpec = rocksdbManifest.dependencies?.[dep];
		if (!isExactVersion(rootSpec)) {
			console.error(
				`::error::the root ${dep} spec must be exact, received ${rootSpec ?? 'missing'} -- update it with rocksdb-js to preserve one module instance`
			);
			failed = true;
			continue;
		}
		if (rocksdbSpec == null) {
			console.error(
				`::error::rocksdb-js no longer declares ${dep} -- update this check for the new dependency contract before publishing an image`
			);
			failed = true;
			continue;
		}
		if (validRange(rocksdbSpec) == null) {
			console.error(
				`::error::rocksdb-js declares ${dep} with unsupported range ${rocksdbSpec} -- use a semver range or update this check for the new dependency contract`
			);
			failed = true;
			continue;
		}
		if (!satisfies(rootSpec, rocksdbSpec)) {
			console.error(
				`::error::the root ${dep} pin ${rootSpec} is outside rocksdb-js ${rocksdbSpec} -- update these specs together to preserve one module instance`
			);
			failed = true;
			continue;
		}

		try {
			const installed = JSON.parse(readFileSync(`${pkgRoot}/node_modules/${dep}/package.json`, 'utf8')).version;
			if (installed !== rootSpec) {
				console.error(`::error::${dep} resolved to ${installed}, expected the aligned exact pin ${rootSpec}`);
				failed = true;
			}
		} catch (e) {
			console.error(`::error::could not inspect the root ${dep} instance: ${e.message}`);
			failed = true;
		}

		try {
			const rootResolution = realpathSync(requireFromRoot.resolve(dep));
			const rocksdbResolution = realpathSync(requireFromRocksDb.resolve(dep));
			if (rootResolution === rocksdbResolution) continue;

			const nestedManifest = `${pkgRoot}/node_modules/@harperfast/rocksdb-js/node_modules/${dep}/package.json`;
			if (existsSync(nestedManifest)) {
				let nestedVersion = 'unknown';
				try {
					nestedVersion = JSON.parse(readFileSync(nestedManifest, 'utf8')).version;
				} catch {}
				console.error(
					`::error::rocksdb-js loaded a nested ${dep}@${nestedVersion} -- root and rocksdb-js must share one module instance`
				);
			} else {
				console.error(
					`::error::rocksdb-js resolves ${dep} from ${rocksdbResolution}, but the root resolves it from ${rootResolution} -- both must share one module instance`
				);
			}
			failed = true;
		} catch (e) {
			console.error(`::error::could not resolve the shared ${dep} instance: ${e?.message ?? e}`);
			failed = true;
		}
	}
}

function isExactVersion(range) {
	return (
		typeof range === 'string' &&
		/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(range)
	);
}
