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
			if (message.event === 'logged-error') continue;
			throw new Error(`unexpected worker event ${message.event}: ${JSON.stringify(message)}`);
		}
	};
	const drain = () => queued.splice(0);
	return { worker, send, expect, drain };
}

// harper#1381: a column family must not be dropped while a commit naming it is between conflict
// validation and its write, because RocksDB latches that write's failure as a fatal background
// error on the whole environment. dropTable() drains only its own thread's source-fill commits,
// so a worker's in-flight commit can still land on the dropped family. Skipped until rocksdb-js#806
// serializes drops against in-flight commits; on the current binding it fails on iteration 0.
describe('dropTable racing a cross-worker source-fill commit', function () {
	this.timeout(120000);
	let fixture;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		onMessageByType(MESSAGE_TYPE, () => {});
		fixture = startFixtureWorker();
		await fixture.expect('booted');
	});

	after(async () => {
		await fixture?.worker?.terminate?.();
	});

	it.skip('leaves the storage environment writable and the catalog clean', async () => {
		const Probe = defineTable('CrossDropProbe');
		for (let i = 0; i < ITERATIONS; i++) {
			const name = `CrossDrop${i}`;
			const Main = defineTable(name);
			fixture.send('define', { table: name });
			await fixture.expect('defined');
			fixture.send('get', { id: i });
			await fixture.expect('get-resolved');
			await Main.dropTable();
			await fixture.expect('commit-settled');
			const workerEvents = fixture.drain().filter((message) => message.event !== 'logged-error');
			assert.deepStrictEqual(workerEvents, [], `iteration ${i}: unexpected worker events`);
			assert.doesNotThrow(
				() => Probe.primaryStore.putSync('__probe__', { i }),
				`iteration ${i}: the environment must still accept writes`
			);
			const catalogRows = [...Main.dbisDB.getRange({ start: `${name}/`, end: `${name}0` })].map(({ key }) => key);
			assert.deepStrictEqual(catalogRows, [], `iteration ${i}: catalog rows must be removed`);
		}
	});
});
