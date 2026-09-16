require('../testUtils');
const assert = require('node:assert');
const path = require('node:path');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
const { LOCAL_ONLY } = require('#src/resources/auditStore');
const { DERIVED_INDEX_ACCEPTED, DerivedIndexRuntime } = require('#src/resources/derivedIndexRuntime');
const { decodeFullTextCursorPayload } = require('#src/resources/FullTextDerivedIndexBackend');
const {
	createNativeFullTextDerivedIndexBackend,
	NativeFullTextDerivedIndexLifecycle,
} = require('#src/resources/NativeFullTextDerivedIndexLifecycle');

describe('DerivedIndexRuntime with an audited RocksDB table', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;

	let runtime;
	let testPath;
	before(function () {
		testPath = setupTestDBPath();
		setMainIsWorker(true);
	});

	after(function () {
		runtime?.stop();
	});

	it('tails committed writes and projects the current primary state', async () => {
		const Product = table({
			database: 'derived-index-runtime-rocks',
			table: 'Product',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'title' }, { name: 'privateInventory' }],
		});
		await Product.put('unregistered-eviction', { title: 'not indexed' });
		let entry = Product.primaryStore.getEntry('unregistered-eviction');
		await Product.evict('unregistered-eviction', entry.value, entry.version);
		assert.strictEqual(
			[...Product.auditStore.getRange({ start: 1 })].some(
				(record) => record.type === 'evict' && record.recordId === 'unregistered-eviction'
			),
			false
		);

		await Product.put('anchor', { title: 'anchor' });
		const anchor = [...Product.auditStore.getRange({ start: 1 })]
			.filter((entry) => entry.tableId === Product.tableId && entry.recordId === 'anchor')
			.at(-1).txnLogKey;

		const backend = {
			id: 'products',
			cursor: { format: 1, logs: { local: anchor } },
			deliveries: [],
			attach() {},
			flush() {},
			shutdown() {},
			getDurableCursor() {
				return this.cursor;
			},
			deliver(batch) {
				this.deliveries.push(batch);
				this.cursor = batch.through;
				return DERIVED_INDEX_ACCEPTED;
			},
			onStateChange(wake) {
				this.wake = wake;
				return () => (this.wake = undefined);
			},
		};
		runtime = new DerivedIndexRuntime(
			Product.auditStore,
			(tableId, recordId) => {
				if (tableId !== Product.tableId) throw new Error(`unknown table ${tableId}`);
				const entry = Product.primaryStore.getEntry(recordId);
				return entry?.value ? { version: entry.version, value: entry.value } : undefined;
			},
			{
				scanRecords: () =>
					Product.primaryStore.getRange({ versions: true }).map((entry) => ({
						recordId: entry.key,
						version: entry.version,
						value: entry.value,
					})),
			}
		);
		const unregister = runtime.register({
			backend,
			projections: new Map([[Product.tableId, (record) => ({ title: record.title })]]),
		});

		await Product.put('p1', { title: 'first', privateInventory: 12 });
		await waitFor(() => mutationsFor(backend, 'p1').length >= 1);
		assert.deepStrictEqual(mutationsFor(backend, 'p1').at(-1).state.projection, { title: 'first' });
		assert.strictEqual('privateInventory' in mutationsFor(backend, 'p1').at(-1).state.projection, false);

		await Product.patch('p1', { title: 'second' });
		await waitFor(() => mutationsFor(backend, 'p1').length >= 2);
		assert.deepStrictEqual(mutationsFor(backend, 'p1').at(-1).state, {
			kind: 'record',
			version: Product.primaryStore.getEntry('p1').version,
			projection: { title: 'second' },
		});

		await Product.delete('p1');
		await waitFor(() => mutationsFor(backend, 'p1').some((mutation) => mutation.state.kind === 'absent'));
		assert.strictEqual(mutationsFor(backend, 'p1').at(-1).state.kind, 'absent');

		await Product.put('evicted', { title: 'resident' });
		await waitFor(() => mutationsFor(backend, 'evicted').length > 0);
		entry = Product.primaryStore.getEntry('evicted');
		await Product.evict('evicted', entry.value, entry.version);
		await waitFor(() => mutationsFor(backend, 'evicted').at(-1)?.state.kind === 'absent');
		const markers = [...Product.auditStore.getRange({ start: 1 })].filter(
			(record) => record.type === 'evict' && record.recordId === 'evicted'
		);
		assert.strictEqual(markers.length, 1);
		assert.strictEqual(markers[0].extendedType & LOCAL_ONLY, LOCAL_ONLY);
		const history = [];
		for await (const record of Product.getHistory()) history.push(record);
		assert.strictEqual(
			history.some((record) => record.type === 'evict'),
			false
		);

		await unregister();
		await Product.put('after-unregister', { title: 'not indexed' });
		entry = Product.primaryStore.getEntry('after-unregister');
		await Product.evict('after-unregister', entry.value, entry.version);
		assert.strictEqual(
			[...Product.auditStore.getRange({ start: 1 })].some(
				(record) => record.type === 'evict' && record.recordId === 'after-unregister'
			),
			false
		);
		await runtime.stop();
		runtime = undefined;
	});

	it('publishes a native full-text cursor without feeding derived storage back into the source log', async () => {
		const Product = table({
			database: 'fulltext-derived-index-runtime-rocks',
			table: 'Product',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'title' }],
		});
		await Product.put('anchor', { title: 'anchor' });
		const anchor = [...Product.auditStore.getRange({ start: 1 })]
			.filter((entry) => entry.tableId === Product.tableId && entry.recordId === 'anchor')
			.at(-1).txnLogKey;
		const binding = new FakeNativeFullTextModule();
		const lifecycleOptions = {
			storePath: path.join(testPath, 'fulltext-indexes'),
			storeName: 'fulltext-derived-index-runtime-rocks.Product.title',
			indexId: 'rocks-fulltext-products',
			sourceGeneration: 'product-table-generation',
			fields: [{ name: 'title' }],
			analyzer: 'english@1',
			limits: {
				indexingThreads: 1,
				searchThreads: 1,
				writerMemoryBytes: 32 * 1024 * 1024,
				maxQueuedCommands: 16,
				maxQueuedBytes: 64 * 1024 * 1024,
				maxBatchBytes: 8 * 1024 * 1024,
			},
			binding,
		};
		const backend = await createNativeFullTextDerivedIndexBackend({
			id: 'rocks-fulltext-products',
			...lifecycleOptions,
		});
		runtime = new DerivedIndexRuntime(
			Product.auditStore,
			(tableId, recordId) => {
				if (tableId !== Product.tableId) throw new Error(`unknown table ${tableId}`);
				const entry = Product.primaryStore.getEntry(recordId);
				return entry?.value ? { version: entry.version, value: entry.value } : undefined;
			},
			{
				scanRecords: () =>
					Product.primaryStore.getRange({ versions: true }).map((entry) => ({
						recordId: entry.key,
						version: entry.version,
						value: entry.value,
					})),
			}
		);
		let unregister = runtime.register({
			backend,
			projections: new Map([[Product.tableId, (record) => ({ title: record.title })]]),
			options: { flushAfterMutations: 1, maxFlushAgeMilliseconds: 10 },
		});
		try {
			await Product.put('p1', { title: 'first product' });
			const p1Cursor = [...Product.auditStore.getRange({ start: anchor })]
				.filter((entry) => entry.tableId === Product.tableId && entry.recordId === 'p1')
				.at(-1).txnLogKey;
			await waitFor(
				() => binding.states.size > 0 && [...binding.states.values()].some((state) => state.publications === 1),
				10_000
			);
			await new Promise((resolve) => setImmediate(resolve));

			await unregister();
			unregister = undefined;
			const reopened = new NativeFullTextDerivedIndexLifecycle(lifecycleOptions);
			await reopened.initialize();
			const inspection = reopened.inspect();
			assert.strictEqual(inspection.state, 'checkpointed');
			const state = binding.states.get(binding.opens.at(-1).generation);
			const documentId = `${Product.tableId}.${Buffer.from('p1').toString('base64url')}`;
			assert.deepStrictEqual(state.documents.get(documentId), {
				id: documentId,
				fields: { title: 'first product' },
			});
			const storedCursor = decodeFullTextCursorPayload(inspection.committedPayload);
			assert.strictEqual(storedCursor.logs.local, p1Cursor);
			assert(storedCursor.logs.local > anchor, 'the durable cursor advanced beyond the seeded anchor');
			assert.strictEqual(state.applications, 1);
		} finally {
			if (unregister) await unregister();
			await runtime.stop();
			runtime = undefined;
		}
	});

	it('rebuilds a persistently incompatible native generation from the authoritative table', async () => {
		const Product = table({
			database: 'fulltext-derived-index-invalid-generation',
			table: 'Product',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'title' }],
		});
		await Product.put('p1', { title: 'recover me' });
		const binding = new FakeNativeFullTextModule();
		const lifecycleOptions = {
			storePath: path.join(testPath, 'fulltext-indexes'),
			storeName: 'fulltext-derived-index-invalid-generation.Product.title',
			indexId: 'invalid-generation-products',
			sourceGeneration: 'product-table-generation',
			fields: [{ name: 'title' }],
			analyzer: 'english@1',
			limits: {
				indexingThreads: 1,
				searchThreads: 1,
				writerMemoryBytes: 32 * 1024 * 1024,
				maxQueuedCommands: 16,
				maxQueuedBytes: 64 * 1024 * 1024,
				maxBatchBytes: 8 * 1024 * 1024,
			},
			binding,
		};
		const seededLifecycle = new NativeFullTextDerivedIndexLifecycle(lifecycleOptions);
		await seededLifecycle.initialize();
		const seeded = await seededLifecycle.open();
		await seeded.close({ mode: 'rollback' });
		const staleGeneration = binding.opens.at(-1).generation;
		binding.inspectError = 'E_SCHEMA_MISMATCH';

		const backend = await createNativeFullTextDerivedIndexBackend({
			id: 'invalid-generation-products',
			...lifecycleOptions,
		});
		runtime = new DerivedIndexRuntime(
			Product.auditStore,
			(_tableId, recordId) => {
				const entry = Product.primaryStore.getEntry(recordId);
				return entry?.value ? { version: entry.version, value: entry.value } : undefined;
			},
			{
				scanRecords: () =>
					Product.primaryStore.getRange({ versions: true }).map((entry) => ({
						recordId: entry.key,
						version: entry.version,
						value: entry.value,
					})),
			}
		);
		const unregister = runtime.register({
			backend,
			projections: new Map([[Product.tableId, (record) => ({ title: record.title })]]),
			options: { flushAfterMutations: 1, maxFlushAgeMilliseconds: 10, rebuildBackoffMilliseconds: 1 },
		});
		try {
			await waitFor(() => runtime.getReadiness(backend.id).state === 'ready', { timeout: 10_000 });
			const selectedGeneration = binding.opens.at(-1).generation;
			assert.strictEqual(selectedGeneration, staleGeneration);
			assert.strictEqual(binding.resets, 1);
			const documentId = `${Product.tableId}.${Buffer.from('p1').toString('base64url')}`;
			assert.deepStrictEqual(binding.states.get(selectedGeneration).documents.get(documentId), {
				id: documentId,
				fields: { title: 'recover me' },
			});
		} finally {
			await unregister();
			await runtime.stop();
			runtime = undefined;
		}
	});
});

