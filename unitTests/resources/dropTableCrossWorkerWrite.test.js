'use strict';

require('../testUtils');
const assert = require('node:assert');
const path = require('node:path');
const { setupTestDBPath } = require('../testUtils');
const { table, database } = require('#src/resources/databases');
const { startWorker, onMessageByType, setMainIsWorker } = require('#js/server/threads/manageThreads');

const WORKER_FIXTURE = path.join(__dirname, 'dropTableCrossWorkerWrite-worker.js');
const MESSAGE_TYPE = 'drop-table-cross-worker-test';
const CONTROL_TYPE = 'drop-table-cross-worker-control';
const ITERATIONS = 20;

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
	let died = null;
	const receive = (message) => {
		if (message?.type !== MESSAGE_TYPE) return;
		const waiter = waiting.shift();
		if (waiter) waiter.resolve(message);
		else queued.push(message);
	};
	const fail = (error) => {
		died = error;
		for (const waiter of waiting.splice(0)) waiter.reject(error);
	};
	const next = () => {
		if (queued.length) return Promise.resolve(queued.shift());
		if (died) return Promise.reject(died);
		return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
	};
	const worker = startWorker(WORKER_FIXTURE, {
		name: 'drop-table-cross-worker-test',
		workerIndex: 1,
		threadCount: 2,
		autoRestart: false,
		onStarted(spawned) {
			spawned.on('message', receive);
			spawned.on('error', fail);
			spawned.on('exit', (code) => fail(new Error(`fixture worker exited with code ${code}`)));
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
		Probe.primaryStore.putSync('__probe__', { settled: true });
		assert.deepStrictEqual(catalogRows(Main, name), [], 'catalog rows must be removed');
	});

	it('leaves the storage environment writable and the catalog clean', async function () {
		assert.ok(
			'columnFamily.pendingReclaims' in (database({ database: 'test', table: null }).getStats?.() ?? {}),
			'the drop path no longer drains in-flight writes and needs a @harperfast/rocksdb-js that defers physical column-family drops behind admitted commits (rocksdb-js#850); bump the pin'
		);
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
			const unexpected = fixture.drain();
			assert.deepStrictEqual(unexpected, [], `iteration ${i}: unexpected worker events`);
			Probe.primaryStore.putSync('__probe__', { i });
			assert.deepStrictEqual(catalogRows(Main, name), [], `iteration ${i}: catalog rows must be removed`);
		}
		assert.ok(raced > 0, "no iteration caught the worker's commit in flight when the drop started");
	});
});
