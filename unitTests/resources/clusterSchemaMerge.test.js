require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { getDatabases, resetDatabases, table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { forComponent } = require('#src/utility/logging/harper_logger');
const env = require('#src/utility/environment/environmentManager');
const terms = require('#src/utility/hdbTerms');

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
			{ name: 'tag', type: 'String', indexed: true, nullable: false },
		];
		const Indexed = table({ table: 'ClusterMergeRecovery', database: 'test', schemaDefined: true, attributes });
		let lastPut;
		for (let i = 0; i < 10; i++) lastPut = Indexed.put({ id: 'k-' + i, tag: i % 2 ? 'odd' : 'even' });
		await lastPut;
		if (Indexed.indexingOperation) await Indexed.indexingOperation;
		const completedBuild = Indexed.indexingOperation;

		// A build abandoned by a dead process, on a descriptor another worker re-declared after this
		// worker's live list was loaded — adding `enumerable` and dropping `nullable`. The index is parked
		// with isIndexing pinned on, and the recovery must rebuild that declaration, not the stale snapshot.
		const key = 'ClusterMergeRecovery/tag';
		const abandoned = { ...Indexed.dbisDB.getSync(key), enumerable: true, indexingPID: 999999 };
		delete abandoned.nullable;
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
		const recoveredDescriptor = Recovered.dbisDB.getSync(key);
		assert.strictEqual(
			recoveredDescriptor.enumerable,
			true,
			'recovery dropped a field the newer durable declaration added'
		);
		assert.strictEqual(
			recoveredDescriptor.nullable,
			undefined,
			'recovery restored a field the newer durable declaration removed, from the stale live snapshot'
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

	it('registers an index the durable descriptor declares and the incoming definition omits', async () => {
		const Indexed = table({
			table: 'ClusterMergeStaleIndex',
			database: 'test',
			schemaDefined: false,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'tag', type: 'String', indexed: true },
			],
		});
		if (Indexed.indexingOperation) await Indexed.indexingOperation;
		await catalogFlushed(Indexed);
		// the durable index was built without null entries
		const staleKey = 'ClusterMergeStaleIndex/tag';
		const written = Indexed.dbisDB.put(staleKey, { ...Indexed.dbisDB.getSync(staleKey), indexNulls: false });
		if (written?.then) await written;
		// emulate a worker whose live list predates the locally declared index: only the descriptor has it
		Indexed.attributes.splice(
			Indexed.attributes.findIndex((attribute) => attribute.name === 'tag'),
			1
		);
		delete Indexed.indices.tag;

		const AfterPeer = table({
			table: 'ClusterMergeStaleIndex',
			database: 'test',
			schemaDefined: false,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'tag', type: 'String', indexNulls: true },
			],
			origin: 'cluster',
		});
		assert.strictEqual(
			AfterPeer.attributes.find((attribute) => attribute.name === 'tag').indexed,
			true,
			'a definition omitting `indexed` overrode the durable declaration in the live attribute list'
		);
		assert.ok(
			AfterPeer.indices.tag,
			'the index the durable descriptor declares was not registered, so this worker stops indexing writes to it'
		);
		assert.strictEqual(
			AfterPeer.indices.tag.indexNulls,
			false,
			'an index the durable descriptor declares as holding no null entries was registered as null-capable, so null searches would trust it'
		);
		await catalogFlushed(AfterPeer);
		assert.strictEqual(
			AfterPeer.dbisDB.getSync(staleKey).indexed,
			true,
			'the durable index declaration was overwritten by the incoming definition'
		);
	});

	it('keeps a legacy (v4-era) index descriptor registered', async () => {
		const Legacy = table({
			table: 'ClusterMergeLegacy',
			database: 'test',
			schemaDefined: false,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'tag', type: 'String', indexed: true },
			],
		});
		await catalogFlushed(Legacy);
		// a descriptor written by harperdb 4.x: the index is implied by `attribute`, with no `indexed`
		const key = 'ClusterMergeLegacy/tag';
		const legacyDescriptor = { ...Legacy.dbisDB.getSync(key), attribute: 'tag' };
		delete legacyDescriptor.name;
		delete legacyDescriptor.indexed;
		const written = Legacy.dbisDB.put(key, legacyDescriptor);
		if (written?.then) await written;
		delete Legacy.indices.tag; // a worker that has not opened this index yet

		const AfterPeer = table({
			table: 'ClusterMergeLegacy',
			database: 'test',
			schemaDefined: false,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'tag', type: 'String', indexed: true },
			],
			origin: 'cluster',
		});
		assert.ok(
			AfterPeer.indices.tag,
			'a legacy descriptor, which implies the index rather than declaring it, lost its index registration'
		);
		const live = AfterPeer.attributes.find((attribute) => attribute.name === 'tag');
		assert.strictEqual(live.indexed, true, 'restating from a legacy descriptor stripped `indexed` off the attribute');
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

	it('does not name a locally derived field the peer never sent in the discard warn', async () => {
		const storageLogger = forComponent('storage');
		const originalWarn = storageLogger.warn;
		const warnings = [];
		const Local = table({
			table: 'ClusterMergeDerived',
			database: 'test',
			schemaDefined: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'tag', type: 'String', indexed: true },
			],
		});
		await catalogFlushed(Local);
		const local = Local.attributes.find((attribute) => attribute.name === 'tag');
		assert.strictEqual(local.indexNulls, true, 'the local index registration must derive indexNulls');
		storageLogger.warn = (...args) => warnings.push(args);
		try {
			// distinct objects, as harper-pro's peer definitions are — a peer declares `type`, never `indexNulls`
			table({
				table: 'ClusterMergeDerived',
				database: 'test',
				schemaDefined: true,
				attributes: [
					{ name: 'id', type: 'ID', isPrimaryKey: true },
					{ name: 'tag', type: 'Int', indexed: true },
				],
				origin: 'cluster',
			});
		} finally {
			storageLogger.warn = originalWarn;
		}
		const discardWarnings = warnings
			.map(([message]) => message)
			.filter((message) => typeof message === 'string' && message.includes('ClusterMergeDerived.tag'));
		assert.strictEqual(
			discardWarnings.length,
			1,
			`the discarded type redefinition must be logged: ${JSON.stringify(warnings)}`
		);
		assert.match(discardWarnings[0], /type/, 'the warning must name the discarded `type` difference');
		assert(
			!discardWarnings[0].includes('indexNulls'),
			`the warning must not blame the peer for a locally derived field: ${discardWarnings[0]}`
		);
	});

	it('accepts and persists a peer-new full-text index without creating an attribute', async () => {
		const Local = table({
			table: 'ClusterMergeFullTextAdd',
			database: 'test',
			schemaDefined: true,
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
			],
		});
		const Merged = table({
			table: 'ClusterMergeFullTextAdd',
			database: 'test',
			origin: 'cluster',
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
			],
			fullTextIndexes: [{ name: 'search', fields: [{ name: 'title' }] }],
		});
		await catalogFlushed(Merged);
		assert.deepStrictEqual(
			Merged.fullTextIndexes.map(({ name }) => name),
			['search']
		);
		assert.strictEqual(
			Merged.attributes.some(({ name }) => name === 'search'),
			false
		);
		assert.deepStrictEqual(
			(
				Local.dbisDB.getSync('ClusterMergeFullTextAdd/id') ?? Local.dbisDB.getSync('ClusterMergeFullTextAdd/')
			).fullTextIndexes.map(({ name }) => name),
			['search']
		);
	});

	it('merges peer declarations per name and keeps conflicting local definitions', async () => {
		const storageLogger = forComponent('storage');
		const originalWarn = storageLogger.warn;
		const warnings = [];
		const Local = table({
			table: 'ClusterMergeFullTextConflict',
			database: 'test',
			schemaDefined: true,
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'description', type: 'String' },
			],
			fullTextIndexes: [{ name: 'search', fields: [{ name: 'title' }] }],
		});
		storageLogger.warn = (...args) => warnings.push(args);
		try {
			table({
				table: 'ClusterMergeFullTextConflict',
				database: 'test',
				origin: 'cluster',
				attributes: Local.attributes.map((attribute) => ({ ...attribute })),
				fullTextIndexes: [
					{ name: 'search', fields: [{ name: 'description' }] },
					{ name: 'titles', fields: [{ name: 'title' }] },
				],
			});
		} finally {
			storageLogger.warn = originalWarn;
		}
		assert.deepStrictEqual(
			Local.fullTextIndexes.map(({ name, fields }) => [name, fields[0].name]),
			[
				['search', 'title'],
				['titles', 'title'],
			]
		);
		assert(
			warnings.some(([message]) =>
				String(message).includes(
					'Ignoring peer redefinition of full-text index test.ClusterMergeFullTextConflict.search'
				)
			),
			`missing full-text conflict warning: ${JSON.stringify(warnings)}`
		);
	});

	it('discards an invalid peer index while retaining other peer schema additions', () => {
		const Local = table({
			table: 'ClusterMergeInvalidFullText',
			database: 'test',
			schemaDefined: true,
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'Int' },
			],
		});
		table({
			table: 'ClusterMergeInvalidFullText',
			database: 'test',
			origin: 'cluster',
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'extra', type: 'String' },
			],
			fullTextIndexes: [{ name: 'search', fields: [{ name: 'title' }] }],
		});
		assert.deepStrictEqual(Local.fullTextIndexes, []);
		assert(Local.attributes.some(({ name }) => name === 'extra'));
	});

	it('validates peer indexes against the durable source descriptor', async () => {
		const Local = table({
			table: 'ClusterMergeDurableFullTextSource',
			database: 'test',
			schemaDefined: true,
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
			],
		});
		await catalogFlushed(Local);
		const sourceKey = 'ClusterMergeDurableFullTextSource/title';
		const written = Local.dbisDB.put(sourceKey, { ...Local.dbisDB.getSync(sourceKey), type: 'Int' });
		if (written?.then) await written;
		table({
			table: 'ClusterMergeDurableFullTextSource',
			database: 'test',
			origin: 'cluster',
			attributes: Local.attributes.map((attribute) => ({ ...attribute })),
			fullTextIndexes: [{ name: 'search', fields: [{ name: 'title' }] }],
		});
		assert.deepStrictEqual(Local.fullTextIndexes, []);
		assert.strictEqual(Local.dbisDB.getSync(sourceKey).type, 'Int');
	});

	it('keeps valid durable declarations and does not revive invalid siblings during peer merge', async () => {
		let Local = table({
			table: 'ClusterMergeInvalidDurableSibling',
			database: 'test',
			schemaDefined: true,
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
			],
			fullTextIndexes: [{ name: 'search', fields: [{ name: 'title' }] }],
		});
		await catalogFlushed(Local);
		let primaryKey = 'ClusterMergeInvalidDurableSibling/id';
		let primary = Local.dbisDB.getSync(primaryKey);
		if (!primary) {
			primaryKey = 'ClusterMergeInvalidDurableSibling/';
			primary = Local.dbisDB.getSync(primaryKey);
		}
		const invalidSibling = { ...Local.fullTextIndexes[0], name: 'broken', fields: [{ name: 'missing', weight: 1 }] };
		const written = Local.dbisDB.put(primaryKey, {
			...primary,
			fullTextIndexes: [Local.fullTextIndexes[0], invalidSibling],
		});
		if (written?.then) await written;

		resetDatabases();
		Local = getDatabases().test.ClusterMergeInvalidDurableSibling;
		assert.deepStrictEqual(
			Local.fullTextIndexes.map(({ name }) => name),
			['search']
		);
		table({
			table: 'ClusterMergeInvalidDurableSibling',
			database: 'test',
			origin: 'cluster',
			attributes: Local.attributes.map((attribute) => ({ ...attribute })),
			fullTextIndexes: [{ name: 'peer', fields: [{ name: 'title' }] }],
		});
		await catalogFlushed(Local);
		assert.deepStrictEqual(
			Local.fullTextIndexes.map(({ name }) => name),
			['peer', 'search']
		);
		assert.deepStrictEqual(
			Local.dbisDB.getSync(primaryKey).fullTextIndexes.map(({ name }) => name),
			['peer', 'search']
		);
	});

	it('drops invalid full-text metadata when creating a table from a peer snapshot', async () => {
		const Created = table({
			table: 'ClusterCreateInvalidFullText',
			database: 'test',
			origin: 'cluster',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'Int' },
			],
			fullTextIndexes: [{ name: 'search', fields: [{ name: 'title' }] }],
		});
		await catalogFlushed(Created);
		assert.deepStrictEqual(Created.fullTextIndexes, []);
		const primary =
			Created.dbisDB.getSync('ClusterCreateInvalidFullText/id') ??
			Created.dbisDB.getSync('ClusterCreateInvalidFullText/');
		assert.strictEqual(primary.fullTextIndexes, undefined);
	});

	it('uses the resolved audit default when a peer snapshot first materializes a table', async () => {
		const previousAuditDefault = env.get(terms.CONFIG_PARAMS.LOGGING_AUDITLOG);
		env.setProperty(terms.CONFIG_PARAMS.LOGGING_AUDITLOG, true);
		try {
			const Created = table({
				table: 'ClusterCreateDefaultAuditFullText',
				database: 'test',
				origin: 'cluster',
				attributes: [
					{ name: 'id', type: 'ID', isPrimaryKey: true },
					{ name: 'title', type: 'String' },
				],
				fullTextIndexes: [{ name: 'search', fields: [{ name: 'title' }] }],
			});
			await catalogFlushed(Created);
			assert.strictEqual(Created.audit, true);
			assert.deepStrictEqual(
				Created.fullTextIndexes.map(({ name }) => name),
				['search']
			);
		} finally {
			env.setProperty(terms.CONFIG_PARAMS.LOGGING_AUDITLOG, previousAuditDefault);
		}
	});

	it('drops duplicate names from a first peer snapshot', async () => {
		const Created = table({
			table: 'ClusterCreateDuplicateFullText',
			database: 'test',
			origin: 'cluster',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'description', type: 'String' },
			],
			fullTextIndexes: [
				{ name: 'search', fields: [{ name: 'title' }] },
				{ name: 'search', fields: [{ name: 'description' }] },
			],
		});
		await catalogFlushed(Created);
		assert.deepStrictEqual(
			Created.fullTextIndexes.map(({ name, fields }) => [name, fields[0].name]),
			[['search', 'title']]
		);
	});

	it('does not let a non-explicit peer call erase a newer durable declaration list', async () => {
		const Local = table({
			table: 'ClusterKeepNewerDurableFullText',
			database: 'test',
			schemaDefined: true,
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
			],
			fullTextIndexes: [{ name: 'search', fields: [{ name: 'title' }] }],
		});
		await catalogFlushed(Local);
		let primaryKey = 'ClusterKeepNewerDurableFullText/id';
		let primary = Local.dbisDB.getSync(primaryKey);
		if (!primary) {
			primaryKey = 'ClusterKeepNewerDurableFullText/';
			primary = Local.dbisDB.getSync(primaryKey);
		}
		const durableIndexes = [Local.fullTextIndexes[0], { ...Local.fullTextIndexes[0], name: 'titles' }];
		const written = Local.dbisDB.put(primaryKey, { ...primary, fullTextIndexes: durableIndexes });
		if (written?.then) await written;

		table({
			table: 'ClusterKeepNewerDurableFullText',
			database: 'test',
			origin: 'cluster',
			attributes: Local.attributes.map((attribute) => ({ ...attribute })),
		});
		await catalogFlushed(Local);
		assert.deepStrictEqual(
			Local.dbisDB.getSync(primaryKey).fullTextIndexes.map(({ name }) => name),
			['search', 'titles']
		);
	});

	it('merges an explicit peer list against disk even when it matches stale live state', async () => {
		const Local = table({
			table: 'ClusterMergeStaleExplicitFullText',
			database: 'test',
			schemaDefined: true,
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
			],
			fullTextIndexes: [{ name: 'search', fields: [{ name: 'title' }] }],
		});
		await catalogFlushed(Local);
		let primaryKey = 'ClusterMergeStaleExplicitFullText/id';
		let primary = Local.dbisDB.getSync(primaryKey);
		if (!primary) {
			primaryKey = 'ClusterMergeStaleExplicitFullText/';
			primary = Local.dbisDB.getSync(primaryKey);
		}
		const durableIndexes = [Local.fullTextIndexes[0], { ...Local.fullTextIndexes[0], name: 'titles' }];
		const written = Local.dbisDB.put(primaryKey, { ...primary, fullTextIndexes: durableIndexes });
		if (written?.then) await written;

		table({
			table: 'ClusterMergeStaleExplicitFullText',
			database: 'test',
			origin: 'cluster',
			attributes: Local.attributes.map((attribute) => ({ ...attribute })),
			fullTextIndexes: Local.fullTextIndexes.map((definition) => ({
				...definition,
				fields: definition.fields.map((field) => ({ ...field })),
			})),
		});
		await catalogFlushed(Local);
		assert.deepStrictEqual(
			Local.dbisDB.getSync(primaryKey).fullTextIndexes.map(({ name }) => name),
			['search', 'titles']
		);
	});
});
