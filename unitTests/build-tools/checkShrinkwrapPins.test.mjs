import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = join(root, 'build-tools/check-shrinkwrap-pins.mjs');
const alignedDependencies = {
	'@harperfast/extended-iterable': '1.0.3',
	'msgpackr': '2.0.6',
};
const rocksdbDependencyRanges = {
	'@harperfast/extended-iterable': '^1.0.3',
	'msgpackr': '^2.0.6',
};

describe('shrinkwrap pin check', function () {
	it('passes when every edge honors its pin and a transitive pin lags a fresh resolve', async function () {
		const result = await runTree(baseTree());
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /7 dependency edges match, 0 do not; 1 matching edges resolve differently/);
	});

	it('fails when a transitive dependency resolves fresh instead of to its pin', async function () {
		const tree = baseTree();
		tree.installed['node_modules/avvio'].version = '1.1.0';
		const result = await runTree(tree);
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /fastify -> avvio resolved to 1\.1\.0 but the packed shrinkwrap pins 1\.0\.0/);
		assert.doesNotMatch(result.stderr, /would pass even on a reverted/);
	});

	it('fails when a direct dependency resolves away from its pin', async function () {
		const tree = baseTree();
		tree.installed['node_modules/fastify'].version = '1.2.0';
		const result = await runTree(tree);
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /harper -> fastify resolved to 1\.2\.0 but the packed shrinkwrap pins 1\.0\.0/);
	});

	it('accepts a pinned package npm hoisted out of its packed nested location', async function () {
		const tree = baseTree();
		delete tree.packed['node_modules/avvio'];
		tree.packed['node_modules/fastify/node_modules/avvio'] = { version: '1.0.0' };
		tree.fresh = structuredClone(tree.packed);
		tree.fresh['node_modules/fastify/node_modules/avvio'].version = '1.1.0';
		const result = await runTree(tree);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /1 matching edges resolve differently/);
	});

	it('waives drift the react-native-fs residual causes, with a warning for a shared pin', async function () {
		const result = await runTree(withResidual(baseTree()));
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(
			result.stdout,
			/::warning::@endo\/static-module-record -> @babel\/parser is pinned at 1\.0\.0 but installed at 1\.2\.0/
		);
		assert.match(
			result.stdout,
			/edges in or into the react-native-fs residual \(6 installed packages\) are not pin-checked/
		);
	});

	it('still enforces the required children of a residual-shared pin the residual did not lift', async function () {
		const tree = withResidual(baseTree());
		delete tree.installed['node_modules/ms'];
		const result = await runTree(tree);
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /debug -> ms \(pinned 1\.0\.0\) is not installed/);
	});

	it('fails when a required child of an installed optional dependency is missing', async function () {
		const tree = baseTree();
		tree.manifest.optionalDependencies = { bufferutil: '1.0.0' };
		tree.packed['node_modules/bufferutil'] = {
			version: '1.0.0',
			optional: true,
			dependencies: { 'node-gyp-build': '^1.0.0' },
		};
		tree.packed['node_modules/node-gyp-build'] = { version: '1.0.0', optional: true };
		tree.installed['node_modules/bufferutil'] = { version: '1.0.0', dependencies: { 'node-gyp-build': '^1.0.0' } };
		const result = await runTree(tree);
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /bufferutil -> node-gyp-build \(pinned 1\.0\.0\) is not installed/);
	});

	it('still fails on drift outside the residual subtree', async function () {
		const tree = withResidual(baseTree());
		tree.installed['node_modules/avvio'].version = '1.1.0';
		const result = await runTree(tree);
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /fastify -> avvio resolved to 1\.1\.0/);
	});

	it('fails when a required dependency has no packed pin, rather than exempting it', async function () {
		const tree = baseTree();
		delete tree.packed['node_modules/fastify'];
		const result = await runTree(tree);
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /harper -> fastify resolved to 1\.0\.0 but the packed shrinkwrap has no pin for it/);
	});

	it('only exempts the severed react-native-fs edge, not any unpinned optional edge', async function () {
		const tree = baseTree();
		tree.packed['node_modules/fastify'].optionalDependencies = { 'other-native': '^1.0.0' };
		tree.installed['node_modules/other-native'] = { version: '1.0.0' };
		const result = await runTree(tree);
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /fastify -> other-native resolved to 1\.0\.0 but the packed shrinkwrap has no pin/);
	});

	it('fails when a shared pin inside the residual reach is missing from the shrinkwrap', async function () {
		const tree = withResidual(baseTree());
		delete tree.packed['node_modules/@babel/parser'];
		const result = await runTree(tree);
		assert.strictEqual(result.status, 1);
		assert.match(
			result.stderr,
			/@endo\/static-module-record -> @babel\/parser resolved to 1\.2\.0 but the packed shrinkwrap has no pin/
		);
	});

	it('skips an absent optional platform package but fails on an absent required one', async function () {
		const tree = baseTree();
		tree.packed['node_modules/@harperfast/rocksdb-js'].optionalDependencies = { 'rocksdb-js-other-platform': '1.0.0' };
		tree.packed['node_modules/rocksdb-js-other-platform'] = { version: '1.0.0', optional: true };
		assert.strictEqual((await runTree(tree)).status, 0);

		delete tree.installed['node_modules/avvio'];
		const result = await runTree(tree);
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /fastify -> avvio \(pinned 1\.0\.0\) is not installed/);
	});

	it('fails when no checked edge would resolve differently without the shrinkwrap', async function () {
		const tree = baseTree();
		tree.fresh = structuredClone(tree.packed);
		const result = await runTree(tree);
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /no checked dependency edge resolves to a different version without the shrinkwrap/);
	});

	it('does not count a discriminating edge inside the residual subtree', async function () {
		const tree = withResidual(baseTree());
		tree.fresh['node_modules/avvio'].version = '1.0.0';
		const result = await runTree(tree);
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /no checked dependency edge resolves to a different version/);
	});

	it('does not count an edge the fresh tree lacks as discriminating', async function () {
		const tree = baseTree();
		delete tree.fresh['node_modules/avvio'];
		const result = await runTree(tree);
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /no checked dependency edge resolves to a different version/);
	});

	it('resolves fresh from a copy of package.json with no shrinkwrap beside it', async function () {
		const fixture = await createFixture(baseTree());
		try {
			const result = runCheck(fixture);
			assert.strictEqual(result.status, 0, result.stderr);
			const invocations = await npmInvocations(fixture);
			assert.deepStrictEqual(invocations, [
				'install --package-lock-only --ignore-scripts --no-audit --no-fund|package.json',
			]);
		} finally {
			await fixture.cleanup();
		}
	});

	it('retries a transient fresh-resolve failure', async function () {
		const fixture = await createFixture(baseTree(), { failedAttempts: 1 });
		try {
			const result = runCheck(fixture);
			assert.strictEqual(result.status, 0, result.stderr);
			assert.match(result.stdout, /fresh resolve attempt 1\/3 failed \(npm error network ETIMEDOUT\)/);
			assert.strictEqual((await npmInvocations(fixture)).length, 2);
		} finally {
			await fixture.cleanup();
		}
	});

	it('fails with a retry-specific error when every fresh-resolve attempt fails', async function () {
		const fixture = await createFixture(baseTree(), { failedAttempts: 3 });
		try {
			const result = runCheck(fixture);
			assert.strictEqual(result.status, 1);
			assert.match(result.stderr, /::error title=Retry shrinkwrap check::/);
			assert.match(result.stderr, /after 3 attempts/);
			assert.match(result.stderr, /Retry this job/);
			assert.match(result.stdout, /7 dependency edges match, 0 do not/);
			assert.strictEqual((await npmInvocations(fixture)).length, 3);
		} finally {
			await fixture.cleanup();
		}
	});

	it('treats a lockfile of the wrong shape as a failed attempt, not as proof', async function () {
		const fixture = await createFixture(baseTree(), { freshLockfileVersion: 2 });
		try {
			const result = runCheck(fixture);
			assert.strictEqual(result.status, 1);
			assert.match(result.stdout, /npm wrote lockfileVersion 2 without a v3 root entry/);
			assert.match(result.stderr, /::error title=Retry shrinkwrap check::/);
		} finally {
			await fixture.cleanup();
		}
	});

	it('refuses a packed shrinkwrap that is not lockfileVersion 3', async function () {
		const tree = baseTree();
		tree.packedLockfileVersion = 2;
		const result = await runTree(tree);
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /npm-shrinkwrap\.packed\.json has lockfileVersion 2, expected 3/);
	});

	it('accepts the real manifest encoder pins against the installed rocksdb-js ranges', async function () {
		const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
		const rocksdbManifestPath = join(root, 'node_modules/@harperfast/rocksdb-js/package.json');
		let rocksdbManifest;
		try {
			rocksdbManifest = JSON.parse(await readFile(rocksdbManifestPath, 'utf8'));
		} catch (error) {
			assert.fail(
				`the installed rocksdb-js manifest is required at ${rocksdbManifestPath}: ${error?.message ?? error}`
			);
		}
		const tree = baseTree();
		for (const dependency of Object.keys(alignedDependencies)) {
			const version = manifest.dependencies[dependency];
			tree.manifest.dependencies[dependency] = version;
			tree.packed[`node_modules/${dependency}`].version = version;
			tree.installed[`node_modules/${dependency}`].version = version;
		}
		tree.installed['node_modules/@harperfast/rocksdb-js'].dependencies = rocksdbManifest.dependencies;
		const result = await runTree(tree);
		assert.strictEqual(result.status, 0, result.stderr);
	});

	it('fails when a root encoder pin is outside the rocksdb-js range', async function () {
		const tree = baseTree();
		tree.installed['node_modules/@harperfast/rocksdb-js'].dependencies = {
			...rocksdbDependencyRanges,
			msgpackr: '^3.0.0',
		};
		const result = await runTree(tree);
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /root msgpackr pin 2\.0\.6 is outside rocksdb-js \^3\.0\.0/);
	});

	it('fails when rocksdb-js no longer declares a guarded dependency', async function () {
		const tree = baseTree();
		tree.installed['node_modules/@harperfast/rocksdb-js'].dependencies = { '@harperfast/extended-iterable': '^1.0.3' };
		const result = await runTree(tree);
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /rocksdb-js no longer declares msgpackr/);
	});

	it('fails when rocksdb-js uses a non-semver dependency spec', async function () {
		const tree = baseTree();
		tree.installed['node_modules/@harperfast/rocksdb-js'].dependencies = {
			...rocksdbDependencyRanges,
			msgpackr: 'workspace:*',
		};
		const result = await runTree(tree);
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /rocksdb-js declares msgpackr with unsupported range workspace:\*/);
	});

	it('fails when a root encoder spec is not exact', async function () {
		const tree = baseTree();
		tree.manifest.dependencies.msgpackr = '^2.0.6';
		const result = await runTree(tree);
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /root msgpackr spec must be exact, received \^2\.0\.6/);
	});

	for (const [dependency, version] of Object.entries(alignedDependencies)) {
		it(`fails when rocksdb-js installs a nested ${dependency} instance`, async function () {
			const tree = baseTree();
			tree.installed[`node_modules/@harperfast/rocksdb-js/node_modules/${dependency}`] = { version, main: 'index.js' };
			const result = await runTree(tree);
			assert.strictEqual(result.status, 1);
			assert(result.stderr.includes(`rocksdb-js loaded a nested ${dependency}@${version}`), result.stderr);
		});
	}

	it('follows a linked rocksdb-js package to detect its private dependency instance', async function () {
		const fixture = await createFixture(baseTree());
		try {
			const rocksdbDir = join(fixture.packageRoot, 'node_modules/@harperfast/rocksdb-js');
			const linkedDir = join(dirname(fixture.packageRoot), 'linked-rocksdb-js');
			const linkedMsgpackrDir = join(linkedDir, 'node_modules/msgpackr');
			await mkdir(linkedMsgpackrDir, { recursive: true });
			await writeFile(
				join(linkedDir, 'package.json'),
				JSON.stringify({ version: '1.0.0', dependencies: rocksdbDependencyRanges })
			);
			await writeFile(join(linkedMsgpackrDir, 'package.json'), JSON.stringify({ version: '2.0.6', main: 'index.js' }));
			await writeFile(join(linkedMsgpackrDir, 'index.js'), '');
			await rm(rocksdbDir, { recursive: true, force: true });
			await symlink(linkedDir, rocksdbDir, 'junction');

			const result = runCheck(fixture);
			assert.strictEqual(result.status, 1);
			assert.match(result.stderr, /rocksdb-js loaded a nested msgpackr@2\.0\.6/);
		} finally {
			await fixture.cleanup();
		}
	});

	it('reports divergent resolutions outside the classic nested layout', async function () {
		const fixture = await createFixture(baseTree());
		try {
			const rocksdbDir = join(fixture.packageRoot, 'node_modules/@harperfast/rocksdb-js');
			const linkedDir = join(dirname(fixture.packageRoot), 'linked-rocksdb-js');
			const siblingMsgpackrDir = join(dirname(linkedDir), 'node_modules/msgpackr');
			await mkdir(linkedDir, { recursive: true });
			await mkdir(siblingMsgpackrDir, { recursive: true });
			await writeFile(
				join(linkedDir, 'package.json'),
				JSON.stringify({ version: '1.0.0', dependencies: rocksdbDependencyRanges })
			);
			await writeFile(join(siblingMsgpackrDir, 'package.json'), JSON.stringify({ version: '2.0.6', main: 'index.js' }));
			await writeFile(join(siblingMsgpackrDir, 'index.js'), '');
			await rm(rocksdbDir, { recursive: true, force: true });
			await symlink(linkedDir, rocksdbDir, 'junction');

			const result = runCheck(fixture);
			assert.strictEqual(result.status, 1);
			assert.match(result.stderr, /rocksdb-js resolves msgpackr from .* but the root resolves it from /);
		} finally {
			await fixture.cleanup();
		}
	});
});

