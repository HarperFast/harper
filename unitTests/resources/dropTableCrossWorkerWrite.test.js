'use strict';

require('../testUtils');
const assert = require('node:assert');
const path = require('node:path');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { startWorker, onMessageByType, setMainIsWorker } = require('#js/server/threads/manageThreads');

const WORKER_FIXTURE = path.join(__dirname, 'dropTableCrossWorkerWrite-worker.js');
const MESSAGE_TYPE = 'drop-table-cross-worker-test';
const CONTROL_TYPE = 'drop-table-cross-worker-control';
const ITERATIONS = 20;
// The one error the worker may log: its cache write lost to the drop and was rejected before it
// reached RocksDB's write path. Anything else the worker logs fails the test.
const CONTAINED_COMMIT_LOSS = /^Error committing cache update .*(Could not access column family|column family .*dropp)/;

function defineTable(name) {
	return table({
		table: name,
		database: 'test',
		audit: true,
		attributes: [
			{ name: 'id', isPrimaryKey: true },
			{ name: 'blob', type: 'Blob' },
		],
	});
}

function startFixtureWorker() {
	const queued = [];
	const waiting = [];
	const loggedErrors = [];
	const receive = (message) => {
		if (message?.type !== MESSAGE_TYPE) return;
		const waiter = waiting.shift();
		if (waiter) waiter(message);
		else queued.push(message);
	};
	const next = () =>
		queued.length ? Promise.resolve(queued.shift()) : new Promise((resolve) => waiting.push(resolve));
	const worker = startWorker(WORKER_FIXTURE, {
		name: 'drop-table-cross-worker-test',
		workerIndex: 1,
		threadCount: 2,
		autoRestart: false,
		onStarted(spawned) {
			spawned.on('message', receive);
		},
	});
	const send = (command, details = {}) => worker.postMessage({ type: CONTROL_TYPE, command, ...details });
	const expect = async (event) => {
		for (;;) {
			const message = await next();
			if (message.event === event) return message;
			if (message.event === 'logged-error') loggedErrors.push(message);
			else throw new Error(`unexpected worker event ${message.event}: ${JSON.stringify(message)}`);
		}
	};
	const drain = () => [...loggedErrors.splice(0), ...queued.splice(0)];
	// A round-trip through the worker: everything it reported before answering has arrived.
	const sync = async () => {
		send('ping');
		await expect('pong');
	};
	return { worker, send, expect, drain, sync };
}

function catalogRows(Table, name) {
	return [...Table.dbisDB.getRange({ start: `${name}/`, end: `${name}0` })].map(({ key }) => key);
}

describe('dropTable racing a cross-worker source-fill commit', function () {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;
	this.timeout(120000);
	let fixture;
	let Probe;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		onMessageByType(MESSAGE_TYPE, () => {});
		fixture = startFixtureWorker();
		await fixture.expect('booted');
		Probe = defineTable('CrossDropProbe');
	});

	after(async () => {
		await fixture?.worker?.terminate?.();
		setMainIsWorker(false);
	});

	// Whatever the worker reported before a test began is not that test's signal.
	beforeEach(() => fixture.drain());

	it("drops cleanly once the worker's source-fill commit has settled", async () => {
		const name = 'CrossDropSettled';
		const Main = defineTable(name);
		fixture.send('define', { table: name });
		await fixture.expect('defined');
		fixture.send('get', { id: 'settled' });
		await fixture.expect('get-resolved');
		await fixture.expect('commit-settled');
		await Main.dropTable();
		await fixture.sync();
		assert.deepStrictEqual(fixture.drain(), [], 'unexpected worker events');
		assert.doesNotThrow(() => Probe.primaryStore.putSync('__probe__', { settled: true }));
		assert.deepStrictEqual(catalogRows(Main, name), [], 'catalog rows must be removed');
	});

	// harper#1381: a column family must not be dropped while a commit naming it is between conflict
	// validation and its write, because RocksDB latches that write's failure as a fatal background
	// error on the whole environment. dropTable() drains only its own thread's source-fill commits,
	// so a worker's in-flight commit can still land on the dropped family. Skipped until rocksdb-js#806
	// serializes drops against in-flight commits; on the current binding it fails on iteration 0.
	it.skip('leaves the storage environment writable and the catalog clean', async () => {
		let raced = 0;
		for (let i = 0; i < ITERATIONS; i++) {
			const name = `CrossDrop${i}`;
			const Main = defineTable(name);
			fixture.send('define', { table: name });
			await fixture.expect('defined');
			fixture.send('get', { id: i });
			await fixture.expect('get-resolved');
			// The record lock is shared across threads and held until the worker's cache write settles.
			// Sampled on the dropping thread right before the drop, it shows the race was exercised at
			// least once; it cannot show that a given iteration overlapped.
			if (Main.primaryStore.hasLock(i)) raced++;
			await Main.dropTable();
			await fixture.expect('commit-settled');
			const unexpected = fixture
				.drain()
				.filter((message) => message.event !== 'logged-error' || !CONTAINED_COMMIT_LOSS.test(message.message));
			assert.deepStrictEqual(unexpected, [], `iteration ${i}: unexpected worker events`);
			assert.doesNotThrow(
				() => Probe.primaryStore.putSync('__probe__', { i }),
				`iteration ${i}: the environment must still accept writes`
			);
			assert.deepStrictEqual(catalogRows(Main, name), [], `iteration ${i}: catalog rows must be removed`);
		}
		assert.ok(raced > 0, "no iteration caught the worker's commit in flight when the drop started");
	});
});
