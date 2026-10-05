'use strict';

// Regression coverage for the per-file database teardown mocha.init.js installs — see
// perFileDatabaseTeardown.js. It only acts between files, so it is exercised in a mocha child.

const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FIXTURES = path.join(__dirname, 'perFileDatabaseTeardownFixtures');

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