function baseTree() {
	const packed = {
		'node_modules/@harperfast/rocksdb-js': { version: '1.0.0', dependencies: rocksdbDependencyRanges },
		'node_modules/@harperfast/extended-iterable': { version: '1.0.3' },
		'node_modules/msgpackr': { version: '2.0.6' },
		'node_modules/fastify': { version: '1.0.0', dependencies: { avvio: '^1.0.0' } },
		'node_modules/avvio': { version: '1.0.0' },
	};
	const installed = structuredClone(packed);
	installed['node_modules/@harperfast/extended-iterable'].main = 'index.js';
	installed['node_modules/msgpackr'].main = 'index.js';
	const fresh = structuredClone(packed);
	fresh['node_modules/avvio'].version = '1.1.0';
	return {
		manifest: {
			dependencies: { '@harperfast/rocksdb-js': '1.0.0', ...alignedDependencies, 'fastify': '^1.0.0' },
		},
		packed,
		installed,
		fresh,
	};
}

// The lifted @babel/parser no longer needs the @babel/types its pin declared; debug is shared
// with the residual but not lifted; react is an optional peer only the residual installs.
function withResidual(tree) {
	const residualPacked = {
		'node_modules/alasql': { version: '1.0.0', optionalDependencies: { 'react-native-fs': '^2.20.0' } },
		'node_modules/@endo/static-module-record': {
			version: '1.0.0',
			dependencies: { '@babel/parser': '^1.0.0', 'debug': '^1.0.0' },
			peerDependencies: { react: '*' },
			peerDependenciesMeta: { react: { optional: true } },
		},
		'node_modules/@babel/parser': { version: '1.0.0', dependencies: { '@babel/types': '^1.0.0' } },
		'node_modules/@babel/types': { version: '1.0.0' },
		'node_modules/debug': { version: '1.0.0', dependencies: { ms: '^1.0.0' } },
		'node_modules/ms': { version: '1.0.0' },
	};
	const residualInstalled = {
		...structuredClone(residualPacked),
		'node_modules/@babel/parser': { version: '1.2.0' },
		'node_modules/react-native-fs': { version: '2.20.0', peerDependencies: { 'react-native': '*' } },
		'node_modules/react-native': {
			version: '0.80.0',
			dependencies: { '@babel/parser': '^1.2.0', 'debug': '^1.0.0', 'react': '*' },
		},
		'node_modules/react': { version: '19.0.0' },
	};
	delete residualInstalled['node_modules/@babel/types'];
	Object.assign(tree.manifest.dependencies, { 'alasql': '1.0.0', '@endo/static-module-record': '1.0.0' });
	Object.assign(tree.packed, residualPacked);
	Object.assign(tree.installed, residualInstalled);
	Object.assign(tree.fresh, structuredClone(residualInstalled));
	return tree;
}

