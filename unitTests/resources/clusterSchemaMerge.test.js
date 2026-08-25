require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { forComponent } = require('#src/utility/logging/harper_logger');

// Covers the additive-only invariant documented in DESIGN.md: a definition carrying origin 'cluster'
// is a snapshot of a peer's eventually-consistent view, so it may add but never remove or redefine.
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

	it('logs every peer difference it discards, not only a type conflict', async () => {
		const storageLogger = forComponent('storage');
		const originalWarn = storageLogger.warn;
		const warnings = [];
		storageLogger.warn = (...args) => warnings.push(args);
		try {
			table({
				table: 'ClusterMergeDiscard',
				database: 'test',
				schemaDefined: true,
				attributes: [
					{ name: 'id', type: 'ID', isPrimaryKey: true },
					{ name: 'label', type: 'String' },
				],
			});
			table({
				table: 'ClusterMergeDiscard',
				database: 'test',
				schemaDefined: true,
				attributes: [
					{ name: 'id', type: 'ID', isPrimaryKey: true },
					{ name: 'label', type: 'String', indexed: true, nullable: true },
				],
				origin: 'cluster',
			});
			// an explicit falsy value against a local declaration that omits the field is not a difference
			table({
				table: 'ClusterMergeDiscard',
				database: 'test',
				schemaDefined: true,
				attributes: [
					{ name: 'id', type: 'ID', isPrimaryKey: true },
					{ name: 'label', type: 'String', indexed: false },
				],
				origin: 'cluster',
			});
		} finally {
			storageLogger.warn = originalWarn;
		}
		const discardWarnings = warnings
			.map(([message]) => message)
			.filter((message) => typeof message === 'string' && message.includes('ClusterMergeDiscard.label'));
		assert.strictEqual(
			discardWarnings.length,
			1,
			`a discarded peer redefinition must be logged: ${JSON.stringify(warnings)}`
		);
		assert.match(discardWarnings[0], /indexed/, 'the warning must name the discarded `indexed` difference');
		assert.match(discardWarnings[0], /nullable/, 'the warning must name the discarded `nullable` difference');
	});

	it('recovers an abandoned index build even though the peer definition itself is not applied', async () => {
		const attributes = [
			{ name: 'id', type: 'ID', isPrimaryKey: true },
			{ name: 'tag', type: 'String', indexed: true },
		];
		const Indexed = table({ table: 'ClusterMergeRecovery', database: 'test', schemaDefined: true, attributes });
		let lastPut;
		for (let i = 0; i < 10; i++) lastPut = Indexed.put({ id: 'k-' + i, tag: i % 2 ? 'odd' : 'even' });
		await lastPut;
		if (Indexed.indexingOperation) await Indexed.indexingOperation;
		const completedBuild = Indexed.indexingOperation;

		// A build abandoned by a dead process, on a descriptor another worker re-declared (nullable: false)
		// after this worker's live list was loaded: the index is parked with isIndexing pinned on, and the
		// recovery must rebuild the durable declaration rather than this caller's stale snapshot of it.
		const key = 'ClusterMergeRecovery/tag';
		const abandoned = { ...Indexed.dbisDB.getSync(key), nullable: false, indexingPID: 999999 };
		const written = Indexed.dbisDB.put(key, abandoned);
		if (written?.then) await written;

		const Recovered = table({
			table: 'ClusterMergeRecovery',
			database: 'test',
			schemaDefined: true,
			attributes: attributes.map((attribute) => ({ ...attribute })),
			origin: 'cluster',
		});
		assert.notStrictEqual(
			Recovered.indexingOperation,
			completedBuild,
			'a cluster-origin call must still recover an index build abandoned by a dead process'
		);
		await Recovered.indexingOperation;
		await catalogFlushed(Recovered);
		assert.strictEqual(
			Recovered.dbisDB.getSync(key).nullable,
			false,
			'recovery rewrote a newer durable declaration with the stale snapshot of the calling worker'
		);
		assert.strictEqual(
			Recovered.indices.tag.isIndexing,
			false,
			'the recovered index must clear isIndexing; otherwise every query on it fails with IndexRebuildingError'
		);
		const odds = [];
		for await (const record of Recovered.search({ conditions: [{ attribute: 'tag', value: 'odd' }] }))
			odds.push(record);
		assert.strictEqual(odds.length, 5, 'the recovered backfill must index every record');
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
