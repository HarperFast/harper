'use strict';

require('../testUtils');
const assert = require('node:assert');
const path = require('node:path');
const { setupTestDBPath } = require('../testUtils');
const { table, database, databases, getDatabases, resetDatabases } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const {
	startWorker,
	onMessageByType,
	setMainIsWorker,
	getProcessInstanceId,
} = require('#js/server/threads/manageThreads');

const WORKER_FIXTURE = path.join(__dirname, 'dropTableQuiescence-worker.js');
const MESSAGE_TYPE = 'drop-table-quiescence-test';
const CONTROL_TYPE = 'drop-table-quiescence-control';

function defineTable(name, withEmbed = false) {
	const attributes = [{ name: 'id', isPrimaryKey: true }, { name: 'name' }];
	if (withEmbed) attributes.push({ name: 'vector', type: 'Array', embed: { source: 'name', model: 'unused' } });
	return table({ table: name, database: 'test', attributes });
}

function startDropWorker(workerIndex, threadCount) {
	const queued = new Map();
	const waiting = new Map();
	const errors = [];
	let fatalError;
	const nextEvent = (event) => {
		if (fatalError) return Promise.reject(fatalError);
		const prior = queued.get(event);
		if (prior?.length) return Promise.resolve(prior.shift());
		return new Promise((resolve, reject) => {
			let eventWaiters = waiting.get(event);
			if (!eventWaiters) waiting.set(event, (eventWaiters = []));
			eventWaiters.push({ resolve, reject });
		});
	};
	const fail = (error) => {
		fatalError = error instanceof Error ? error : new Error(String(error));
		for (const eventWaiters of waiting.values()) {
			for (const waiter of eventWaiters.splice(0)) waiter.reject(fatalError);
		}
	};
	const receive = (message) => {
		if (message.type !== MESSAGE_TYPE) return;
		if (message.event === 'command-error' || message.event === 'unhandled-rejection') {
			errors.push(message);
			fail(new Error(message.error));
			return;
		}
		const eventWaiters = waiting.get(message.event);
		if (eventWaiters?.length) eventWaiters.shift().resolve(message);
		else {
			let eventQueue = queued.get(message.event);
			if (!eventQueue) queued.set(message.event, (eventQueue = []));
			eventQueue.push(message);
		}
	};
	const booted = nextEvent('booted');
	const worker = startWorker(WORKER_FIXTURE, {
		name: 'drop-table-quiescence-test',
		workerIndex,
		threadCount,
		autoRestart: false,
		onStarted(spawnedWorker) {
			spawnedWorker.on('message', receive);
			spawnedWorker.once('error', fail);
		},
	});
	const send = (command, details = {}) => worker.postMessage({ type: CONTROL_TYPE, command, ...details });
	return {
		worker,
		booted,
		errors,
		nextEvent,
		send,
		async shutdown() {
			const shutdown = nextEvent('shutdown-complete').catch(() => undefined);
			const exited = new Promise((resolve) => worker.once('exit', resolve));
			send('shutdown');
			await Promise.race([shutdown, exited]);
			worker.wasShutdown = true;
			await worker.terminate();
		},
	};
}

