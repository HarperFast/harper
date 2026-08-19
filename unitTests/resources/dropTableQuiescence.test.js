'use strict';

require('../testUtils');
const assert = require('node:assert');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
const {
	table,
	database,
	databases,
	getDatabases,
	prepareTableDrop,
	resetDatabases,
} = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { DatabaseTransaction } = require('#src/resources/DatabaseTransaction');
const env = require('#src/utility/environment/environmentManager');
const terms = require('#src/utility/hdbTerms');
const { ITC_EVENT_TYPES, TABLE_DROP_PREPARE_OPERATION, THREAD_TYPES } = terms;
const {
	broadcastWithStrictAcknowledgement,
	startWorker,
	onMessageByType,
	setMainIsWorker,
	getProcessInstanceId,
} = require('#js/server/threads/manageThreads');

const WORKER_FIXTURE = path.join(__dirname, 'dropTableQuiescence-worker.js');
const UNREADY_WORKER_FIXTURE = path.join(__dirname, 'dropTableUnready-worker.js');
const MESSAGE_TYPE = 'drop-table-quiescence-test';
const CONTROL_TYPE = 'drop-table-quiescence-control';
let testPath;

function defineTable(name, withEmbed = false, databaseName = 'test') {
	const attributes = [{ name: 'id', isPrimaryKey: true }, { name: 'name' }];
	if (withEmbed) attributes.push({ name: 'vector', type: 'Array', embed: { source: 'name', model: 'unused' } });
	return table({ table: name, database: databaseName, attributes });
}

