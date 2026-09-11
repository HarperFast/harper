require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
const { LOCAL_ONLY } = require('#src/resources/auditStore');
const { DERIVED_INDEX_ACCEPTED, DerivedIndexRuntime } = require('#src/resources/derivedIndexRuntime');
const {
	decodeFullTextCursorPayload,
	encodeFullTextCursorPayload,
	FullTextDerivedIndexBackend,
} = require('#src/resources/FullTextDerivedIndexBackend');
const { RocksDerivedIndexStorage } = require('#src/resources/RocksDerivedIndexStorage');

describe('DerivedIndexRuntime with an audited RocksDB table', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;

	let runtime;
	before(function () {
		setupTestDBPath();
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
		runtime = new DerivedIndexRuntime(Product.auditStore, (tableId, recordId) => {
			if (tableId !== Product.tableId) throw new Error(`unknown table ${tableId}`);
			const entry = Product.primaryStore.getEntry(recordId);
			return entry?.value ? { version: entry.version, value: entry.value } : undefined;
		});
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

	it('publishes a full-text cursor through Harper RocksDB without replaying its own storage writes', async () => {
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
		const rootStore = Product.primaryStore.rootStore;
		const storeName = '__test_fulltext_runtime';
		const cursorKey = Buffer.from('cursor');
		const seed = new RocksDerivedIndexStorage(rootStore, storeName);
		seed.write(
			[
				{
					type: 'put',
					key: cursorKey,
					value: Buffer.from(encodeFullTextCursorPayload({ format: 1, logs: { local: anchor } })),
				},
			],
			'wal'
		);
		seed.close();

		const lifecycle = new RocksFakeFullTextLifecycle(rootStore, storeName, cursorKey);
		const backend = new FullTextDerivedIndexBackend({
			id: 'rocks-fulltext-products',
			lifecycle,
			encodeMutationBatch: (batch) => Buffer.from(JSON.stringify(batch)),
		});
		runtime = new DerivedIndexRuntime(Product.auditStore, (tableId, recordId) => {
			if (tableId !== Product.tableId) throw new Error(`unknown table ${tableId}`);
			const entry = Product.primaryStore.getEntry(recordId);
			return entry?.value ? { version: entry.version, value: entry.value } : undefined;
		});
		const unregister = runtime.register({
			backend,
			projections: new Map([[Product.tableId, (record) => ({ title: record.title })]]),
			options: { flushAfterMutations: 1, maxFlushAgeMilliseconds: 10 },
		});
		let committedEvents = 0;
		const countCommit = () => committedEvents++;
		rootStore.on('committed', countCommit);

		await Product.put('p1', { title: 'first product' });
		const p1Cursor = [...Product.auditStore.getRange({ start: anchor })]
			.filter((entry) => entry.tableId === Product.tableId && entry.recordId === 'p1')
			.at(-1).txnLogKey;
		await waitFor(() => lifecycle.engines.some((engine) => engine.publications === 1));
		await new Promise((resolve) => setImmediate(resolve));
		const engine = lifecycle.engines.at(-1);
		assert.strictEqual(engine.applications, 1, 'derived storage writes add no source audit entries');
		assert.strictEqual(
			committedEvents,
			5,
			'one source write and four fake-engine writes notify the shared root once each'
		);

		await unregister();
		rootStore.off('committed', countCommit);
		const stored = new RocksDerivedIndexStorage(rootStore, storeName);
		const documentId = `${Product.tableId}.${Buffer.from('p1').toString('base64url')}`;
		assert.deepStrictEqual(JSON.parse(stored.read(Buffer.from(`document/${documentId}`)).toString()), {
			id: documentId,
			fields: { title: 'first product' },
		});
		const storedCursor = decodeFullTextCursorPayload(stored.read(cursorKey).toString());
		assert.strictEqual(storedCursor.logs.local, p1Cursor);
		assert(storedCursor.logs.local > anchor, 'the durable cursor advanced beyond the seeded anchor');
		assert.strictEqual(stored.read(Buffer.from('segment')).toString(), '1');
		stored.close();
		await runtime.stop();
		runtime = undefined;
	});
});

class RocksFakeFullTextLifecycle {
	constructor(rootStore, storeName, cursorKey) {
		this.rootStore = rootStore;
		this.storeName = storeName;
		this.cursorKey = cursorKey;
		this.engines = [];
	}

	async open() {
		const engine = new RocksFakeFullTextEngine(this.rootStore, this.storeName, this.cursorKey);
		this.engines.push(engine);
		return engine;
	}

	async replace() {
		const old = new RocksDerivedIndexStorage(this.rootStore, this.storeName);
		old.drop();
		return this.open();
	}
}

class RocksFakeFullTextEngine {
	constructor(rootStore, storeName, cursorKey) {
		this.storage = new RocksDerivedIndexStorage(rootStore, storeName);
		this.cursorKey = cursorKey;
		this.committedPayload = this.storage.read(cursorKey)?.toString();
		this.applications = 0;
		this.publications = 0;
	}

	async apply(packed) {
		const batch = JSON.parse(Buffer.from(packed).toString());
		for (const document of batch.upserts) {
			this.storage.write(
				[{ type: 'put', key: Buffer.from(`document/${document.id}`), value: Buffer.from(JSON.stringify(document)) }],
				'wal'
			);
			this.storage.write(
				[{ type: 'put', key: Buffer.from(`term/${document.id}`), value: Buffer.from(document.fields.title) }],
				'wal'
			);
		}
		for (const id of batch.deletes) {
			this.storage.write([{ type: 'delete', key: Buffer.from(`document/${id}`) }], 'wal');
			this.storage.write([{ type: 'delete', key: Buffer.from(`term/${id}`) }], 'wal');
		}
		this.storage.write(
			[{ type: 'put', key: Buffer.from('segment'), value: Buffer.from(String(++this.applications)) }],
			'wal'
		);
		return batch.upserts.length + batch.deletes.length;
	}

	async publish(payload) {
		this.storage.write([{ type: 'put', key: this.cursorKey, value: Buffer.from(payload) }], 'wal');
		this.storage.sync();
		this.committedPayload = payload;
		this.publications++;
		return BigInt(this.publications);
	}

	async close() {
		this.storage.close();
	}
}

function mutationsFor(backend, recordId) {
	return backend.deliveries.flatMap((batch) =>
		batch.transactions.flatMap((transaction) =>
			transaction.mutations.filter((mutation) => mutation.recordId === recordId)
		)
	);
}
