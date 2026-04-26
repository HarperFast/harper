/**
 * Benchmark: PrimaryRocksDatabase without caching vs with caching (WeakLRUCache + VT)
 *
 * Run via: npm run bench
 */
require('../testUtils');
const { setupTestDBPath } = require('../testUtils');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { PrimaryRocksDatabase } = require('#src/resources/PrimaryRocksDatabase');
const path = require('path');
const { mkdirSync } = require('fs');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const RECORD_COUNT = 2_000;
const WARMUP_ROUNDS = 2;

function opsPerSec(n, ms) {
	return ((n / ms) * 1000).toFixed(0).padStart(10);
}

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
		`  ${'Scenario'.padEnd(38)} | ${'cache: false'.padStart(13)}` +
			` | ${'cache: true'.padStart(15)}` +
			` | Speedup`
	);
	console.log('  ' + '-'.repeat(85));
}

describe('Benchmark: PrimaryRocksDatabase cache:false vs cache:true', function () {
	this.timeout(120_000);

	let noCacheDb, cachingDb, dbBase;
	const keys = Array.from({ length: RECORD_COUNT }, (_, i) => `record-${String(i).padStart(8, '0')}`);
	const values = keys.map((k, i) => ({ id: i, name: k, payload: 'x'.repeat(80) }));

	before(function () {
		if (isLMDB) return this.skip();
		setMainIsWorker(true);
		dbBase = path.join(setupTestDBPath(), 'bench');
		mkdirSync(dbBase, { recursive: true });

		const sharedOptions = { disableWAL: true, name: 'bench' };

		// No cache: PrimaryRocksDatabase without WeakLRUCache or VT
		noCacheDb = new PrimaryRocksDatabase(path.join(dbBase, 'nocache'), { ...sharedOptions, cache: false }).open();
		noCacheDb.put = noCacheDb.putSync;
		noCacheDb.remove = noCacheDb.removeSync;
		noCacheDb.initStore(noCacheDb);

		// With cache: PrimaryRocksDatabase with WeakLRUCache + VT (default)
		cachingDb = new PrimaryRocksDatabase(path.join(dbBase, 'caching'), sharedOptions).open();
		cachingDb.put = cachingDb.putSync;
		cachingDb.remove = cachingDb.removeSync;
		cachingDb.initStore(cachingDb);

		// Populate both stores with the same records
		for (let i = 0; i < RECORD_COUNT; i++) {
			noCacheDb.putSync(keys[i], values[i]);
			cachingDb.putSync(keys[i], values[i]);
		}
	});

	after(function () {
		noCacheDb?.close?.();
		cachingDb?.close?.();
	});

	it('prints benchmark results', function () {
		header();

		// ── 1. Cold read: first read of every key ──
		{
			for (let r = 0; r < WARMUP_ROUNDS; r++) {
				for (const k of keys) noCacheDb.getSync(k);
			}
			// flush cachingDb's WeakLRUCache by writing each key, then time the cold cache read
			for (let i = 0; i < RECORD_COUNT; i++) cachingDb.putSync(keys[i], values[i]);

			const t0 = performance.now();
			for (const k of keys) noCacheDb.getSync(k);
			const tPlain = performance.now() - t0;

			const t1 = performance.now();
			for (const k of keys) cachingDb.getSync(k);
			const tCold = performance.now() - t1;

			row('getSync — cold (cache miss)', tPlain, tCold);
		}

		// ── 2. Soft VT miss: second read (WeakLRUCache warm, VT not yet populated) ──
		{
			const t0 = performance.now();
			for (const k of keys) noCacheDb.getSync(k);
			const tPlain = performance.now() - t0;

			const t1 = performance.now();
			for (const k of keys) cachingDb.getSync(k);
			const tSoftMiss = performance.now() - t1;

			row('getSync — soft VT miss (2nd read)', tPlain, tSoftMiss);
		}

		// ── 3. VT fast-path: third+ read ──
		{
			const t0 = performance.now();
			for (const k of keys) noCacheDb.getSync(k);
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
			for (let i = 0; i < N; i++) noCacheDb.getSync(hotKey);
			const tPlain = performance.now() - t0;

			const t1 = performance.now();
			for (let i = 0; i < N; i++) cachingDb.getSync(hotKey);
			const tHot = performance.now() - t1;

			row('getSync — hot single key', tPlain, tHot);
		}

		// ── 5. Async get: VT fast-path ──
		{
			for (const k of keys) cachingDb.getSync(k); // ensure VT is populated

			const t0 = performance.now();
			for (const k of keys) noCacheDb.get(k);
			const tPlain = performance.now() - t0;

			const t1 = performance.now();
			for (const k of keys) cachingDb.get(k);
			const tVTHit = performance.now() - t1;

			row('get (async) — VT fast-path (sync fallback)', tPlain, tVTHit);
		}

		// ── 6. Write throughput (putSync) ──
		{
			const t0 = performance.now();
			for (let i = 0; i < RECORD_COUNT; i++) noCacheDb.putSync(keys[i], values[i]);
			const tPlain = performance.now() - t0;

			const t1 = performance.now();
			for (let i = 0; i < RECORD_COUNT; i++) cachingDb.putSync(keys[i], values[i]);
			const tCaching = performance.now() - t1;

			row('putSync', tPlain, tCaching);
		}

		console.log('');
		console.log(`  Records: ${RECORD_COUNT}, value size: ~80 bytes`);
		console.log(`  Speedup > 1x means cache:true is faster`);
		console.log('');
	});
});
