/**
 * A live attribute change can turn an ordinary index into a custom object index (HNSW) or back.
 * table() reuses a table's open index store across schema changes, but the two kinds are different
 * wrappers over the column family — a dupSort store keyed by value versus a primary-style store
 * keyed by node — so a change of kind must reopen the store as the other wrapper, not drive the
 * rebuild through the old one.
 */
require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { RocksIndexStore } = require('#src/resources/RocksIndexStore');
const { CUSTOM_INDEXES } = require('#src/resources/indexes/customIndexes');
const { registryStatus } = require('@harperfast/rocksdb-js');

// registryStatus() refcounts every open column family under a database's directory as one entry;
// a failed reopen that actually closed its unpublished replacement returns this to its
// pre-attempt value, while a leaked handle would leave it one higher.
function openRefCount(Tbl) {
	const path = Tbl.primaryStore.rootStore.path;
	return registryStatus().find((instance) => instance.path === path)?.refCount ?? 0;
}

describe('index store wrapper follows the index kind across a live attribute change', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return; // the HNSW custom index is RocksDB-only here

	const define = (indexed) =>
		table({
			table: 'IndexShape',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'vector', indexed, type: 'Array' },
			],
		});

	it('reopens the column family as the other wrapper, and keeps the handle when the kind is unchanged', async function () {
		this.timeout(30_000);
		setupTestDBPath();
		setMainIsWorker(true);
		let Tbl = define(true);
		let last;
		for (let i = 0; i < 8; i++) last = Tbl.put({ id: i, vector: [i % 2, i % 3, i % 4] });
		await last;
		const ordinary = Tbl.indices.vector;
		assert.ok(ordinary instanceof RocksIndexStore, 'an ordinary index is a dupSort store');

		Tbl = define({ type: 'HNSW', M: 16 });
		const graph = Tbl.indices.vector;
		assert.ok(!(graph instanceof RocksIndexStore), 'an HNSW index is an object store');
		assert.notStrictEqual(graph, ordinary);
		assert.ok(Tbl.indexingOperation, 'the change of kind rebuilds the index');
		await Tbl.indexingOperation;

		Tbl = define(true);
		const reverted = Tbl.indices.vector;
		assert.ok(reverted instanceof RocksIndexStore, 'back to a dupSort store');
		assert.notStrictEqual(reverted, graph);
		await Tbl.indexingOperation;

		assert.strictEqual(define(true).indices.vector, reverted, 'a same-kind redefinition keeps the handle');
	});

	it('keeps the old handle serving reads when reopening the new wrapper fails', async function () {
		this.timeout(30_000);
		setupTestDBPath();
		setMainIsWorker(true);
		let Tbl = define(true);
		let last;
		for (let i = 0; i < 8; i++) last = Tbl.put({ id: i, vector: [i % 2, i % 3, i % 4] });
		await last;
		const ordinary = Tbl.indices.vector;

		// a custom object-store index whose construction fails on the reopen this test triggers,
		// mirroring a real HNSW initialization failure without depending on its internals
		class FlakyObjectIndex {
			static useObjectStore = true;
			constructor() {
				throw new Error('injected failure: index construction');
			}
		}
		CUSTOM_INDEXES.FlakyTest = FlakyObjectIndex;
		try {
			assert.throws(() => define({ type: 'FlakyTest' }), /injected failure/);
		} finally {
			delete CUSTOM_INDEXES.FlakyTest;
		}

		// the failed reopen must not have left the live table pointing at a handle it already closed
		assert.strictEqual(Tbl.indices.vector, ordinary);
		assert.notEqual(ordinary.status, 'closed');
	});

	it('closes the new handle, not just the old one, when a later step throws before either is published', async function () {
		this.timeout(30_000);
		setupTestDBPath();
		setMainIsWorker(true);
		let Tbl = define(true);
		let last;
		for (let i = 0; i < 8; i++) last = Tbl.put({ id: i, vector: [i % 2, i % 3, i % 4] });
		await last;
		const ordinary = Tbl.indices.vector;
		const baseline = openRefCount(Tbl);

		// the new wrapper opens successfully; the reindex trigger's own existing-data scan (on this
		// table's primary store, not the shared catalog) is where this injects the failure — after the
		// open, before `indices.vector` is reassigned
		const originalGetRange = Tbl.primaryStore.getRange.bind(Tbl.primaryStore);
		Tbl.primaryStore.getRange = () => {
			throw new Error('injected failure: scanning for existing data');
		};
		let reopened;
		try {
			assert.throws(() => {
				reopened = define({ type: 'HNSW', M: 16 });
			}, /injected failure/);
		} finally {
			Tbl.primaryStore.getRange = originalGetRange;
		}

		// neither handle leaked: the old one is still what the live table serves, and the new one —
		// opened but never published — was closed rather than left dangling and unowned. The refcount
		// check is what actually proves the close happened, not just that the OLD handle is untouched.
		assert.strictEqual(Tbl.indices.vector, ordinary);
		assert.notEqual(ordinary.status, 'closed');
		assert.equal(reopened, undefined);
		assert.equal(openRefCount(Tbl), baseline, 'the reopen attempt must not leave a net-new open handle');
	});

	it('leaves a reused store on its committed index definition when the catalog write throws', async function () {
		this.timeout(30_000);
		setupTestDBPath();
		setMainIsWorker(true);
		const defineGraph = (indexed) =>
			table({
				table: 'IndexRebind',
				database: 'test',
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'vector', indexed, type: 'Array' },
				],
			});
		let Tbl = defineGraph({ type: 'HNSW', M: 16 });
		let last;
		for (let i = 0; i < 8; i++) last = Tbl.put({ id: i, vector: [i % 2, i % 3, i % 4] });
		await last;
		await Tbl.indexingOperation;
		const graph = Tbl.indices.vector;
		const committed = graph.customIndex;
		assert.equal(committed.M, 16);

		// an options change of the SAME kind reuses the live handle, so binding the new definition to it
		// before the descriptor write commits would leave this thread indexing under options no other
		// thread and no reload would agree with
		const originalGetRange = Tbl.primaryStore.getRange.bind(Tbl.primaryStore);
		Tbl.primaryStore.getRange = () => {
			throw new Error('injected failure: scanning for existing data');
		};
		try {
			assert.throws(() => defineGraph({ type: 'HNSW', M: 32 }), /injected failure/);
		} finally {
			Tbl.primaryStore.getRange = originalGetRange;
		}

		assert.strictEqual(Tbl.indices.vector, graph, 'the reused handle is still the published one');
		assert.strictEqual(graph.customIndex, committed, 'and still carries the definition that committed');
		assert.equal(graph.customIndex.M, 16);

		// the same change, allowed to complete, does rebind
		Tbl = defineGraph({ type: 'HNSW', M: 32 });
		assert.equal(Tbl.indices.vector.customIndex.M, 32);
		await Tbl.indexingOperation;
	});

	it('leaves every deferred mutation off a reused store when the catalog write itself throws', async function () {
		this.timeout(30_000);
		setupTestDBPath();
		setMainIsWorker(true);
		// its own database, so the catalog store this test makes throw is not the one other suites share
		const defineGraph = (indexed) =>
			table({
				table: 'IndexCatalogWrite',
				database: 'idxcatalogwrite',
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'vector', indexed, type: 'Array' },
				],
			});
		let Tbl = defineGraph({ type: 'HNSW', M: 16 });
		let last;
		for (let i = 0; i < 8; i++) last = Tbl.put({ id: i, vector: [i % 2, i % 3, i % 4] });
		await last;
		await Tbl.indexingOperation;
		const graph = Tbl.indices.vector;
		const committed = graph.customIndex;
		const wasIndexing = graph.isIndexing;

		// the descriptor write is the commit point for a reindex: everything the new definition does to
		// the live store — rebinding the custom index, arming the versioned encoder, marking it
		// rebuilding — has to survive this throwing
		const catalog = Tbl.primaryStore.rootStore.dbisDb;
		const originalPut = catalog.put.bind(catalog);
		catalog.put = () => {
			throw new Error('injected failure: catalog write');
		};
		try {
			assert.throws(() => defineGraph({ type: 'HNSW', M: 32 }), /injected failure/);
		} finally {
			catalog.put = originalPut;
		}

		assert.strictEqual(Tbl.indices.vector, graph);
		assert.strictEqual(graph.customIndex, committed, 'the binding must not outlive a failed catalog write');
		assert.equal(graph.customIndex.M, 16);
		assert.equal(graph.isIndexing, wasIndexing, 'and the store must not be left waiting on a backfill');

		Tbl = defineGraph({ type: 'HNSW', M: 32 });
		assert.equal(Tbl.indices.vector.customIndex.M, 32);
		await Tbl.indexingOperation;
	});

	it('closes a first-time index handle too when a later step throws before it is published', async function () {
		this.timeout(30_000);
		setupTestDBPath();
		setMainIsWorker(true);
		let Tbl = table({
			table: 'IndexShapeFirstTime',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		let last;
		for (let i = 0; i < 8; i++) last = Tbl.put({ id: i, vector: [i % 2, i % 3, i % 4] });
		await last;
		assert.equal(Tbl.indices.vector, undefined, 'no index on vector yet');
		const baseline = openRefCount(Tbl);

		// this attribute has never been indexed before, so its open (unlike the reopen tests above)
		// goes through the "no existing handle" branch — the same rollback must cover it
		const originalGetRange = Tbl.primaryStore.getRange.bind(Tbl.primaryStore);
		Tbl.primaryStore.getRange = () => {
			throw new Error('injected failure: scanning for existing data');
		};
		try {
			assert.throws(
				() =>
					table({
						table: 'IndexShapeFirstTime',
						database: 'test',
						attributes: [
							{ name: 'id', isPrimaryKey: true },
							{ name: 'vector', indexed: true, type: 'Array' },
						],
					}),
				/injected failure/
			);
		} finally {
			Tbl.primaryStore.getRange = originalGetRange;
		}

		assert.equal(Tbl.indices.vector, undefined, 'the failed first-time open must not have been published');
		assert.equal(openRefCount(Tbl), baseline, 'the failed first-time open must not leave a net-new open handle');
	});
});
