/**
 * Benchmark: write-path cost of the origin-closed floor (harper-pro#922).
 *
 * A/B in one process: the reservation and the choke-point check are swapped for no-ops through the
 * module's exports, so both sides run the same build, tables and keys. Also reports the reservation
 * pair on a raw handle and one certifier round with persistence.
 *
 * Run via: npm run bench, or `npx mocha unitTests/resources/originClosedFloor.bench.js`.
 */
require('../testUtils');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { Transaction } = require('@harperfast/rocksdb-js');
const floor = require('#src/resources/originClosedFloor');
const { persistOriginClosedFloor } = require('#src/resources/auditStore');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const WRITES = 20_000;
const CONCURRENCY = 16;
const ROUNDS = 3;

function perSecond(n, ms) {
	return ((n / ms) * 1000).toFixed(0).padStart(9);
}

describe('Benchmark: origin-closed floor write overhead', function () {
	this.timeout(600_000);
	let Tbl, rootStore, auditStore;

	before(function () {
		if (isLMDB) return this.skip();
		setupTestDBPath();
		setMainIsWorker(true);
		Tbl = table({
			table: 'OriginFloorBench',
			database: 'test',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }, { name: 'payload' }],
		});
		rootStore = Tbl.primaryStore.rootStore;
		auditStore = rootStore.auditStore;
	});

	function withFloor(enabled, run) {
		const original = { reserve: floor.reserveLocalKey, reserved: floor.isReservedForLocalAppend };
		if (!enabled) {
			floor.reserveLocalKey = () => 0;
			floor.isReservedForLocalAppend = () => true;
		}
		return Promise.resolve()
			.then(run)
			.finally(() => {
				floor.reserveLocalKey = original.reserve;
				floor.isReservedForLocalAppend = original.reserved;
			});
	}

	async function sequential(prefix) {
		const start = performance.now();
		for (let n = 0; n < WRITES; n++) await Tbl.put({ id: `${prefix}-${n}`, n, payload: 'x'.repeat(64) });
		return performance.now() - start;
	}

	async function concurrent(prefix) {
		const start = performance.now();
		for (let n = 0; n < WRITES; n += CONCURRENCY) {
			const batch = [];
			for (let k = 0; k < CONCURRENCY; k++)
				batch.push(Tbl.put({ id: `${prefix}-${n + k}`, n, payload: 'x'.repeat(64) }));
			await Promise.all(batch);
		}
		return performance.now() - start;
	}

	it('sequential and concurrent puts, floor on versus bypassed', async () => {
		const results = { on: { seq: [], conc: [] }, off: { seq: [], conc: [] } };
		await withFloor(true, () => sequential('warm'));
		for (let round = 0; round < ROUNDS; round++) {
			results.on.seq.push(await withFloor(true, () => sequential(`on-seq-${round}`)));
			results.off.seq.push(await withFloor(false, () => sequential(`off-seq-${round}`)));
			results.on.conc.push(await withFloor(true, () => concurrent(`on-conc-${round}`)));
			results.off.conc.push(await withFloor(false, () => concurrent(`off-conc-${round}`)));
		}
		const best = (times) => Math.min(...times);
		console.log('');
		console.log(`  ${'Scenario'.padEnd(26)} | ${'floor on'.padStart(14)} | ${'floor off'.padStart(14)} | overhead`);
		console.log('  ' + '-'.repeat(70));
		for (const [label, key] of [
			['sequential put', 'seq'],
			[`${CONCURRENCY}-way concurrent put`, 'conc'],
		]) {
			const on = best(results.on[key]);
			const off = best(results.off[key]);
			const perWrite = ((on - off) / WRITES) * 1e6;
			console.log(
				`  ${label.padEnd(26)} | ${perSecond(WRITES, on)} op/s | ${perSecond(WRITES, off)} op/s | ` +
					`${(((on - off) / off) * 100).toFixed(1).padStart(5)}% (${perWrite.toFixed(0)} ns/write)`
			);
		}
	});

	it('reservation pair on a raw handle, and one certifier round', async () => {
		const handle = new Transaction(Tbl.primaryStore.store);
		const pairs = 200_000;
		const start = performance.now();
		for (let n = 0; n < pairs; n++) {
			floor.reserveLocalKey(rootStore, handle);
			floor.releaseLocalKey(handle);
		}
		const pairMs = performance.now() - start;
		handle.abort();
		const rounds = 200;
		const roundStart = performance.now();
		for (let n = 0; n < rounds; n++) {
			const certified = floor.certifyOriginFloor(rootStore);
			if (certified !== undefined) {
				persistOriginClosedFloor(auditStore, certified);
				floor.publishOriginFloor(rootStore, certified);
			}
		}
		const roundMs = performance.now() - roundStart;
		console.log('');
		console.log(`  reserve+release pair          ${((pairMs / pairs) * 1e6).toFixed(0).padStart(6)} ns`);
		console.log(`  certify + persist + publish   ${((roundMs / rounds) * 1e3).toFixed(0).padStart(6)} µs per round`);
	});
});