describe('dropTable worker quiescence', function () {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		onMessageByType(MESSAGE_TYPE, () => {});
	});

	after(() => {
		setMainIsWorker(false);
	});

	it('drains an ordinary staged transaction before touching the column families', async function () {
		const Table = defineTable(`DropStagedTxn_${process.pid}_${Date.now()}`);
		const context = {};
		let staged;
		const stagedPromise = new Promise((resolve) => {
			staged = resolve;
		});
		let releaseTransaction;
		const transactionGate = new Promise((resolve) => {
			releaseTransaction = resolve;
		});
		const transactionPromise = transaction(context, async () => {
			await Table.put({ id: 'held', name: 'pending' }, context);
			staged();
			await transactionGate;
		});
		await stagedPromise;

		const originalDropSync = Table.primaryStore.dropSync;
		let destructivePhaseStarted = false;
		Table.primaryStore.dropSync = function (...args) {
			destructivePhaseStarted = true;
			return originalDropSync.apply(this, args);
		};
		const dropPromise = Table.dropTable();
		let earlyError;
		try {
			assert.strictEqual(
				destructivePhaseStarted,
				false,
				'dropTable() must suspend on the staged transaction before dropping its primary column family'
			);
		} catch (error) {
			earlyError = error;
		} finally {
			if (destructivePhaseStarted) transaction.abort(context);
			releaseTransaction();
		}
		const [transactionResult, dropResult] = await Promise.allSettled([transactionPromise, dropPromise]);
		if (earlyError) throw earlyError;
		if (transactionResult.status === 'rejected') throw transactionResult.reason;
		if (dropResult.status === 'rejected') throw dropResult.reason;
		assert.strictEqual(destructivePhaseStarted, true, 'dropTable() should continue after the transaction settles');
	});

	it('defers an unquiesced tombstone until the process that could hold stale handles is gone', function () {
		const tableName = `DropUnquiesced_${process.pid}_${Date.now()}`;
		const Table = defineTable(tableName);
		const dbisDb = database({ database: 'test', table: null }).dbisDb;
		const meta = dbisDb.getSync(`${tableName}/`);
		meta.dropping = true;
		meta.dropGeneration = 'unquiesced-test';
		meta.dropQuiesced = false;
		meta.dropProcessInstance = getProcessInstanceId();
		dbisDb.putSync(`${tableName}/`, meta);

		resetDatabases();
		assert.strictEqual(getDatabases().test?.[tableName], undefined, 'an unquiesced table must stay unloaded');
		assert.strictEqual(
			dbisDb.getSync(`${tableName}/`)?.dropping,
			true,
			'recovery must preserve the tombstone while stale handles can still exist in this process'
		);

		for (const index of Object.values(Table.indices)) index.close();
		Table.primaryStore.close();
		const priorProcessMeta = dbisDb.getSync(`${tableName}/`);
		priorProcessMeta.dropProcessInstance = `${getProcessInstanceId()}-prior`;
		dbisDb.putSync(`${tableName}/`, priorProcessMeta);
		delete databases.test?.[tableName];
		resetDatabases();
		assert.strictEqual(getDatabases().test?.[tableName], undefined);
		assert.strictEqual(
			database({ database: 'test', table: null }).dbisDb.getSync(`${tableName}/`),
			undefined,
			'a tombstone from a prior process should complete on restart'
		);
	});

	it('fails closed when a worker cannot quiesce', async function () {
		this.timeout(30000);
		const tableName = `DropQuiescenceFailure_${process.pid}_${Date.now()}`;
		const Table = defineTable(tableName);
		const rootStore = Table.primaryStore.rootStore;
		const dbisDb = database({ database: 'test', table: null }).dbisDb;
		let remote;
		try {
			remote = startDropWorker(1, 2);
			await remote.booted;
			remote.send('initialize', { table: tableName });
			const ready = await remote.nextEvent('ready');
			assert.strictEqual(ready.processInstanceId, getProcessInstanceId());
			remote.send('reject-prepare');
			await remote.nextEvent('reject-prepare-armed');

			const dropResult = await Table.dropTable().then(
				() => ({ outcome: 'resolved' }),
				(error) => ({ outcome: 'rejected', error })
			);
			assert.strictEqual(dropResult.outcome, 'rejected', 'a worker NACK must reject the live drop');
			assert.match(dropResult.error.message, /injected worker quiescence failure/);
			assert.ok(
				rootStore.columns.some((column) => column.startsWith(`${tableName}/`)),
				'no table column family may be dropped after a worker NACK'
			);
			const tombstone = dbisDb.getSync(`${tableName}/`);
			assert.strictEqual(tombstone?.dropping, true);
			assert.strictEqual(tombstone?.dropQuiesced, false);
			assert.deepStrictEqual(remote.errors, [], 'the expected NACK must not become an unhandled rejection');
		} finally {
			await remote?.shutdown();
			const tombstone = dbisDb.getSync(`${tableName}/`);
			if (tombstone?.dropping) {
				tombstone.dropProcessInstance = `${getProcessInstanceId()}-prior`;
				dbisDb.putSync(`${tableName}/`, tombstone);
				resetDatabases();
				getDatabases();
			}
		}
	});

	it('quiesces a remote source-cache write and recovers after the column family is already gone', async function () {
		this.timeout(30000);
		const tableName = `DropWorkerRace_${process.pid}_${Date.now()}`;
		const Table = defineTable(tableName, true);
		const dbisDb = database({ database: 'test', table: null }).dbisDb;
		const rootStore = Table.primaryStore.rootStore;
		let origin;
		let remote;

		try {
			remote = startDropWorker(1, 3);
			origin = startDropWorker(2, 3);
			await Promise.all([remote.booted, origin.booted]);
			remote.send('initialize', { table: tableName });
			origin.send('initialize', { table: tableName });
			const readyWorkers = await Promise.all([remote.nextEvent('ready'), origin.nextEvent('ready')]);
			assert.deepStrictEqual(
				readyWorkers.map((message) => message.processInstanceId),
				[getProcessInstanceId(), getProcessInstanceId()],
				'every worker must share the main thread process-incarnation marker'
			);
			remote.send('begin-source-read', { id: 'remote-source' });
			await remote.nextEvent('embed-entered');

			const prepareEntered = remote.nextEvent('prepare-entered').then(() => 'prepare');
			const dropResultPromise = origin.nextEvent('drop-result');
			origin.send('drop-table', { interruptAfterColumnFamilyDrop: true });
			const firstOutcome = await Promise.race([prepareEntered, dropResultPromise.then(() => 'drop-settled')]);
			assert.strictEqual(
				firstOutcome,
				'prepare',
				'the main-thread coordinator must put the remote worker in the pre-drop drain before the worker-originated drop settles'
			);

			remote.send('release-embed');
			const prepared = await remote.nextEvent('prepare-finished');
			assert.strictEqual(prepared.handlesClosed, true, 'the remote worker must close its table handle before ACK');
			await remote.nextEvent('source-read-resolved');

			const dropResult = await dropResultPromise;
			assert.strictEqual(
				dropResult.outcome,
				'rejected',
				'the injected interruption must fail the live drop after removing the primary column family'
			);
			assert.match(dropResult.error, /injected interruption/);

			assert.ok(
				!rootStore.columns.some((column) => column.startsWith(`${tableName}/`)),
				'the table column families must already be absent before recovery begins'
			);
			const tombstone = dbisDb.getSync(`${tableName}/`);
			assert.strictEqual(tombstone?.dropping, true, 'the failed catalog cleanup must retain the tombstone');
			assert.strictEqual(tombstone?.dropQuiesced, true, 'the tombstone must record completed worker quiescence');

			resetDatabases();
			const reloaded = getDatabases();
			assert.strictEqual(reloaded.test?.[tableName], undefined, 'recovery must not resurrect the table');
			assert.strictEqual(
				database({ database: 'test', table: null }).dbisDb.getSync(`${tableName}/`),
				undefined,
				'recovery must remove the tombstone after confirming the column families are absent'
			);
			assert.deepStrictEqual(
				[...origin.errors, ...remote.errors],
				[],
				'no worker rejection should escape the quiescence or recovery path'
			);
		} finally {
			await Promise.all([origin?.shutdown(), remote?.shutdown()]);
		}
	});
});
