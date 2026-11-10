'use strict';

require('../testUtils');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');

const RECORD_CACHE_SIZE = 65536; // fixtures/recordCacheSizing.cjs
const THREADS_COUNT = 3;
// main and the HTTP workers; Windows runs one HTTP worker whatever threads.count says
const TABLE_THREADS = 1 + (process.platform === 'win32' ? 1 : THREADS_COUNT);

function nextPowerOfTwo(value) {
	let power = 1;
	while (power < value) power *= 2;
	return power;
}

function runFixture(scenario) {
	const root = mkdtempSync(join(__dirname, '../envDir/record-cache-sizing-'));
	try {
		const output = join(root, 'result.json');
		const child = spawnSync(
			process.execPath,
			[...process.execArgv, join(__dirname, 'fixtures/recordCacheSizing.cjs'), scenario, root, output],
			{ timeout: 60_000, encoding: 'utf8' }
		);
		assert.strictEqual(child.status, 0, `${child.stdout}\n${child.stderr}`);
		return { ...JSON.parse(readFileSync(output, 'utf8')), log: child.stdout + child.stderr };
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

(process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? describe.skip : describe)(
	'storage.recordCacheSize and the verification table',
	function () {
		this.timeout(120_000);

		it('sizes every record cache in a thread from the setting, whichever cache the thread built first', function () {
			const result = runFixture('configured');
			assert.deepStrictEqual(result.lruSizes, [RECORD_CACHE_SIZE / 4, RECORD_CACHE_SIZE / 4]);
			assert.strictEqual(result.sharedExpirer, true, 'one budget for every table in the thread');
			assert.deepStrictEqual(result.defaultExpirerLruSizes, [8192, 8192], "weak-lru-cache's own default is untouched");
		});

		it('sizes the verification table once, on main, from the cache size and the threads Harper starts', function () {
			const result = runFixture('configured');
			const expected = Math.max(131072, nextPowerOfTwo(2 * RECORD_CACHE_SIZE * TABLE_THREADS));
			assert.deepStrictEqual(result.verificationTableSets, [expected]);
			assert.deepStrictEqual(result.verificationTableSetsAfterUse, [expected], 'a later open does not ask again');
			assert.deepStrictEqual(result.worker.lruSizes, [RECORD_CACHE_SIZE / 4, RECORD_CACHE_SIZE / 4]);
			assert.strictEqual(result.worker.sharedExpirer, true);
			assert.deepStrictEqual(result.worker.verificationTableSets, [], 'a worker never sizes the table');
		});

		it('leaves the verification table at its default when storage.caching is false', function () {
			const result = runFixture('caching-off');
			assert.deepStrictEqual(result.verificationTableSets, []);
			assert.deepStrictEqual(result.verificationTableSetsAfterUse, []);
		});

		it('sizes the table on a later open when the first attempt failed for another reason', function () {
			const result = runFixture('config-error');
			assert.strictEqual(result.firstOpenError, 'injected config failure');
			const expected = Math.max(131072, nextPowerOfTwo(2 * RECORD_CACHE_SIZE * TABLE_THREADS));
			assert.deepStrictEqual(result.verificationTableSets, [expected, expected]);
			assert.deepStrictEqual(result.verificationTableSetsAfterUse, [expected, expected]);
		});

		it('opens normally, with the rest of its RocksDB settings, when the table was used before Harper sized it', function () {
			const result = runFixture('preused');
			assert.strictEqual(result.verificationTableSets.length, 1);
			assert.deepStrictEqual(result.verificationTableSetsAfterUse, result.verificationTableSets);
			assert.match(result.log, /Verification table keeps its size instead of \d+ entries/);
			assert.deepStrictEqual(
				result.writeBufferManager,
				{ bufferSize: 64 * 1024 ** 2, allowStall: true },
				"the open's other RocksDB settings still reached rocksdb-js"
			);
		});
	}
);
