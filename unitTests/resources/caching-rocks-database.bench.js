/**
 * Benchmark: PrimaryRocksDatabase without caching vs with caching (WeakLRUCache + VT)
 *
 * Run via: npm run bench
 */
require('../testUtils');
const { setupTestDBPath } = require('../testUtils');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { PrimaryRocksDatabase } = require('#src/resources/PrimaryRocksDatabase');
const { RecordEncoder, recordUpdater } = require('#src/resources/RecordEncoder');
const { Transaction } = require('@harperfast/rocksdb-js');
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
		`  ${'Scenario'.padEnd(38)} | ${'cache: false'.padStart(13)}` + ` | ${'cache: true'.padStart(15)}` + ` | Speedup`
	);
	console.log('  ' + '-'.repeat(85));
}

describe('Benchmark: PrimaryRocksDatabase cache:false vs cache:true', function () {
	this.timeout(120_000);

	let noCacheDb, cachingDb, noCacheUpdate, cachingUpdate, dbBase;
	const keys = Array.from({ length: RECORD_COUNT }, (_, i) => `record-${String(i).padStart(8, '0')}`);
	const values = keys.map((k, i) => ({ id: i, name: k, payload: 'x'.repeat(80) }));

	before(function () {
		if (isLMDB) return this.skip();
		setMainIsWorker(true);
		dbBase = path.join(setupTestDBPath(), 'bench');
		mkdirSync(dbBase, { recursive: true });

		const primaryOptions = {
			disableWAL: true,
			name: 'bench',
			encoder: { Encoder: RecordEncoder },
		};

		// No cache: PrimaryRocksDatabase without WeakLRUCache or VT
		noCacheDb = new PrimaryRocksDatabase(path.join(dbBase, 'nocache'), { ...primaryOptions, cache: false }).open();
		noCacheDb.initStore(noCacheDb);
		noCacheUpdate = recordUpdater(noCacheDb, 1, null);

		// With cache: PrimaryRocksDatabase with WeakLRUCache + VT (default)
		cachingDb = new PrimaryRocksDatabase(path.join(dbBase, 'caching'), primaryOptions).open();
		cachingDb.initStore(cachingDb);
		cachingUpdate = recordUpdater(cachingDb, 1, null);

		// Populate both stores using recordUpdater so values carry encoded version bytes.
		// Versions must be in the Date.now() range (~1e12) so RecordEncoder recognises
		// the 0x42 first byte of the float64 and strips the version prefix on decode.
		let version = Date.now();
		for (let i = 0; i < RECORD_COUNT; i++) {
			noCacheUpdate(keys[i], values[i], null, version, 0, false);
			cachingUpdate(keys[i], values[i], null, version, 0, false);
			version++;
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
			let flushVersion = Date.now() + 100_000;
			for (let i = 0; i < RECORD_COUNT; i++) cachingUpdate(keys[i], values[i], null, flushVersion++, 0, false);

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

		// ── 6. Write throughput (recordUpdater) ──
		{
			let v = Date.now() + 200_000;
			const t0 = performance.now();
			for (let i = 0; i < RECORD_COUNT; i++) noCacheUpdate(keys[i], values[i], null, v++, 0, false);
			const tPlain = performance.now() - t0;

			const t1 = performance.now();
			for (let i = 0; i < RECORD_COUNT; i++) cachingUpdate(keys[i], values[i], null, v++, 0, false);
			const tCaching = performance.now() - t1;

			row('recordUpdater put', tPlain, tCaching);
		}

		// ── Transactional reads ──
		// Harper's reads happen inside RocksTransactions (every request opens a read
		// txn via DatabaseTransaction.getReadTxn). These scenarios read through a
		// per-sweep RocksTransaction so the VT path exercised is the transactional
		// one: Transaction::GetSync, with the snapshot-current fast-skip in
		// vtPopulateIfSettled (a current snapshot avoids the extra latest-read).
		//
		// Versions are written safely in the past so the single-accessible-version
		// gate permits VT population even while the read txn's snapshot is open —
		// without this, the gate (correctly) suppresses caching while a snapshot
		// older than the latest write is live.
		const readSweepInTxn = (db) => {
			const txn = new Transaction(db.store);
			try {
				for (const k of keys) db.getSync(k, { transaction: txn });
			} finally {
				txn.abort();
			}
		};

		// ── 7. Transactional cold read + gated populate ──
		{
			// Rewrite (flush WeakLRUCache + clear VT slots) with settled past versions.
			let settled = Date.now() - 5_000;
			for (let i = 0; i < RECORD_COUNT; i++) {
				noCacheUpdate(keys[i], values[i], null, settled, 0, false);
				cachingUpdate(keys[i], values[i], null, settled, 0, false);
				settled++;
			}

			const t0 = performance.now();
			readSweepInTxn(noCacheDb);
			const tPlain = performance.now() - t0;

			const t1 = performance.now();
			readSweepInTxn(cachingDb); // cold: cache miss → reads + gated VT populate
			const tCold = performance.now() - t1;

			row('getSync — transactional cold (populate)', tPlain, tCold);
		}

		// ── 8. Transactional VT fast-path (cache + VT now warm from scenario 7) ──
		{
			const t0 = performance.now();
			readSweepInTxn(noCacheDb);
			const tPlain = performance.now() - t0;

			const t1 = performance.now();
			readSweepInTxn(cachingDb); // warm: VT verifyVersion hit → FRESH, no DB read
			const tTxnHit = performance.now() - t1;

			row('getSync — transactional VT fast-path', tPlain, tTxnHit);
		}

		console.log('');
		console.log(`  Records: ${RECORD_COUNT}, value size: ~80 bytes`);
		console.log(`  Speedup > 1x means cache:true is faster`);
		console.log('');
	});
});
