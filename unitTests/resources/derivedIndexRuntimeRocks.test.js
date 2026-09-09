require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
const { LOCAL_ONLY } = require('#src/resources/auditStore');
const { DERIVED_INDEX_ACCEPTED, DerivedIndexRuntime } = require('#src/resources/derivedIndexRuntime');

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

		unregister();
		await Product.put('after-unregister', { title: 'not indexed' });
		entry = Product.primaryStore.getEntry('after-unregister');
		await Product.evict('after-unregister', entry.value, entry.version);
		assert.strictEqual(
			[...Product.auditStore.getRange({ start: 1 })].some(
				(record) => record.type === 'evict' && record.recordId === 'after-unregister'
			),
			false
		);
	});
});

function mutationsFor(backend, recordId) {
	return backend.deliveries.flatMap((batch) =>
		batch.transactions.flatMap((transaction) =>
			transaction.mutations.filter((mutation) => mutation.recordId === recordId)
		)
	);
}
