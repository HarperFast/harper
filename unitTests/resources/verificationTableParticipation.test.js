// rocksdb-js refuses a verificationTable opt-in on a column family while a handle that does not
// participate is open on it anywhere in the process (ERR_VERIFICATION_TABLE_CONFLICT).
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table, databases, resetDatabases } = require('#src/resources/databases');
const { HierarchicalNavigableSmallWorld } = require('#src/resources/indexes/HierarchicalNavigableSmallWorld');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { waitFor } = require('../waitFor');

const fromAsync = async (iterable) => {
	const results = [];
	for await (const item of iterable) results.push(item);
	return results;
};

describe('verification-table participation of column-family opens', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('changes a plain index to HNSW on a live table, reading the new index without its record cache', async () => {
		const attributes = (vec) => [{ name: 'id', isPrimaryKey: true }, vec];
		const Plain = table({
			table: 'TypeChange',
			database: 'vtParticipation',
			attributes: attributes({ name: 'vec', type: 'Array', indexed: true }),
		});
		await Plain.put('a', { id: 'a', vec: [1, 0, 0] });
		assert.strictEqual(
			Plain.indices.vec.store.verificationTable,
			undefined,
			'premise: the plain index does not opt in'
		);

		const Vector = table({
			table: 'TypeChange',
			database: 'vtParticipation',
			attributes: attributes({ name: 'vec', type: 'Array', indexed: { type: 'HNSW', nativePlane: false } }),
		});
		const index = Vector.indices.vec;
		assert.ok(index.customIndex !== undefined, 'the attribute is now served by the HNSW index');
		assert.strictEqual(index.cache, undefined, 'the conflicting store opens without the record cache');
		assert.notStrictEqual(index.store.verificationTable, true);

		await Vector.put('b', { id: 'b', vec: [0, 1, 0] });
		await Vector.put('c', { id: 'c', vec: [0, 0, 1] });
		// the existing row is backfilled into the new index in the background, which refuses searches until done
		await waitFor(async () => {
			try {
				const nearest = await fromAsync(Vector.search({ sort: { attribute: 'vec', target: [0, 0.9, 0.1] }, limit: 3 }));
				return nearest.length === 3 && nearest[0].id === 'b';
			} catch (error) {
				if (error.name === 'IndexRebuildingError') return false;
				throw error;
			}
		});
	});

	it('switches a thread that only reloads the catalog to the HNSW index another thread declared', async () => {
		const Peer = table({
			table: 'PeerChange',
			database: 'vtParticipation',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'vec', type: 'Array', indexed: true },
			],
		});
		await Peer.put('a', { id: 'a', vec: [1, 0, 0] });
		// what a declaring thread leaves behind: the new descriptor, and the column family cleared for its rebuild
		const descriptor = Peer.dbisDB.getSync('PeerChange/vec');
		Peer.dbisDB.putSync('PeerChange/vec', { ...descriptor, indexed: { type: 'HNSW', nativePlane: false } });
		Peer.indices.vec.clearSync();

		resetDatabases();
		const Reloaded = databases.vtParticipation.PeerChange;
		assert.ok(
			Reloaded.indices.vec.customIndex instanceof HierarchicalNavigableSmallWorld,
			'the reload opened the HNSW index'
		);
		assert.strictEqual(Reloaded.indices.vec.cache, undefined, 'the plain handle is still open in this process');

		await Reloaded.put('z', { id: 'z', vec: [0, 0, 1] });
		const nearest = await fromAsync(Reloaded.search({ sort: { attribute: 'vec', target: [0, 0.1, 0.9] }, limit: 1 }));
		assert.deepStrictEqual(
			nearest.map((record) => record.id),
			['z'],
			"this thread's write reached the HNSW graph"
		);
	});

	it('opens an HNSW index that nothing else holds with its record cache', () => {
		const Fresh = table({
			table: 'FreshVector',
			database: 'vtParticipation',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'vec', type: 'Array', indexed: { type: 'HNSW', nativePlane: false } },
			],
		});
		assert.ok(Fresh.indices.vec.cache !== undefined, 'no conflict, so the fallback is not taken');
		assert.strictEqual(Fresh.indices.vec.store.verificationTable, true);
	});
});