async function runTree(tree) {
	const fixture = await createFixture(tree);
	try {
		return runCheck(fixture);
	} finally {
		await fixture.cleanup();
	}
}

async function createFixture(tree, { failedAttempts = 0, freshLockfileVersion = 3 } = {}) {
	const tempDir = await mkdtemp(join(tmpdir(), 'harper-shrinkwrap-pins-'));
	const packageRoot = join(tempDir, 'package');
	const binDir = join(tempDir, 'bin');
	const npmLog = join(tempDir, 'npm.log');
	const freshLock = join(tempDir, 'fresh-lock.json');
	await mkdir(binDir, { recursive: true });
	await cp(join(root, 'node_modules/semver'), join(packageRoot, 'node_modules/semver'), { recursive: true });
	await writeFile(join(packageRoot, 'package.json'), JSON.stringify(tree.manifest));
	await writeFile(
		join(packageRoot, 'npm-shrinkwrap.packed.json'),
		JSON.stringify({ lockfileVersion: tree.packedLockfileVersion ?? 3, packages: { '': {}, ...tree.packed } })
	);
	for (const [location, manifest] of Object.entries(tree.installed)) {
		const dir = join(packageRoot, location);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, 'package.json'), JSON.stringify(manifest));
		if (manifest.main) await writeFile(join(dir, manifest.main), '');
	}
	await writeFile(
		freshLock,
		JSON.stringify(
			freshLockfileVersion === 3 ? { lockfileVersion: 3, packages: { '': {}, ...tree.fresh } } : { lockfileVersion: 2 }
		)
	);
	await writeFile(npmLog, '');
	await writeFile(
		join(binDir, 'npm'),
		`#!/bin/sh
printf '%s|%s\\n' "$*" "$(ls -A | tr '\\n' ' ' | sed 's/ $//')" >> "$NPM_LOG"
if [ "$(wc -l < "$NPM_LOG")" -le "$FAILED_ATTEMPTS" ]; then
  echo 'npm error network ETIMEDOUT' >&2
  exit 1
fi
cp "$FRESH_LOCK" package-lock.json
`
	);
	await chmod(join(binDir, 'npm'), 0o755);
	return {
		binDir,
		packageRoot,
		npmLog,
		freshLock,
		failedAttempts,
		cleanup: () => rm(tempDir, { recursive: true, force: true }),
	};
}

async function npmInvocations(fixture) {
	return (await readFile(fixture.npmLog, 'utf8')).split('\n').filter(Boolean);
}

function runCheck(fixture) {
	return spawnSync(process.execPath, [script, fixture.packageRoot], {
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${fixture.binDir}:${process.env.PATH}`,
			NPM_LOG: fixture.npmLog,
			FRESH_LOCK: fixture.freshLock,
			FAILED_ATTEMPTS: String(fixture.failedAttempts),
		},
	});
}
