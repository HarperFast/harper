require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { getPlaneBinding } = require('#src/resources/indexes/hnswPlaneBinding');
const { DatabaseTransaction } = require('#src/resources/DatabaseTransaction');
const { DERIVED_INDEX_CURSOR_KEY, HnswDerivedIndexBackend } = require('#src/resources/indexes/hnswDerivedIndex');
const {
	READINESS_BYTES,
	DerivedIndexRuntime,
	readDerivedIndexCoverage,
} = require('#src/resources/derivedIndexRuntime');
const { RocksDatabase } = require('@harperfast/rocksdb-js');
const { RocksTransactionLogStore } = require('#src/resources/RocksTransactionLogStore');
const { createAuditEntry, ENTRY_DATAVIEW } = require('#src/resources/auditStore');
const { waitFor } = require('../waitFor');

describe('native derived-index query coverage', function () {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb' || !getPlaneBinding()) return;
	this.timeout(20_000);
	let Product, Other, index;
	const vector = [1, 0, 0, 0];
	const search = (maxIndexLagMilliseconds) =>
		index.search(
			{
				target: vector,
				comparator: 'sort',
				distance: 'cosine',
				ef: 200,
				maxIndexLagMilliseconds,
			},
			{ transaction: undefined }
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
		await Product.put('initial', { vector });
		await current();
	});
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
	it('uses a 3000 ms default and validates only native query tolerances', async () => {
		assert.equal((await search()).indexCoverage.maxLagMilliseconds, 3000);
		for (const invalid of [-1, null, NaN, Infinity, '1000', {}]) {
			await assert.rejects(
				Promise.resolve().then(() => search(invalid)),
				(error) => error.statusCode === 400 && /maxIndexLagMilliseconds/.test(error.message)
			);
		}
		assert.equal((await search(0)).indexCoverage.state, 'current');
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
