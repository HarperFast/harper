/**
 * Benchmark: RocksDatabase (no VT/cache) vs CachingRocksDatabase (WeakLRUCache + VT)
 *
 * Run via: npm run bench (or directly with mocha --file unitTests/resources/caching-rocks-database.bench.js)
 */
require('../testUtils');
const { setupTestDBPath } = require('../testUtils');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { RocksDatabase } = require('@harperfast/rocksdb-js');
const { CachingRocksDatabase } = require('#src/resources/CachingRocksDatabase');
const { RecordEncoder, handleLocalTimeForGets } = require('#src/resources/RecordEncoder');
const path = require('path');
const { mkdirSync } = require('fs');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const RECORD_COUNT = 2_000;
const WARMUP_ROUNDS = 2; // reads before timing (to prime block cache)

/** Format a number of ops/sec nicely */
function opsPerSec(n, ms) {
	return ((n / ms) * 1000).toFixed(0).padStart(10);
}

/** Print a formatted results row */
function row(label, plain, caching) {
	const ratio = (plain / caching).toFixed(2);
	console.log(
		`  ${label.padEnd(38)} | ${opsPerSec(RECORD_COUNT, plain)} op/s` +
			` | ${opsPerSec(RECORD_COUNT, caching)} op/s` +
			` | ${ratio.padStart(5)}x`
	);
}

function header() {
	console.log('');
	console.log(
		`  ${'Scenario'.padEnd(38)} | ${'RocksDatabase'.padStart(13)}` +
			` | ${'CachingRocksDB'.padStart(15)}` +
			` | Speedup`
	);
	console.log('  ' + '-'.repeat(85));
}

describe('Benchmark: RocksDatabase vs CachingRocksDatabase', function () {
	this.timeout(120_000);

	let plainDb, cachingDb, dbBase;
	const keys = Array.from({ length: RECORD_COUNT }, (_, i) => `record-${String(i).padStart(8, '0')}`);
	const values = keys.map((k, i) => ({ id: i, name: k, payload: 'x'.repeat(80) }));

	before(function () {
		if (isLMDB) return this.skip();
		setMainIsWorker(true);
		dbBase = path.join(setupTestDBPath(), 'bench');
		mkdirSync(dbBase, { recursive: true });

		const encoderOptions = {
			encoder: { Encoder: RecordEncoder },
			disableWAL: true,
			name: 'bench',
		};

		// Plain RocksDatabase: standard msgpack + RecordEncoder, no VT or cache
		plainDb = RocksDatabase.open(path.join(dbBase, 'plain'), encoderOptions);
		plainDb.put = plainDb.putSync;
		plainDb.remove = plainDb.removeSync;
		plainDb.encoder.name = 'bench';
		handleLocalTimeForGets(plainDb, plainDb);

		// CachingRocksDatabase: same encoder + VT + WeakLRUCache
		cachingDb = new CachingRocksDatabase(path.join(dbBase, 'caching'), encoderOptions).open();
		cachingDb.put = cachingDb.putSync;
		cachingDb.remove = cachingDb.removeSync;
		cachingDb.encoder.name = 'bench';
		handleLocalTimeForGets(cachingDb, cachingDb);

		// Populate both stores with the same records
		for (let i = 0; i < RECORD_COUNT; i++) {
			plainDb.putSync(keys[i], values[i]);
			cachingDb.putSync(keys[i], values[i]);
		}
	});

	after(function () {
		plainDb?.close?.();
		cachingDb?.close?.();
	});

	it('prints benchmark results', function () {
		header();

		// ── 1. Cold read: first read of every key (neither cache nor VT populated) ──
		{
			// prime block cache with WARMUP_ROUNDS reads so disk I/O doesn't dominate
			for (let r = 0; r < WARMUP_ROUNDS; r++) {
				for (const k of keys) plainDb.getSync(k);
			}
			// flush CachingRocksDatabase's WeakLRUCache by writing each key
			// (putSync deletes from cache), then read once to populate WeakLRUCache
			for (const k of keys) cachingDb.putSync(k, values[keys.indexOf(k)]);

			const t0 = performance.now();
			for (const k of keys) plainDb.getSync(k);
			const tPlain = performance.now() - t0;

			// cold caching read: WeakLRUCache was cleared by the putSync above
			const t1 = performance.now();
			for (const k of keys) cachingDb.getSync(k);
			const tCold = performance.now() - t1;

			row('getSync — cold (cache miss)', tPlain, tCold);
		}

		// ── 2. Soft VT miss: second read (cache warm, VT not yet populated) ──
		{
			const t0 = performance.now();
			for (const k of keys) plainDb.getSync(k);
			const tPlain = performance.now() - t0;

			// second read: WeakLRUCache is warm, passes expectedVersion, soft VT miss
			// → DB read happens but FRESH is returned and VT slot populated
			const t1 = performance.now();
			for (const k of keys) cachingDb.getSync(k);
			const tSoftMiss = performance.now() - t1;

			row('getSync — soft VT miss (2nd read)', tPlain, tSoftMiss);
		}

		// ── 3. VT fast-path: third+ read (VT populated, no DB access) ──
		{
			const t0 = performance.now();
			for (const k of keys) plainDb.getSync(k);
			const tPlain = performance.now() - t0;

			const t1 = performance.now();
			for (const k of keys) cachingDb.getSync(k);
			const tVTHit = performance.now() - t1;

			row('getSync — VT fast-path (3rd+ read)', tPlain, tVTHit);
		}

		// ── 4. Repeated single key (hot key) ──
		{
			const hotKey = keys[0];
			const N = RECORD_COUNT;

			const t0 = performance.now();
			for (let i = 0; i < N; i++) plainDb.getSync(hotKey);
			const tPlain = performance.now() - t0;

			const t1 = performance.now();
			for (let i = 0; i < N; i++) cachingDb.getSync(hotKey);
			const tHot = performance.now() - t1;

			row('getSync — hot single key', tPlain, tHot);
		}

		// ── 5. Async get: VT fast-path ──
		// (measuring the async path separately since it goes through a different code path)
		{
			// Ensure VT is populated (do a sync read first)
			for (const k of keys) cachingDb.getSync(k);

			const t0 = performance.now();
			for (const k of keys) plainDb.get(k);
			const tPlain = performance.now() - t0;

			const t1 = performance.now();
			for (const k of keys) cachingDb.get(k);
			const tVTHit = performance.now() - t1;

			row('get (async) — VT fast-path (sync fallback)', tPlain, tVTHit);
		}

		// ── 6. Write throughput (putSync) ──
		{
			const t0 = performance.now();
			for (let i = 0; i < RECORD_COUNT; i++) plainDb.putSync(keys[i], values[i]);
			const tPlain = performance.now() - t0;

			const t1 = performance.now();
			for (let i = 0; i < RECORD_COUNT; i++) cachingDb.putSync(keys[i], values[i]);
			const tCaching = performance.now() - t1;

			row('putSync', tPlain, tCaching);
		}

		console.log('');
		console.log(`  Records: ${RECORD_COUNT}, value size: ~80 bytes`);
		console.log(`  Speedup > 1x means CachingRocksDatabase is faster`);
		console.log('');
	});
});
