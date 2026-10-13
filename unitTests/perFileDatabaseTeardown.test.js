'use strict';

// Regression coverage for the per-file database teardown mocha.init.js installs — see
// perFileDatabaseTeardown.js. It only acts between files, so it is exercised in a mocha child.

const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { nativeCoreGuard } = require('./nativeModules.mts');

const FIXTURES = path.join(__dirname, 'perFileDatabaseTeardownFixtures');

describe('native compiled-core guard', () => {
	it('reports compiled modules loaded after its first check, once', () => {
		const root = mkdtempSync(path.join(__dirname, 'envDir', 'native-guard-'));
		const compiled = path.join(root, 'dist', 'marker.cjs');
		try {
			mkdirSync(path.dirname(compiled));
			writeFileSync(compiled, 'module.exports = true;');
			const guard = nativeCoreGuard(path.join(root, 'resources', 'databases.ts'));
			guard();
			require(compiled);
			assert.throws(guard, (error) => error.message.includes(compiled));
			guard();
			assert.doesNotThrow(nativeCoreGuard(path.join(root, 'dist', 'resources', 'databases.js')));
		} finally {
			delete require.cache[compiled];
			rmSync(root, { recursive: true, force: true });
		}
	});
});

function runFixtures(storageEngine) {
	return spawnSync(
		process.execPath,
		[
			require.resolve('mocha/bin/mocha.js'),
			path.join(FIXTURES, 'createsDatabases.js'),
			path.join(FIXTURES, 'checksDatabases.js'),
		],
		{
			cwd: path.join(__dirname, '..'),
			env: { ...process.env, HARPER_STORAGE_ENGINE: storageEngine },
			encoding: 'utf8',
			timeout: 110000,
		}
	);
}

describe('native ESM database teardown', () => {
	for (const storageEngine of ['rocksdb', 'lmdb']) {
		it(`drops an ESM-imported ${storageEngine} database between files`, function () {
			this.timeout(30000);
			const result = spawnSync(
				process.execPath,
				[
					require.resolve('mocha/bin/mocha.js'),
					path.join(__dirname, 'fixtures/nativeTeardown/create.mjs'),
					path.join(__dirname, 'fixtures/nativeTeardown/close.mjs'),
					path.join(__dirname, 'fixtures/nativeTeardown/check.mjs'),
					'--no-config',
					'--require',
					path.join(__dirname, 'mocha.init.js'),
					'--exit',
				],
				{
					cwd: path.join(__dirname, '..'),
					encoding: 'utf8',
					timeout: 25000,
					env: {
						...process.env,
						NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --conditions=typestrip`,
						HARPER_STORAGE_ENGINE: storageEngine,
					},
				}
			);
			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
			assert.match(result.stdout, /3 passing/);
		});
	}
});

describe('per-file database teardown', () => {
	it('drops what a RocksDB file created before the next file runs, and nothing else', function () {
		this.timeout(120000);
		const result = runFixtures('rocksdb');
		assert.strictEqual(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stdout, /\b10 passing\b/);
	});

	it('drops what an LMDB file created before the next file runs, and nothing else', function () {
		this.timeout(120000);
		const result = runFixtures('lmdb');
		assert.strictEqual(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stdout, /\b9 passing\b/);
		assert.match(result.stdout, /\b1 pending\b/);
	});
});
