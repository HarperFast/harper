require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

// A cluster-origin table definition (replication's DB_SCHEMA handshake / replicated
// define_schema) can be built from a mid-create or stale snapshot of a peer's table, so it
// must be applied additively: it may add attributes, but never remove or redefine what the
// local schema declares. Before this was enforced, a partial peer snapshot racing a local
// create_table spliced away the locally declared attributes and deleted their catalog
// descriptors, so searches then failed with "unknown attribute" (harper-pro nightly
// replicationLoad flake).
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

	it('a partial cluster definition cannot remove locally declared attributes', async () => {
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
		// simulates ensureTableIfChanged applying a DB_SCHEMA snapshot taken from a peer
		// mid-create, when only the primary key had been registered yet
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
	});

	it('a cluster definition still adds attributes the local table does not have', () => {
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
		const names = Added.attributes.map((attribute) => attribute.name);
		assert(names.includes('extra'), `peer-declared attribute 'extra' was not added: ${names}`);
		assert(names.includes('name'), `attribute 'name' was lost while adding a peer attribute: ${names}`);
	});

	it('a cluster definition cannot flip the local schemaDefined declaration', () => {
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
	});

	it('local schema authoring still removes attributes it no longer declares', async () => {
		const Redeclared = table({
			table: 'ClusterMergeTest',
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
		assert(!Redeclared.dbisDB.getSync('ClusterMergeTest/tag'), `catalog descriptor for 'tag' survived removal`);
	});
});
