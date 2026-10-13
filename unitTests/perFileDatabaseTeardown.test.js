'use strict';

// Regression coverage for the per-file database teardown mocha.init.js installs — see
// perFileDatabaseTeardown.js. It only acts between files, so it is exercised in a mocha child.

const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, symlinkSync, readdirSync } = require('node:fs');
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
			rmSync(root, { recursive: true, force: true });
		}
	});
	it('fails empty and filtered runs through final teardown and removes their roots', function () {
		this.timeout(30000);
		const root = mkdtempSync(path.join(__dirname, 'envDir', 'guard-project-'));
		try {
			for (const entry of [
				'bin',
				'components',
				'config',
				'dataLayer',
				'json',
				'launchServiceScripts',
				'resources',
				'security',
				'server',
				'sqlTranslator',
				'static',
				'upgrade',
				'utility',
				'validation',
				'globals.js',
				'package.json',
			])
				cpSync(path.join(__dirname, '..', entry), path.join(root, entry), { recursive: true });
			mkdirSync(path.join(root, 'unitTests'));
			for (const entry of [
				'mocha.init.js',
				'perPidRoot.js',
				'perFileDatabaseTeardown.js',
				'nativeModules.mts',
				'rocksdbBindings.mts',
				'packageBindings.mts',
			])
				cpSync(path.join(__dirname, entry), path.join(root, 'unitTests', entry));
			symlinkSync(path.join(__dirname, '..', 'node_modules'), path.join(root, 'node_modules'), 'junction');
			mkdirSync(path.join(root, 'dist'));
			writeFileSync(path.join(root, 'dist', 'marker.cjs'), 'module.exports = true;');
			const fixture = path.join(root, 'probe.cjs');
			for (const filtered of [false, true]) {
				writeFileSync(
					fixture,
					"require('./dist/marker.cjs'); describe('guard', () => {" +
						(filtered ? "it('ignored', () => {});" : '') +
						'});'
				);
				const result = spawnSync(
					process.execPath,
					[
						require.resolve('mocha/bin/mocha.js'),
						fixture,
						'--no-config',
						'--require',
						path.join(root, 'unitTests/mocha.init.js'),
						'--exit',
						...(filtered ? ['--grep', 'DOES_NOT_MATCH'] : []),
					],
					{
						cwd: root,
						encoding: 'utf8',
						timeout: 10000,
						env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --conditions=typestrip` },
					}
				);
				assert.notStrictEqual(result.status, 0, result.stdout + result.stderr);
				assert.match(result.stderr, /Native unit tests loaded compiled core/);
				assert.deepStrictEqual(readdirSync(path.join(root, 'unitTests/envDir')), []);
			}
		} finally {
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
					path.join(__dirname, 'fixtures/nativeTeardown/afterRescan.mjs'),
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
			assert.match(result.stdout, /4 passing/);
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
