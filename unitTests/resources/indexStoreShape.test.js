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
});
