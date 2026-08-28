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
			if (message.event === 'logged-error' || message.event === 'unhandled-rejection') continue;
			throw new Error(`unexpected worker event ${message.event}: ${JSON.stringify(message)}`);
		}
	};
	const drain = () => queued.splice(0);
	return { worker, send, expect, drain };
}

// harper#1381: dropTable() on one thread drops the column families while another worker's
// source-fill cache write is still committing. dropTable() only drains its own thread's in-flight
// source commits, so the other worker's commit lands on the dropped column family; under
// RocksDB's default parallel OCC validation that write is admitted past conflict validation and
// fails inside the memtable insert, which latches a fatal background error on the whole
// environment ("Invalid column family specified in write batch" on every later write, including
// this drop's own catalog cleanup). Skipped until rocksdb-js serializes column-family drops
// against in-flight optimistic commits; it reproduces on the first iteration today.
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
			await new Promise((resolve) => setTimeout(resolve, 50));
			const workerEvents = fixture.drain().filter((message) => message.event !== 'logged-error');
			assert.deepEqual(workerEvents, [], `iteration ${i}: unexpected worker events`);
			assert.doesNotThrow(
				() => Probe.primaryStore.putSync('__probe__', { i }),
				`iteration ${i}: the environment must still accept writes`
			);
			assert.equal(Main.dbisDB.getSync(`${name}/`), undefined, `iteration ${i}: catalog rows must be removed`);
		}
	});
});