class FakeNativeFullTextModule {
	constructor() {
		this.NativeFullTextIndex = class {
			encodeMutationBatches() {}
		};
		this.states = new Map();
		this.opens = [];
		this.resets = 0;
	}

	async runtimeInfo() {
		return {
			packageVersion: 'test',
			tantivyVersion: 'test',
			nativeAbiVersion: 4,
			mutationBatchApiVersion: 2,
			storageBackends: ['native'],
		};
	}

	inspectNativeFullTextIndex(options) {
		if (this.inspectError) {
			const code = this.inspectError;
			this.inspectError = undefined;
			return { state: 'incompatible', code };
		}
		const state = this.states.get(options.generation);
		return state?.committedPayload
			? { state: 'checkpointed', committedPayload: state.committedPayload }
			: state
				? { state: 'cursorless' }
				: { state: 'missing' };
	}

	async resetNativeFullTextIndex() {
		this.resets++;
		this.states.clear();
		return { state: 'missing' };
	}

	async openNativeFullTextIndex(options) {
		this.opens.push(options);
		let state = this.states.get(options.generation);
		if (!state) {
			state = { documents: new Map(), applications: 0, publications: 0, committedPayload: undefined };
			this.states.set(options.generation, state);
		}
		return {
			committedPayload: state.committedPayload,
			encodeMutationBatches(batch) {
				return {
					batches: [
						{
							bytes: Buffer.from(JSON.stringify(batch)),
							mutationCount: batch.upserts.length + batch.deletes.length,
						},
					],
					rejected: [],
					consumedUpserts: batch.upserts.length,
					consumedDeletes: batch.deletes.length,
				};
			},
			async apply(packed) {
				const batch = JSON.parse(Buffer.from(packed).toString());
				for (const document of batch.upserts) state.documents.set(document.id, document);
				for (const id of batch.deletes) state.documents.delete(id);
				state.applications++;
				return batch.upserts.length + batch.deletes.length;
			},
			async publish(payload) {
				state.committedPayload = payload;
				state.publications++;
				this.committedPayload = payload;
				return BigInt(state.publications);
			},
			async close() {},
		};
	}
}

function mutationsFor(backend, recordId) {
	return backend.deliveries.flatMap((batch) =>
		batch.transactions.flatMap((transaction) =>
			transaction.mutations.filter((mutation) => mutation.recordId === recordId)
		)
	);
}
