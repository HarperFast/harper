require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

// A cluster-origin definition (replication's DB_SCHEMA handshake / replicated define_schema) is a
// snapshot of a peer's eventually-consistent view — it can be captured mid-create or applied by a
// worker whose thread-local map missed a concurrent local create — so table() must apply it
// additively, never removing or redefining what the local schema declares.
describe('cluster-origin schema definitions are additive-only', () => {
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	// LMDB commits catalog writes asynchronously (Rocks aliases put to putSync), so wait for
	// the pending batch before reading descriptors back
	async function catalogFlushed(Table) {
		if (Table.dbisDB.committed) await Table.dbisDB.committed;
	}

	it('a partial cluster definition cannot remove locally declared attributes, and peer-only attributes are added', async () => {
		table({
			table: 'ClusterMergeTest',
			database: 'test',
			schemaDefined: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'name', type: 'String' },
				{ name: 'tag', type: 'String', indexed: true },
			],
		});
		const Merged = table({
			table: 'ClusterMergeTest',
			database: 'test',
			schemaDefined: true,
			attributes: [{ name: 'id', type: 'ID', isPrimaryKey: true }],
			origin: 'cluster',
		});
		const names = Merged.attributes.map((attribute) => attribute.name);
		assert(names.includes('name'), `attribute 'name' was removed by a cluster-origin definition: ${names}`);
		assert(names.includes('tag'), `attribute 'tag' was removed by a cluster-origin definition: ${names}`);
		await catalogFlushed(Merged);
		assert(Merged.dbisDB.getSync('ClusterMergeTest/name'), `catalog descriptor for 'name' was deleted`);
		assert(Merged.dbisDB.getSync('ClusterMergeTest/tag'), `catalog descriptor for 'tag' was deleted`);
		assert(Merged.indices.tag, `index for 'tag' was dropped by a cluster-origin definition`);

		const Added = table({
			table: 'ClusterMergeTest',
			database: 'test',
			schemaDefined: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'extra', type: 'String' },
			],
			origin: 'cluster',
		});
		const addedNames = Added.attributes.map((attribute) => attribute.name);
		assert(addedNames.includes('extra'), `peer-declared attribute 'extra' was not added: ${addedNames}`);
		assert(addedNames.includes('name'), `attribute 'name' was lost while adding a peer attribute: ${addedNames}`);
	});

	it('a cluster definition cannot flip the local schemaDefined declaration, live or durable', async () => {
		const Dynamic = table({
			table: 'ClusterMergeDynamic',
			database: 'test',
			schemaDefined: false,
			attributes: [{ name: 'id', type: 'ID', isPrimaryKey: true }],
		});
		assert.strictEqual(Dynamic.schemaDefined, false);
		const AfterPeer = table({
			table: 'ClusterMergeDynamic',
			database: 'test',
			schemaDefined: true,
			attributes: [{ name: 'id', type: 'ID', isPrimaryKey: true }],
			origin: 'cluster',
		});
		assert.strictEqual(AfterPeer.schemaDefined, false, 'a cluster-origin definition flipped schemaDefined');
		await catalogFlushed(AfterPeer);
		const primaryDescriptor = AfterPeer.dbisDB.getSync('ClusterMergeDynamic/');
		assert.strictEqual(
			primaryDescriptor.schemaDefined,
			false,
			'a cluster-origin definition persisted its schemaDefined into the durable descriptor'
		);
	});

	it('a cluster definition never rewrites an existing durable descriptor from a stale snapshot', async () => {
		const Stale = table({
			table: 'ClusterMergeStale',
			database: 'test',
			schemaDefined: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'score', type: 'String' },
			],
		});
		await catalogFlushed(Stale);
		// another worker committed a newer declaration; this worker's live list still says String
		const key = 'ClusterMergeStale/score';
		const newerDescriptor = { ...Stale.dbisDB.getSync(key), type: 'Int' };
		const written = Stale.dbisDB.put(key, newerDescriptor);
		if (written?.then) await written;
		const After = table({
			table: 'ClusterMergeStale',
			database: 'test',
			schemaDefined: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'score', type: 'String' },
			],
			origin: 'cluster',
		});
		await catalogFlushed(After);
		assert.strictEqual(
			After.dbisDB.getSync(key).type,
			'Int',
			'a cluster-origin call rewrote a newer durable descriptor from its stale snapshot'
		);
	});

	it('local schema authoring still removes attributes it no longer declares', async () => {
		table({
			table: 'ClusterMergeLocal',
			database: 'test',
			schemaDefined: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'name', type: 'String' },
				{ name: 'tag', type: 'String' },
			],
		});
		const Redeclared = table({
			table: 'ClusterMergeLocal',
			database: 'test',
			schemaDefined: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'name', type: 'String' },
			],
		});
		const names = Redeclared.attributes.map((attribute) => attribute.name);
		assert(!names.includes('tag'), `local redeclaration did not remove 'tag': ${names}`);
		await catalogFlushed(Redeclared);
		assert(!Redeclared.dbisDB.getSync('ClusterMergeLocal/tag'), `catalog descriptor for 'tag' survived removal`);
	});
});
