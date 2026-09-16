require('../testUtils');
const assert = require('node:assert');
const { existsSync } = require('node:fs');
const { setupTestDBPath } = require('../testUtils');
const { table, closeDatabase } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { getPlaneBinding } = require('#src/resources/indexes/hnswPlaneBinding');
const { DatabaseTransaction } = require('#src/resources/DatabaseTransaction');
const { DERIVED_INDEX_CURSOR_KEY, HnswDerivedIndexBackend } = require('#src/resources/indexes/hnswDerivedIndex');
const {
	READINESS_BYTES,
	DerivedIndexRuntime,
	readDerivedIndexCoverage,
} = require('#src/resources/derivedIndexRuntime');
const { RocksDatabase, Transaction } = require('@harperfast/rocksdb-js');
const { RocksTransactionLogStore } = require('#src/resources/RocksTransactionLogStore');
const { createAuditEntry, ENTRY_DATAVIEW } = require('#src/resources/auditStore');
const { waitFor } = require('../waitFor');

describe('native derived-index query coverage', function () {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb' || !getPlaneBinding()) return;
	this.timeout(20_000);
	let Product, Other, index;
	const vector = [1, 0, 0, 0];
	const search = (maxIndexLagMilliseconds, waitForIndexMilliseconds, context = { transaction: undefined }) =>
		index.search(
			{
				target: vector,
				comparator: 'sort',
				distance: 'cosine',
				ef: 200,
				maxIndexLagMilliseconds,
				waitForIndexMilliseconds,
			},
			context
		);
	const current = () =>
		waitFor(
			async () => {
				try {
					return await search(0);
				} catch (error) {
					if (error.statusCode === 503) return false;
					throw error;
				}
			},
			{ timeout: 15_000, message: 'native index did not certify current coverage' }
		);
	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		Product = table({
			database: 'native-query-coverage',
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'vector', type: 'Array', indexed: { type: 'HNSW', nativePlane: true } },
			],
		});
		Other = table({
			database: 'native-query-coverage',
			table: 'Other',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
		});
		index = Product.indices.vector.customIndex;
		assert.equal((await current()).length, 0);
		await Product.put('initial', { vector });
		await current();
	});
	after(() => closeDatabase('native-query-coverage'));
	it('rejects a committed write before its native barrier without invalidating the plane', async () => {
		const plane = index.getPlane();
		await Product.put('new', { vector });
		await assert.rejects(
			Promise.resolve().then(() => search(0)),
			(error) => error.statusCode === 503 && error.code === 'DERIVED_INDEX_LAGGING' && error.retryable === true
		);
		assert.strictEqual(index.getPlane(), plane);
		const tolerant = await search(60_000);
		assert.equal(tolerant.indexCoverage.state, 'bounded');
		assert(tolerant.indexCoverage.lagUpperBoundMilliseconds <= 60_000);
		assert.equal(Object.keys(tolerant).includes('indexCoverage'), false);
		const caughtUp = await current();
		assert(caughtUp.some(({ key }) => key === 'new'));
		assert.deepStrictEqual(caughtUp.indexCoverage, {
			state: 'current',
			maxLagMilliseconds: 0,
			lagUpperBoundMilliseconds: 0,
		});
	});
	it('uses a 3000 ms default and validates native query tolerances', async () => {
		assert.equal((await search()).indexCoverage.maxLagMilliseconds, 3000);
		for (const invalid of [-1, null, NaN, Infinity, '1000', {}]) {
			await assert.rejects(
				Promise.resolve().then(() => search(invalid)),
				(error) => error.statusCode === 400 && /maxIndexLagMilliseconds/.test(error.message)
			);
		}
		assert.equal((await search(0)).indexCoverage.state, 'current');
	});
	it('waits for a completed prior write on an otherwise idle database', async () => {
		await Product.put('waited-write', { vector });
		const result = await search(undefined, 10_000);
		assert(result.some(({ key }) => key === 'waited-write'));
		assert.deepStrictEqual(result.indexCoverage, {
			state: 'current',
			maxLagMilliseconds: 3000,
			lagUpperBoundMilliseconds: 0,
		});
		assert.equal(search().indexAdmission, undefined);
	});
	it('times out despite a tolerant lag setting and leaves the native plane healthy', async () => {
		await current();
		const plane = index.getPlane();
		await Product.put('short-wait', { vector });
		await assert.rejects(
			Promise.resolve().then(() => search(60_000, Number.MIN_VALUE)),
			{ code: 'DERIVED_INDEX_LAGGING', statusCode: 503, retryable: true }
		);
		assert.strictEqual(index.getPlane(), plane);
		await search(undefined, 10_000);
	});
	it('validates wait budgets and keeps the zero-wait behavior', async () => {
		for (const invalid of [-1, null, NaN, Infinity, '1000', {}, 30_001]) {
			await assert.rejects(
				Promise.resolve().then(() => search(undefined, invalid)),
				(error) => error.statusCode === 400 && /waitForIndexMilliseconds/.test(error.message)
			);
		}
		assert.equal(search(undefined, 0).indexAdmission, undefined);
	});
	it('keeps a fixed certified boundary after later unrelated writes', async () => {
		const since = process.hrtime.bigint();
		await index.derivedHost.waitForCoverage(since, 10_000);
		await Other.put('after-wait-boundary', { value: 1 });
		await index.derivedHost.waitForCoverage(since, 10_000);
		await assert.rejects(
			Promise.resolve().then(() => search(0)),
			{ code: 'DERIVED_INDEX_LAGGING' }
		);
		await current();
	});
	it('cancels a waiting query and releases its read snapshot', async () => {
		await Product.put('cancelled-wait', { vector });
		const transaction = new DatabaseTransaction();
		const controller = new AbortController();
		try {
			const pending = Product.search(
				{ sort: { attribute: 'vector', target: vector, waitForIndexMilliseconds: 10_000 }, limit: 10 },
				{ transaction, signal: controller.signal }
			);
			controller.abort(new Error('cancel coverage wait'));
			await assert.rejects(Promise.resolve(pending), /cancel coverage wait/);
			await transaction.commit();
			assert.equal(transaction.readTxnsUsed, 0);
		} finally {
			transaction.abort();
		}
		await current();
	});
	it('gates mapped async-authorized searches and zero-size pages before returning', async () => {
		class Mapped extends Product {
			static loadAsInstance = false;
			async allowRead() {
				return true;
			}
			search(target) {
				const results = super.search(target);
				return results instanceof Promise ? results : results.map((record) => record);
			}
		}
		for (const count of [undefined, 'exact']) {
			await current();
			await Product.put('gated-' + count, { vector });
			const transaction = new DatabaseTransaction();
			try {
				await assert.rejects(
					Promise.resolve().then(() =>
						Mapped.search(
							{
								sort: { attribute: 'vector', target: vector, waitForIndexMilliseconds: Number.MIN_VALUE },
								limit: 0,
								count,
							},
							{ transaction, user: { role: { permission: {} } }, authorize: true }
						)
					),
					{ code: 'DERIVED_INDEX_LAGGING' }
				);
				await transaction.commit();
				assert.equal(transaction.readTxnsUsed, 0);
			} finally {
				transaction.abort();
			}
		}
		await current();
	});
	it('shares concurrent waits while cancelling only the disconnected caller', async () => {
		await Product.put('shared-wait', { vector });
		const controller = new AbortController();
		const cancelled = search(undefined, 10_000, { transaction: undefined, signal: controller.signal });
		const pending = Array.from({ length: 20 }, () => search(undefined, 10_000));
		controller.abort(new Error('one caller left'));
		await assert.rejects(cancelled, /one caller left/);
		for (const entries of await Promise.all(pending)) assert(entries.some(({ key }) => key === 'shared-wait'));
	});
	it('gates every native admission in a nested OR query', async () => {
		await Product.put('or-wait', { vector });
		await assert.rejects(
			Promise.resolve().then(() =>
				Product.search({
					operator: 'or',
					conditions: [
						{ attribute: 'id', value: 'initial' },
						{
							operator: 'and',
							conditions: [
								{
									attribute: 'vector',
									comparator: 'le',
									value: 0.1,
									target: vector,
									waitForIndexMilliseconds: Number.MIN_VALUE,
								},
							],
						},
					],
					limit: 0,
				})
			),
			{ code: 'DERIVED_INDEX_LAGGING' }
		);
		await current();
	});
	it('handles an abandoned native wait rejection', async () => {
		await Product.put('abandoned-wait', { vector });
		const unhandled = [];
		const onUnhandled = (error) => unhandled.push(error);
		process.on('unhandledRejection', onUnhandled);
		try {
			search(undefined, Number.MIN_VALUE);
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.deepStrictEqual(unhandled, []);
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
		await current();
	});
	it('keeps aligned sort wait budgets and lets an explicit condition override them', async () => {
		await Product.put('aligned-wait', { vector });
		const result = await Product.search({
			conditions: [{ attribute: 'vector', comparator: 'le', value: 0.1, target: vector }],
			sort: { attribute: 'vector', target: vector, waitForIndexMilliseconds: 10_000 },
			limit: 100,
		});
		assert((await Array.fromAsync(result)).some(({ id }) => id === 'aligned-wait'));
		await Product.put('aligned-wait-override', { vector });
		await assert.rejects(
			Promise.resolve().then(() =>
				Product.search({
					conditions: [
						{
							attribute: 'vector',
							comparator: 'le',
							value: 0.1,
							target: vector,
							waitForIndexMilliseconds: Number.MIN_VALUE,
						},
					],
					sort: { attribute: 'vector', target: vector, waitForIndexMilliseconds: 10_000 },
				})
			),
			{ code: 'DERIVED_INDEX_LAGGING' }
		);
		await current();
	});
	it('keeps a sort tolerance when a vector condition already supplies the index search', async () => {
		await current();
		await Product.put('combined-query', { vector });
		await assert.rejects(
			async () => {
				for await (const _record of Product.search({
					conditions: [{ attribute: 'vector', comparator: 'le', value: 0.1, target: vector }],
					sort: { attribute: 'vector', target: vector, maxIndexLagMilliseconds: 0 },
				})) {
					// Consume the real table query so admission executes.
				}
			},
			(error) => {
				assert.equal(error.code, 'DERIVED_INDEX_LAGGING', error.stack);
				return true;
			}
		);
		await current();
	});
	it('does not lose the physical-position proof when a transaction aborts', async () => {
		await current();
		const before = Product.indices.vector.getSync(DERIVED_INDEX_CURSOR_KEY).coverage;
		const txn = new DatabaseTransaction();
		try {
			await Product.put('aborted', { vector }, { transaction: txn });
		} finally {
			txn.abort();
		}
		const result = await search(0);
		assert.equal(result.indexCoverage.state, 'current');
		assert(!result.some(({ key }) => key === 'aborted'));
		assert.deepStrictEqual(Product.indices.vector.getSync(DERIVED_INDEX_CURSOR_KEY).coverage, before);
	});
	it('resolves covered mappings even when the record snapshot predates their publication', async () => {
		await Product.put('snapshot-covered', { vector });
		const snapshot = new Transaction(Product.auditStore.rootStore.store);
		try {
			assert(Product.primaryStore.getEntry('snapshot-covered', { transaction: snapshot }));
			await current();
			const result = await index.search(
				{ target: vector, comparator: 'sort', ef: 200, maxIndexLagMilliseconds: 0 },
				{ transaction: { transaction: snapshot } }
			);
			assert(
				result.some(({ key }) => key === 'snapshot-covered'),
				'covered mapping was hidden by the record snapshot'
			);
		} finally {
			snapshot.abort();
		}
	});
	it('certifies unrelated progress without bypassing pending indexed mutations', async () => {
		await Product.put('pending', { vector });
		await Other.put('unrelated', { value: 1 });
		await assert.rejects(
			Promise.resolve().then(() => search(0)),
			{ code: 'DERIVED_INDEX_LAGGING' }
		);
		await current();
		await Other.put('unrelated', { value: 2 });
		const result = await current();
		assert(result.some(({ key }) => key === 'pending'));
	});
	it('retains a current proof when its process-local capture time is unavailable', async () => {
		await current();
		const buffer = Product.auditStore.getUserSharedBuffer(
			`derived-index:hnsw:${Product.indices.vector.name}:readiness`,
			new ArrayBuffer(READINESS_BYTES)
		);
		const ageWord = new BigInt64Array(buffer, READINESS_BYTES - 8, 1);
		Atomics.store(ageWord, 0, 0n);
		assert.equal((await search(0)).indexCoverage.state, 'current');
		await Product.put('after-proof', { vector });
		await assert.rejects(
			Promise.resolve().then(() => search(60_000)),
			{ code: 'DERIVED_INDEX_LAGGING' }
		);
		await current();
	});
	it('refreshes owned idle coverage, fences old owners, and certifies without a registered reader', async () => {
		await current();
		const oldEpoch = index.derivedHost.readiness().ownerEpoch;
		await Product.derivedIndexRuntime.close();
		Product.derivedIndexRuntime = undefined;
		const id = `hnsw:${Product.indices.vector.name}`;
		const backend = new HnswDerivedIndexBackend(id, index);
		const runtime = new DerivedIndexRuntime(
			Product.auditStore,
			(_tableId, recordId) => {
				const entry = Product.primaryStore.getEntry(recordId);
				return entry && { version: entry.version, value: entry.value };
			},
			{ maxFlushAgeMilliseconds: 100, idleGraceMilliseconds: 1000 }
		);
		runtime.register({ backend, projections: new Map([[Product.tableId, (record) => record.vector]]) });
		try {
			await waitFor(() => runtime.getReadiness(id).ownerEpoch > oldEpoch);
			await current();
			const buffer = Product.auditStore.getUserSharedBuffer(
				`derived-index:${id}:readiness`,
				new ArrayBuffer(READINESS_BYTES)
			);
			const time = new BigInt64Array(buffer, READINESS_BYTES - 8, 1);
			const captured = Atomics.load(time, 0);
			await waitFor(() => Atomics.load(time, 0) > captured);
			const cursor = Product.indices.vector.getSync(DERIVED_INDEX_CURSOR_KEY);
			backend.publishCoverage({ local: { sequence: 99, offset: 99 } }, oldEpoch);
			assert.deepStrictEqual(Product.indices.vector.getSync(DERIVED_INDEX_CURSOR_KEY), cursor);
			await runtime.stop();
			Atomics.store(time, 0, 0n);
			const reader = new RocksTransactionLogStore(Product.auditStore.rootStore);
			assert.equal(
				readDerivedIndexCoverage(reader, id, () => Product.indices.vector.getSync(DERIVED_INDEX_CURSOR_KEY), 0).state,
				'current'
			);
			assert.equal((await search(0)).indexCoverage.state, 'current');
		} finally {
			await runtime.stop();
		}
	});
	it('does not refresh coverage for unrelated writes while an earlier mutation awaits its barrier', async () => {
		const id = `hnsw:${Product.indices.vector.name}`;
		const backend = new HnswDerivedIndexBackend(id, index);
		const runtime = new DerivedIndexRuntime(
			Product.auditStore,
			(_tableId, recordId) => {
				const entry = Product.primaryStore.getEntry(recordId);
				return entry && { version: entry.version, value: entry.value };
			},
			{ maxFlushAgeMilliseconds: 6000 }
		);
		try {
			runtime.register({ backend, projections: new Map([[Product.tableId, (record) => record.vector]]) });
			await current();
			await waitFor(() => runtime.getStatus(id).state === 'idle' && runtime.getStatus(id).ownerEpoch !== undefined);
			const buffer = Product.auditStore.getUserSharedBuffer(
				`derived-index:${id}:readiness`,
				new ArrayBuffer(READINESS_BYTES)
			);
			const time = new BigInt64Array(buffer, READINESS_BYTES - 8, 1);
			const before = Atomics.load(time, 0);
			assert(before > 0n);
			const cursor = Product.indices.vector.getSync(DERIVED_INDEX_CURSOR_KEY);
			await Product.put('barrier-pending', { vector });
			await waitFor(() => runtime.getMetrics(id).acceptedMutations === 1);
			await Other.put('after-pending', { value: 1 });
			await waitFor(() => runtime.getMetrics(id).acceptedBatches >= 2);
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(Atomics.load(time, 0), before);
			assert.deepStrictEqual(Product.indices.vector.getSync(DERIVED_INDEX_CURSOR_KEY), cursor);
			await waitFor(() => index.derivedHost.coverage(3000).state === 'unknown', 5000);
			await assert.rejects(
				Promise.resolve().then(() => search()),
				{ code: 'DERIVED_INDEX_LAGGING' }
			);
			backend.flush('age');
			const results = await current();
			assert(results.some(({ key }) => key === 'barrier-pending'));
		} finally {
			await runtime.stop();
		}
	});
	it('discovers a physical log committed before the worker-local map is updated', async () => {
		const auditStore = Product.auditStore;
		const root = auditStore.rootStore;
		const peer = root.useLog('coverage-peer');
		root.transactionSync((txn) => {
			Product.primaryStore.removeSync('new', { transaction: txn });
			ENTRY_DATAVIEW.setUint32(0, 0);
			peer.addEntry(
				Buffer.from(
					createAuditEntry(
						{
							type: 'delete',
							tableId: Product.tableId,
							recordId: 'new',
							nodeId: 0,
							version: txn.getTimestamp(),
						},
						4
					)
				),
				txn.id
			);
		});
		assert(!auditStore.logByName.has('coverage-peer'));
		const id = `hnsw:${Product.indices.vector.name}`;
		const runtime = new DerivedIndexRuntime(
			auditStore,
			(_tableId, recordId) => {
				const entry = Product.primaryStore.getEntry(recordId);
				return entry && { version: entry.version, value: entry.value };
			},
			{ maxFlushAgeMilliseconds: 50 }
		);
		try {
			runtime.register({
				backend: new HnswDerivedIndexBackend(id, index),
				projections: new Map([[Product.tableId, (record) => record.vector]]),
			});
			const results = await current();
			assert(auditStore.logByName.has('coverage-peer'));
			assert(!results.some(({ key }) => key === 'new'));
			assert(Product.indices.vector.getSync(DERIVED_INDEX_CURSOR_KEY).coverage['coverage-peer']);
		} finally {
			await runtime.stop();
		}
	});
	it('compares sequence as well as offset across real log rotation', async () => {
		const db = RocksDatabase.open(`${Product.auditStore.rootStore.path}-rotation`, { transactionLogMaxSize: 128 });
		try {
			const log = db.useLog('local');
			const store = new RocksTransactionLogStore(db);
			const buffer = store.getUserSharedBuffer('derived-index:rotation:readiness', new ArrayBuffer(READINESS_BYTES));
			Atomics.store(new Int32Array(buffer), 0, 1);
			const commit = () => db.transactionSync((txn) => log.addEntry(Buffer.alloc(256), txn.id));
			commit();
			const first = log.getStats().lastCommittedPosition;
			db.putSync('cursor', { format: 1, logs: { local: 1 }, coverage: { local: first } });
			const read = () => readDerivedIndexCoverage(store, 'rotation', () => db.getSync('cursor'), 0);
			assert.equal(read().state, 'current');
			commit();
			const next = log.getStats().lastCommittedPosition;
			assert(next.sequence > first.sequence);
			assert.equal(next.offset, first.offset);
			assert.equal(read().state, 'unknown');
		} finally {
			await db.close();
		}
	});

	it('closing a database rejects its waiters without removing the native file', async () => {
		const Closing = table({
			database: 'closing-coverage-wait',
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'vector', type: 'Array', indexed: { type: 'HNSW', nativePlane: true } },
			],
		});
		const closingIndex = Closing.indices.vector.customIndex;
		const query = (options) =>
			closingIndex.search({ target: vector, comparator: 'sort', ...options }, { transaction: undefined });
		try {
			await Closing.put('first', { vector });
			await waitFor(async () => {
				try {
					return await query({ maxIndexLagMilliseconds: 0 });
				} catch (error) {
					if (error.statusCode === 503) return false;
					throw error;
				}
			}, 15_000);
			const path = closingIndex.planeFilePath();
			assert(existsSync(path));
			await Closing.put('pending', { vector });
			const pending = query({ waitForIndexMilliseconds: 10_000 });
			const rejected = assert.rejects(pending, (error) => error.statusCode === 503);
			await closeDatabase('closing-coverage-wait');
			await rejected;
			assert(existsSync(path));
		} finally {
			await closeDatabase('closing-coverage-wait');
		}
	});

	it('fails coverage reads closed without detaching a healthy native plane', async () => {
		const plane = index.getPlane();
		const buffer = Product.auditStore.getUserSharedBuffer(
			`derived-index:hnsw:${Product.indices.vector.name}:readiness`,
			new ArrayBuffer(READINESS_BYTES)
		);
		Atomics.store(new BigInt64Array(buffer, READINESS_BYTES - 8, 1), 0, 0n);
		await Product.auditStore.rootStore.close();
		await assert.rejects(
			Promise.resolve().then(() => search(0)),
			{ code: 'DERIVED_INDEX_LAGGING' }
		);
		assert.strictEqual(index.getPlane(), plane);
	});
});