function startDropWorker(workerIndex, threadCount, name = 'drop-table-quiescence-test') {
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
		if (
			message.event === 'command-error' ||
			message.event === 'unhandled-rejection' ||
			message.event === 'read-rejected' ||
			message.event === 'transaction-rejected'
		) {
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
		name,
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

async function shutdownWorkers(...workers) {
	await Promise.all(workers.filter(Boolean).map((worker) => worker.shutdown().catch(() => undefined)));
}

describe('dropTable worker quiescence', function () {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;

	before(() => {
		testPath = setupTestDBPath();
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
		for (let turn = 0; turn < 5; turn++) await new Promise(setImmediate);
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

	it('rejects a drop from its own staged-write transaction before tombstoning', async function () {
		const tableName = `DropOwnTxn_${process.pid}_${Date.now()}`;
		const Table = defineTable(tableName);
		const dbisDb = database({ database: 'test', table: null }).dbisDb;

		await assert.rejects(
			() =>
				transaction(async () => {
					await Table.put({ id: 'staged', name: 'pending' });
					await Table.dropTable();
				}),
			(error) => error?.code === 'ERR_TABLE_DROP_IN_TRANSACTION'
		);
		assert.notStrictEqual(dbisDb.getSync(`${tableName}/`)?.dropping, true);
		assert.strictEqual(databases.test?.[tableName], Table);
		await Table.dropTable();
	});

	it('aborts staged writes on linked transactions before dropping the table', async function () {
		const Table = defineTable(`DropAbortedLinkedTxn_${process.pid}_${Date.now()}`);
		const expectedError = new Error('abort linked transaction');
		let linkedTransaction;

		await assert.rejects(
			() =>
				transaction(async (transactionHead) => {
					linkedTransaction = transactionHead.next = new DatabaseTransaction();
					linkedTransaction.db = Table.primaryStore;
					await Table.put({ id: 'aborted', name: 'not committed' }, { transaction: linkedTransaction });
					throw expectedError;
				}),
			expectedError
		);
		assert.strictEqual(linkedTransaction.writes.length, 0, 'abort must clear every linked write set');
		assert.strictEqual(await Table.get('aborted'), null);
		await Table.dropTable();
	});

	it('rejects a drop from its own read transaction before tombstoning', async function () {
		const tableName = `DropOwnReadTxn_${process.pid}_${Date.now()}`;
		const Table = defineTable(tableName);
		const dbisDb = database({ database: 'test', table: null }).dbisDb;

		await transaction(async (dbTransaction) => {
			Table._readTxnForContext({ transaction: dbTransaction });
			await assert.rejects(
				() => Table.dropTable(),
				(error) => error?.code === 'ERR_TABLE_DROP_IN_TRANSACTION'
			);
		});
		assert.notStrictEqual(dbisDb.getSync(`${tableName}/`)?.dropping, true);
		assert.strictEqual(databases.test?.[tableName], Table);
		await Table.dropTable();
	});

	it('preserves shared stores while preparing a database alias', async function () {
		const tableName = `DropAliasedTable_${process.pid}_${Date.now()}`;
		const databaseName = `DropAliasDb_${process.pid}_${Date.now()}`;
		const aliasName = `${databaseName}_alias`;
		const storePath = path.join(testPath, 'drop-alias-database');
		const dropGeneration = 'shared-store-test';
		const sharedPrimaryStore = { rootStore: { path: storePath } };
		const dbisDB = {
			getSync() {
				return { dropping: true, dropGeneration };
			},
		};
		let coordinatorCloseStores;
		let aliasCloseStores;
		const Table = {
			primaryStore: sharedPrimaryStore,
			dbisDB,
			async _prepareDrop({ closeStores }) {
				coordinatorCloseStores = closeStores;
			},
		};
		const AliasTable = {
			primaryStore: sharedPrimaryStore,
			dbisDB,
			async _prepareDrop({ closeStores }) {
				aliasCloseStores = closeStores;
			},
		};
		databases[databaseName] = { [tableName]: Table };
		databases[aliasName] = { [tableName]: AliasTable };
		try {
			await prepareTableDrop(storePath, tableName, dropGeneration, Table);
			assert.strictEqual(coordinatorCloseStores, false);
			assert.strictEqual(aliasCloseStores, false, "an alias must not close the coordinator's shared stores");
		} finally {
			delete databases[databaseName];
			delete databases[aliasName];
		}
	});

	it('does not wait for a read iterator on another table in the same database', async function () {
		const droppedTable = defineTable(`DropReadScope_${process.pid}_${Date.now()}`);
		const otherTable = defineTable(`DropReadScopeOther_${process.pid}_${Date.now()}`);
		const context = {};
		let readOpened;
		const readOpenedPromise = new Promise((resolve) => {
			readOpened = resolve;
		});
		let releaseRead;
		const readGate = new Promise((resolve) => {
			releaseRead = resolve;
		});
		let readFinished = false;
		const readPromise = transaction(context, async (dbTransaction) => {
			otherTable._readTxnForContext(context);
			const readTransaction = dbTransaction.useReadTxn();
			const iterator = otherTable.primaryStore
				.getRange({ start: false, transaction: readTransaction })
				[Symbol.iterator]();
			iterator.next();
			readOpened();
			await readGate;
			try {
				iterator.next();
			} finally {
				iterator.return?.();
				dbTransaction.doneReadTxn();
				readFinished = true;
			}
		});
		await readOpenedPromise;

		const originalDropSync = droppedTable.primaryStore.dropSync;
		let destructivePhaseStarted = false;
		droppedTable.primaryStore.dropSync = function (...args) {
			destructivePhaseStarted = true;
			return originalDropSync.apply(this, args);
		};
		const dropPromise = droppedTable.dropTable();
		let earlyError;
		try {
			await waitFor(() => destructivePhaseStarted, {
				message: 'an unrelated table reader must not widen the drop drain to the whole database',
			});
			assert.strictEqual(readFinished, false, 'the unrelated iterator must still be open when the drop proceeds');
		} catch (error) {
			earlyError = error;
		} finally {
			releaseRead();
		}
		const [readResult, dropResult] = await Promise.allSettled([readPromise, dropPromise]);
		if (earlyError) throw earlyError;
		if (readResult.status === 'rejected') throw readResult.reason;
		if (dropResult.status === 'rejected') throw dropResult.reason;
	});

	it('cancels and drains a transaction-less range scan before closing the table stores', async function () {
		const Table = defineTable(`DropDirectScan_${process.pid}_${Date.now()}`);
		await Table.put({ id: 'scan', name: 'held' });

		const originalSetImmediate = global.setImmediate;
		let releaseScan;
		global.setImmediate = (callback, ...args) => {
			global.setImmediate = originalSetImmediate;
			releaseScan = () => originalSetImmediate(callback, ...args);
		};
		let scanPromise;
		try {
			scanPromise = Table.getRecordCount({ exactCount: true });
			await waitFor(() => releaseScan, { message: 'getRecordCount() did not enter its yielded range scan' });
		} finally {
			global.setImmediate = originalSetImmediate;
		}

		const originalDropSync = Table.primaryStore.dropSync;
		let destructivePhaseStarted = false;
		Table.primaryStore.dropSync = function (...args) {
			destructivePhaseStarted = true;
			return originalDropSync.apply(this, args);
		};
		const dropPromise = Table.dropTable();
		for (let turn = 0; turn < 5; turn++) await new Promise(originalSetImmediate);
		let earlyError;
		try {
			assert.strictEqual(destructivePhaseStarted, false, 'dropTable() must wait for the direct range scan');
		} catch (error) {
			earlyError = error;
		} finally {
			releaseScan();
		}
		const [scanResult, dropResult] = await Promise.allSettled([scanPromise, dropPromise]);
		if (earlyError) throw earlyError;
		assert.strictEqual(scanResult.status, 'rejected');
		assert.strictEqual(scanResult.reason.code, 'ERR_TABLE_DROPPING');
		if (dropResult.status === 'rejected') throw dropResult.reason;
		assert.strictEqual(destructivePhaseStarted, true);
	});

	it('drains an in-flight cleanup batch before dropping the table stores', async function () {
		this.timeout(15000);
		const { Transaction } = require('@harperfast/rocksdb-js');
		const Table = defineTable(`DropCleanupBatch_${process.pid}_${Date.now()}`);
		Table.setTTLExpiration({ expiration: 3600, eviction: 3600, scanInterval: 3600 });
		for (let id = 0; id < 100; id++) {
			await Table.put(id, { name: `expired-${id}` }, { expiresAt: 1 });
		}

		const originalCommit = Transaction.prototype.commit;
		const originalGetEntry = Table.primaryStore.getEntry;
		const cleanupTransactions = new WeakSet();
		Table.primaryStore.getEntry = function (...args) {
			const [, options] = args;
			if (options?.transaction) cleanupTransactions.add(options.transaction);
			return originalGetEntry.apply(this, args);
		};
		let cleanupCommitEntered;
		const cleanupCommitStarted = new Promise((resolve) => (cleanupCommitEntered = resolve));
		let releaseCleanupCommit;
		const cleanupCommitGate = new Promise((resolve) => (releaseCleanupCommit = resolve));
		let blockedCommit = false;
		Transaction.prototype.commit = async function (...args) {
			if (!blockedCommit && cleanupTransactions.has(this)) {
				blockedCommit = true;
				cleanupCommitEntered();
				await cleanupCommitGate;
			}
			return originalCommit.apply(this, args);
		};

		try {
			Table.setTTLExpiration({ expiration: 0.001, eviction: 0.001, scanInterval: 0.001 });
			await cleanupCommitStarted;

			const originalDropSync = Table.primaryStore.dropSync;
			let destructivePhaseStarted = false;
			Table.primaryStore.dropSync = function (...args) {
				destructivePhaseStarted = true;
				return originalDropSync.apply(this, args);
			};
			const dropPromise = Table.dropTable();
			for (let turn = 0; turn < 5; turn++) await new Promise(setImmediate);
			let earlyError;
			try {
				assert.strictEqual(destructivePhaseStarted, false, 'dropTable() must wait for the cleanup batch commit');
			} catch (error) {
				earlyError = error;
			} finally {
				releaseCleanupCommit();
			}
			await dropPromise;
			if (earlyError) throw earlyError;
			assert.strictEqual(destructivePhaseStarted, true);
		} finally {
			releaseCleanupCommit();
			Transaction.prototype.commit = originalCommit;
			Table.primaryStore.getEntry = originalGetEntry;
		}
	});

	it('drains an audit delete removal before dropping the primary store', async function () {
		const storagePath = path.join(testPath, 'audit-delete-removal-databases');
		const previousStoragePath = env.get(terms.CONFIG_PARAMS.STORAGE_PATH);
		let releaseRemoval;
		mkdirSync(storagePath, { recursive: true });
		env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, storagePath);
		try {
			resetDatabases();
			const databaseName = `DropAuditDeleteDb_${process.pid}_${Date.now()}`;
			const Table = table({
				table: `DropAuditDeleteRemoval_${process.pid}_${Date.now()}`,
				database: databaseName,
				audit: true,
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
			});
			await Table.put({ id: 'deleted', name: 'removed' });
			await Table.delete('deleted');

			const originalRemove = Table.primaryStore.remove;
			let removalStarted;
			const removalStartedPromise = new Promise((resolve) => {
				removalStarted = resolve;
			});
			const removalGate = new Promise((resolve) => {
				releaseRemoval = resolve;
			});
			Table.primaryStore.remove = async function (...args) {
				removalStarted();
				await removalGate;
				return originalRemove.apply(this, args);
			};

			const originalDropSync = Table.primaryStore.dropSync;
			let destructivePhaseStarted = false;
			Table.primaryStore.dropSync = function (...args) {
				destructivePhaseStarted = true;
				return originalDropSync.apply(this, args);
			};
			const removeDeletedRecord = Table.auditStore.deleteCallbacks[Table.tableId];
			assert.strictEqual(typeof removeDeletedRecord, 'function');
			assert.strictEqual(
				Table.auditStore.tableStores[Table.tableId],
				Table.primaryStore,
				'the callback must belong to the table under test'
			);
			const deleteRemovalPromise = removeDeletedRecord('deleted', Table.primaryStore.getEntry('deleted').version);
			await removalStartedPromise;
			const dropPromise = Table.dropTable();
			for (let turn = 0; turn < 5; turn++) await new Promise(setImmediate);
			assert.strictEqual(
				destructivePhaseStarted,
				false,
				'dropTable() must wait for the direct primary-store removal launched by audit pruning'
			);
			releaseRemoval();
			await Promise.all([deleteRemovalPromise, dropPromise]);
			assert.strictEqual(destructivePhaseStarted, true);
			Table.primaryStore.remove = originalRemove;
		} finally {
			releaseRemoval?.();
			env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, previousStoragePath);
			resetDatabases();
		}
	});

	it('bounds and drains direct deleteHistory removals before dropping the primary store', async function () {
		const storagePath = path.join(testPath, 'delete-history-removal-databases');
		const previousStoragePath = env.get(terms.CONFIG_PARAMS.STORAGE_PATH);
		let releaseRemoval;
		mkdirSync(storagePath, { recursive: true });
		env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, storagePath);
		try {
			resetDatabases();
			const Table = table({
				table: `DropDeleteHistoryRemoval_${process.pid}_${Date.now()}`,
				database: `DropDeleteHistoryDb_${process.pid}_${Date.now()}`,
				audit: true,
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
			});
			for (let id = 0; id < 51; id++) {
				await Table.put({ id, name: 'removed' });
				await Table.delete(id);
			}
			delete Table.auditStore.deleteCallbacks[Table.tableId];

			const originalRemove = Table.primaryStore.remove;
			let removalsStarted = 0;
			const removalGate = new Promise((resolve) => {
				releaseRemoval = resolve;
			});
			Table.primaryStore.remove = async function (...args) {
				removalsStarted++;
				await removalGate;
				return originalRemove.apply(this, args);
			};

			const originalDropSync = Table.primaryStore.dropSync;
			let destructivePhaseStarted = false;
			Table.primaryStore.dropSync = function (...args) {
				destructivePhaseStarted = true;
				return originalDropSync.apply(this, args);
			};
			const deleteHistoryPromise = Table.deleteHistory(Date.now() + 1000, true);
			await waitFor(() => removalsStarted === 50, { message: 'deleteHistory() did not fill its bounded removal window' });
			const dropPromise = Table.dropTable();
			for (let turn = 0; turn < 5; turn++) await new Promise(setImmediate);
			assert.strictEqual(removalsStarted, 50, 'deleteHistory() must bound its pending removal promises');
			assert.strictEqual(
				destructivePhaseStarted,
				false,
				'dropTable() must wait for direct primary-store removals started by deleteHistory()'
			);
			releaseRemoval();
			const [deleteHistoryResult, dropResult] = await Promise.allSettled([deleteHistoryPromise, dropPromise]);
			assert.strictEqual(deleteHistoryResult.status, 'rejected');
			assert.strictEqual(deleteHistoryResult.reason.code, 'ERR_TABLE_DROPPING');
			if (dropResult.status === 'rejected') throw dropResult.reason;
			assert.strictEqual(removalsStarted, 50);
			assert.strictEqual(destructivePhaseStarted, true);
			Table.primaryStore.remove = originalRemove;
		} finally {
			releaseRemoval?.();
			env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, previousStoragePath);
			resetDatabases();
		}
	});

	it('drains an expiration index removal before dropping the table stores', async function () {
		const storagePath = path.join(testPath, 'expiration-index-removal-databases');
		const previousStoragePath = env.get(terms.CONFIG_PARAMS.STORAGE_PATH);
		const originalSetInterval = global.setInterval;
		const expirationCallbacks = [];
		let releaseRemoval;
		mkdirSync(storagePath, { recursive: true });
		env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, storagePath);
		try {
			resetDatabases();
			global.setInterval = (callback, delay, ...args) => {
				if (delay === 60000 && String(callback).includes('runningRecordExpiration')) {
					expirationCallbacks.push(callback);
					return originalSetInterval(() => {}, 0x7fffffff, ...args);
				}
				return originalSetInterval(callback, delay, ...args);
			};
			const Table = table({
				table: `DropExpirationRemoval_${process.pid}_${Date.now()}`,
				database: `DropExpirationDb_${process.pid}_${Date.now()}`,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'expiresAt', expiresAt: true, indexed: true },
				],
			});
			global.setInterval = originalSetInterval;
			assert(expirationCallbacks.length > 0, 'table setup did not schedule an expiration scan');
			const expiresAt = Date.now() - 1000;
			await Table.put({ id: 'orphaned-index', expiresAt });
			await Table.primaryStore.remove('orphaned-index');
			const expirationKeys = [...Table.indices.expiresAt.getRange({ start: true, values: false, end: Date.now() })];
			assert(
				expirationKeys.some((entry) => entry.key === expiresAt && entry.value === 'orphaned-index'),
				`missing expiration index key: ${JSON.stringify(expirationKeys)}`
			);

			const originalIfVersion = Table.primaryStore.ifVersion;
			let removalStarted = false;
			const removalGate = new Promise((resolve) => (releaseRemoval = resolve));
			Table.primaryStore.ifVersion = async function (...args) {
				removalStarted = true;
				await removalGate;
				return originalIfVersion.apply(this, args);
			};

			const originalDropSync = Table.primaryStore.dropSync;
			let destructivePhaseStarted = false;
			Table.primaryStore.dropSync = function (...args) {
				destructivePhaseStarted = true;
				return originalDropSync.apply(this, args);
			};
			const expirationPromise = Promise.all(expirationCallbacks.map((callback) => callback()));
			await waitFor(() => removalStarted, { timeout: 2000, message: 'expiration scan did not start the index removal' });
			const dropPromise = Table.dropTable();
			for (let turn = 0; turn < 5; turn++) await new Promise(setImmediate);
			assert.strictEqual(
				destructivePhaseStarted,
				false,
				'dropTable() must wait for a direct expiration-index removal'
			);
			releaseRemoval();
			let expirationSettled = false;
			let dropSettled = false;
			expirationPromise.then(
				() => (expirationSettled = true),
				() => (expirationSettled = true)
			);
			dropPromise.then(
				() => (dropSettled = true),
				() => (dropSettled = true)
			);
			await waitFor(() => expirationSettled && dropSettled, {
				timeout: 5000,
				message: `expiration/drop did not settle (expiration=${expirationSettled}, drop=${dropSettled})`,
			});
			await Promise.all([expirationPromise, dropPromise]);
			assert.strictEqual(destructivePhaseStarted, true);
			Table.primaryStore.ifVersion = originalIfVersion;
		} finally {
			global.setInterval = originalSetInterval;
			releaseRemoval?.();
			env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, previousStoragePath);
			resetDatabases();
		}
	});

	it('cancels a subscriber-paced replay instead of timing out the drop drain', async function () {
		const Table = defineTable(`DropSlowReplay_${process.pid}_${Date.now()}`);
		for (let i = 0; i < 110; i++) await Table.put(i, { name: `queued-${i}` });
		const subscription = await Table.subscribe({ isCollection: true });
		await waitFor(() => subscription.currentDrainResolver, {
			message: 'subscription replay did not pause on client backpressure',
		});

		await Table.dropTable();
		assert.strictEqual(subscription.closed, true);
	});

	it('closes an abandoned history iterator before dropping its stores', async function () {
		const tableName = `DropHistoryIterator_${process.pid}_${Date.now()}`;
		const Table = table({
			table: tableName,
			database: 'test',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		await Table.put({ id: 'history', name: 'held' });
		const history = Table.getHistory()[Symbol.asyncIterator]();
		const first = await history.next();
		assert.strictEqual(first.done, false);

		await Table.dropTable();
		await assert.rejects(
			() => history.next(),
			(error) => error.code === 'ERR_TABLE_DROPPING'
		);
	});

	it('releases a history operation token when iterator cancellation throws', async function () {
		const Table = table({
			table: `DropThrowingHistoryIterator_${process.pid}_${Date.now()}`,
			database: 'test',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		await Table.put({ id: 'history', name: 'held' });

		const originalGetRange = Table.auditStore.getRange;
		let injectedError = false;
		Table.auditStore.getRange = function (...args) {
			const range = originalGetRange.apply(this, args);
			return {
				[Symbol.iterator]() {
					const iterator = range[Symbol.iterator]();
					const originalReturn = iterator.return?.bind(iterator);
					iterator.return = (...returnArgs) => {
						const result = originalReturn?.(...returnArgs);
						if (!injectedError) {
							injectedError = true;
							throw new Error('forced history iterator cancellation failure');
						}
						return result;
					};
					return iterator;
				},
			};
		};

		const history = Table.getHistory()[Symbol.asyncIterator]();
		try {
			assert.strictEqual((await history.next()).done, false);
			await Table.dropTable();
			assert.strictEqual(injectedError, true, 'the test must exercise the throwing cancellation path');
		} finally {
			Table.auditStore.getRange = originalGetRange;
			await history.return?.();
		}
	});

	it('omits a worker until its ITC listener is ready', async function () {
		const worker = startWorker(UNREADY_WORKER_FIXTURE, {
			name: THREAD_TYPES.JOB,
			workerIndex: 1,
			threadCount: 2,
			autoRestart: false,
		});
		try {
			await new Promise((resolve, reject) => {
				worker.once('online', resolve);
				worker.once('error', reject);
			});
			assert.notStrictEqual(worker.itcReady, true);
			await broadcastWithStrictAcknowledgement({ type: ITC_EVENT_TYPES.SCHEMA, message: { originator: 0 } }, 50);
		} finally {
			worker.wasShutdown = true;
			await worker.terminate();
		}
	});

	it('NACKs a malformed strict schema event', async function () {
		const worker = startDropWorker(1, 2);
		try {
			await worker.booted;
			assert.strictEqual(worker.worker.itcReady, true);
			worker.worker.itcReady = false;
			assert.strictEqual(Atomics.load(worker.worker.itcReadySignal, 0), 1);
			await assert.rejects(
				() =>
					broadcastWithStrictAcknowledgement(
						{
							type: ITC_EVENT_TYPES.SCHEMA,
							message: { operation: TABLE_DROP_PREPARE_OPERATION },
						},
						1000
					),
				/originator/i
			);
		} finally {
			await worker.shutdown();
		}
	});

	it('does not validate unrelated traffic handled by the shared worker listener', async function () {
		const worker = startDropWorker(1, 2);
		try {
			await worker.booted;
			worker.send('send-foreign-strict');
			await worker.nextEvent('foreign-strict-acknowledged');
		} finally {
			await worker.shutdown();
		}
	});

	it('quiesces a live class before deferring its unquiesced tombstone', async function () {
		const databaseName = `DropReconcileDb_${process.pid}_${Date.now()}`;
		const tableName = `DropUnquiesced_${process.pid}_${Date.now()}`;
		const storagePath = path.join(testPath, 'reconcile-databases');
		const previousStoragePath = env.get(terms.CONFIG_PARAMS.STORAGE_PATH);
		mkdirSync(storagePath, { recursive: true });
		env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, storagePath);
		try {
			resetDatabases();
			const Table = defineTable(tableName, false, databaseName);
			const rootStore = Table.primaryStore.rootStore;
			const dbisDb = database({ database: databaseName, table: null }).dbisDb;
			const meta = dbisDb.getSync(`${tableName}/`);
			meta.dropping = true;
			meta.dropGeneration = 'unquiesced-test';
			meta.dropQuiesced = false;
			meta.dropProcessInstance = getProcessInstanceId();
			dbisDb.putSync(`${tableName}/`, meta);

			resetDatabases();
			assert.strictEqual(
				getDatabases()[databaseName]?.[tableName],
				undefined,
				'an unquiesced table must stay unloaded'
			);
			assert.strictEqual(
				dbisDb.getSync(`${tableName}/`)?.dropping,
				true,
				'recovery must preserve the tombstone while stale handles can still exist in this process'
			);

			assert.strictEqual(Table.primaryStore.dropping, true, 'reconcile must mark the removed class as dropping');
			await prepareTableDrop(rootStore.path, tableName, meta.dropGeneration);
			await waitFor(
				() => {
					try {
						Table.primaryStore.getSync('__reconcile-close-probe__');
						return false;
					} catch {
						return true;
					}
				},
				{ message: 'the strict barrier must close a reconciled class retained for preparation' }
			);

			const priorProcessMeta = dbisDb.getSync(`${tableName}/`);
			priorProcessMeta.dropProcessInstance = `${getProcessInstanceId()}-prior`;
			dbisDb.putSync(`${tableName}/`, priorProcessMeta);
			delete databases[databaseName]?.[tableName];
			resetDatabases();
			assert.strictEqual(getDatabases()[databaseName]?.[tableName], undefined);
			assert.strictEqual(
				database({ database: databaseName, table: null }).dbisDb.getSync(`${tableName}/`),
				undefined,
				'a tombstone from a prior process should complete on restart'
			);
		} finally {
			env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, previousStoragePath);
			resetDatabases();
		}
	});

	it('retries a timed-out preparation on a class already removed from the live schema', async function () {
		this.timeout(25000);
		const tableName = `DropPreparationRetry_${process.pid}_${Date.now()}`;
		const Table = defineTable(tableName);
		const rootStore = Table.primaryStore.rootStore;
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
			await Table.put({ id: 'held-for-retry', name: 'pending' }, context);
			staged();
			await transactionGate;
		});
		await stagedPromise;

		await assert.rejects(() => Table.dropTable(), /timed out after 10000ms/);
		assert.strictEqual(databases.test?.[tableName], undefined);
		assert.ok(rootStore.columns.some((column) => column.startsWith(`${tableName}/`)));
		assert.throws(
			() => Table._readTxnForContext({}),
			(error) => error?.code === 'ERR_TABLE_DROPPING',
			'a stale table-class reference must not admit a new read after preparation starts'
		);

		const originalDropSync = Table.primaryStore.dropSync;
		let destructivePhaseStarted = false;
		Table.primaryStore.dropSync = function (...args) {
			destructivePhaseStarted = true;
			return originalDropSync.apply(this, args);
		};
		const retryPromise = Table.dropTable();
		for (let turn = 0; turn < 5; turn++) await new Promise(setImmediate);
		let earlyError;
		try {
			assert.strictEqual(destructivePhaseStarted, false, 'the retry must start a fresh drain');
		} catch (error) {
			earlyError = error;
		} finally {
			releaseTransaction();
		}
		const [transactionResult, retryResult] = await Promise.allSettled([transactionPromise, retryPromise]);
		if (earlyError) throw earlyError;
		if (transactionResult.status === 'rejected') throw transactionResult.reason;
		if (retryResult.status === 'rejected') throw retryResult.reason;
		assert.ok(!rootStore.columns.some((column) => column.startsWith(`${tableName}/`)));
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
			await shutdownWorkers(remote);
			const tombstone = dbisDb.getSync(`${tableName}/`);
			if (tombstone?.dropping) {
				tombstone.dropProcessInstance = `${getProcessInstanceId()}-prior`;
				dbisDb.putSync(`${tableName}/`, tombstone);
				resetDatabases();
				getDatabases();
			}
		}
	});

	it('continues after a worker fully exits during preparation', async function () {
		this.timeout(30000);
		// Force-terminating a worker intentionally bypasses closeLoadedDatabases(), so rocksdb-js keeps
		// that worker's process-global handle and snapshot watermark. Isolate the test's sacrificial
		// database so the leaked snapshot cannot pin later blob-reclamation tests on the shared test DB.
		const databaseName = `DropWorkerExitDb_${process.pid}_${Date.now()}`;
		const tableName = `DropWorkerExit_${process.pid}_${Date.now()}`;
		const Table = defineTable(tableName, false, databaseName);
		const rootStore = Table.primaryStore.rootStore;
		const dbisDb = database({ database: databaseName, table: null }).dbisDb;
		let remote;
		try {
			remote = startDropWorker(1, 2);
			await remote.booted;
			remote.send('initialize', { table: tableName, database: databaseName });
			await remote.nextEvent('ready');
			remote.send('begin-transaction', { id: 'exiting-worker-staged' });
			await remote.nextEvent('transaction-staged');

			const dropPromise = Table.dropTable();
			await remote.nextEvent('prepare-entered');
			remote.worker.wasShutdown = true;
			await remote.worker.terminate();
			remote = undefined;
			await dropPromise;

			assert.ok(
				!rootStore.columns.some((column) => column.startsWith(`${tableName}/`)),
				'a fully exited worker can no longer issue writes through its stale handles'
			);
		} finally {
			await shutdownWorkers(remote);
			const tombstone = dbisDb.getSync(`${tableName}/`);
			if (tombstone?.dropping) {
				tombstone.dropProcessInstance = `${getProcessInstanceId()}-prior`;
				dbisDb.putSync(`${tableName}/`, tombstone);
				resetDatabases();
				getDatabases();
			}
		}
	});

	it('drains a remote staged transaction before a worker-originated drop', async function () {
		this.timeout(30000);
		const tableName = `DropRemoteTransaction_${process.pid}_${Date.now()}`;
		defineTable(tableName);
		let origin;
		let remote;
		try {
			remote = startDropWorker(1, 3);
			origin = startDropWorker(2, 3, THREAD_TYPES.JOB);
			await Promise.all([remote.booted, origin.booted]);
			remote.send('initialize', { table: tableName });
			origin.send('initialize', { table: tableName });
			await Promise.all([remote.nextEvent('ready'), origin.nextEvent('ready')]);

			remote.send('begin-transaction', { id: 'remote-staged' });
			await remote.nextEvent('transaction-staged');
			const dropResultPromise = origin.nextEvent('drop-result');
			let dropSettled = false;
			dropResultPromise.then(() => {
				dropSettled = true;
			});
			origin.send('drop-table');
			await remote.nextEvent('prepare-entered');
			for (let turn = 0; turn < 5; turn++) await new Promise(setImmediate);
			assert.strictEqual(dropSettled, false, 'the drop must wait for the remote transaction');

			remote.send('release-transaction');
			await remote.nextEvent('transaction-resolved');
			const prepared = await remote.nextEvent('prepare-finished');
			assert.strictEqual(prepared.handlesClosed, true);
			const dropResult = await dropResultPromise;
			assert.strictEqual(dropResult.outcome, 'resolved');
			assert.deepStrictEqual([...origin.errors, ...remote.errors], []);
		} finally {
			await shutdownWorkers(origin, remote);
		}
	});

	it('drains a remote read iterator before closing its handles', async function () {
		this.timeout(30000);
		const tableName = `DropRemoteRead_${process.pid}_${Date.now()}`;
		defineTable(tableName);
		let origin;
		let remote;
		try {
			remote = startDropWorker(1, 3);
			origin = startDropWorker(2, 3, THREAD_TYPES.JOB);
			await Promise.all([remote.booted, origin.booted]);
			remote.send('initialize', { table: tableName });
			origin.send('initialize', { table: tableName });
			await Promise.all([remote.nextEvent('ready'), origin.nextEvent('ready')]);

			remote.send('begin-read');
			await remote.nextEvent('read-open');
			const dropResultPromise = origin.nextEvent('drop-result');
			let dropSettled = false;
			dropResultPromise.then(() => {
				dropSettled = true;
			});
			origin.send('drop-table');
			await remote.nextEvent('prepare-entered');
			for (let turn = 0; turn < 5; turn++) await new Promise(setImmediate);
			assert.strictEqual(dropSettled, false, 'the drop must wait for the remote iterator');

			remote.send('release-read');
			await remote.nextEvent('read-resolved');
			const prepared = await remote.nextEvent('prepare-finished');
			assert.strictEqual(prepared.handlesClosed, true);
			const dropResult = await dropResultPromise;
			assert.strictEqual(dropResult.outcome, 'resolved');
			assert.deepStrictEqual([...origin.errors, ...remote.errors], []);
		} finally {
			await shutdownWorkers(origin, remote);
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
			origin = startDropWorker(2, 3, THREAD_TYPES.JOB);
			await Promise.all([remote.booted, origin.booted]);
			remote.send('initialize', { table: tableName, withEmbed: true });
			origin.send('initialize', { table: tableName, withEmbed: true });
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
			await shutdownWorkers(origin, remote);
		}
	});
});
