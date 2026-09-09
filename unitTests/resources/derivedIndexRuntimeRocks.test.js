require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
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
		runtime.register({
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
	});
});

function mutationsFor(backend, recordId) {
	return backend.deliveries.flatMap((batch) =>
		batch.transactions.flatMap((transaction) =>
			transaction.mutations.filter((mutation) => mutation.recordId === recordId)
		)
	);
}
