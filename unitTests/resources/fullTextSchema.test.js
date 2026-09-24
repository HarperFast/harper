'use strict';

const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { loadGQLSchema } = require('#src/resources/graphql');
const { compileFullTextDefinitions } = require('#src/resources/fullTextSchema');
const { getDatabases, resetDatabases, table } = require('#src/resources/databases');
const environment = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const rocksDescribe = isLMDB ? describe.skip : describe;
const lmdbDescribe = isLMDB ? describe : describe.skip;

function primaryDescriptor(Table) {
	return Table.dbisDB.getSync(`${Table.tableName}/${Table.primaryKey}`) ?? Table.dbisDB.getSync(`${Table.tableName}/`);
}

function productAttributes() {
	return [
		{ name: 'id', type: 'ID', isPrimaryKey: true },
		{ name: 'title', type: 'String' },
		{ name: 'tags', type: 'array', elements: { type: 'String' } },
	];
}

describe('@fullText declaration compiler', () => {
	it('canonicalizes defaults, ordering, source weights, synonyms, and highlighting', () => {
		const compiled = compileFullTextDefinitions(
			[
				{ name: 'z', fields: [{ name: 'tags', highlight: false }] },
				{
					name: 'a',
					fields: [{ name: 'title', weight: 3, highlight: true }],
					stopWords: false,
					positions: false,
					surfaceTerms: false,
					synonyms: [{ source: 'shoe', replacements: ['sneaker'] }],
					highlighting: { maxFragments: 2, fragmentLength: 120 },
				},
			],
			productAttributes()
		);
		assert.deepStrictEqual(compiled, [
			{
				name: 'a',
				fields: [{ name: 'title', weight: 3, highlight: true }],
				analyzer: 'english@1',
				stopWords: false,
				positions: false,
				surfaceTerms: false,
				synonyms: [{ source: 'shoe', replacements: ['sneaker'] }],
				highlighting: { maxFragments: 2, fragmentLength: 120 },
			},
			{
				name: 'z',
				fields: [{ name: 'tags', weight: 1, highlight: false }],
				analyzer: 'english@1',
				stopWords: true,
				positions: true,
				surfaceTerms: true,
				synonyms: [],
			},
		]);
	});

	for (const [label, definition, pattern] of [
		['unknown source', { name: 'search', fields: [{ name: 'missing' }] }, /unknown source field/],
		['unsupported type', { name: 'search', fields: [{ name: 'id' }] }, /must be String or \[String\]/],
		['non-positive weight', { name: 'search', fields: [{ name: 'title', weight: 0 }] }, /greater than zero/],
		['unversioned analyzer', { name: 'search', fields: [{ name: 'title' }], analyzer: 'english' }, /english@1/],
		[
			'duplicate source',
			{ name: 'search', fields: [{ name: 'title' }, { name: 'title' }] },
			/declares source field.*more than once/,
		],
		[
			'duplicate synonym replacement',
			{
				name: 'search',
				fields: [{ name: 'title' }],
				synonyms: [{ source: 'shoe', replacements: ['sneaker', 'sneaker'] }],
			},
			/duplicate replacements/,
		],
		[
			'invalid highlighting limit',
			{ name: 'search', fields: [{ name: 'title' }], highlighting: { maxFragments: 0 } },
			/positive integer/,
		],
	]) {
		it(`rejects ${label}`, () => {
			assert.throws(() => compileFullTextDefinitions([definition], productAttributes()), pattern);
		});
	}

	it('rejects computed and relationship sources', () => {
		for (const source of [
			{ name: 'derived', type: 'String', computed: true },
			{ name: 'related', type: 'String', relationship: {} },
		]) {
			assert.throws(
				() => compileFullTextDefinitions([{ name: 'search', fields: [{ name: source.name }] }], [source]),
				/must be stored record data/
			);
		}
	});
});

rocksDescribe('@fullText RocksDB schema lifecycle', () => {
	before(() => setupTestDBPath());

	it('loads a repeatable directive and keeps the index out of the record schema', async () => {
		await loadGQLSchema(`
			type FullTextSchemaProduct
				@table(audit: true)
				@fullText(name: "title", fields: [{ name: "title", weight: 3 }])
				@fullText(
					name: "catalog"
					fields: [{ name: "title" }, { name: "tags", highlight: false }]
					positions: false
					surfaceTerms: false
					highlighting: { maxFragments: 2, fragmentLength: 120 }
				) {
				id: ID @primaryKey
				title: String
				tags: [String]
			}
		`);
		const Table = tables.FullTextSchemaProduct;
		assert.deepStrictEqual(
			Table.fullTextIndexes.map(({ name }) => name),
			['catalog', 'title']
		);
		assert.strictEqual(
			Table.attributes.some(({ name }) => name === 'catalog'),
			false
		);
		assert.strictEqual(Table.indices.catalog, undefined);
		assert.strictEqual(primaryDescriptor(Table).fullTextIndexes.length, 2);
		assert.strictEqual(Table.dbisDB.getSync('FullTextSchemaProduct/catalog'), undefined);
	});

	it('persists, replaces, removes, and reloads canonical metadata', async () => {
		const database = 'fulltext_schema_lifecycle';
		const declare = (weight, include = true) => `
			type FullTextLifecycle
				@table(database: "${database}", audit: true)
				${include ? `@fullText(name: "search", fields: [{ name: "title", weight: ${weight} }])` : ''} {
				id: ID @primaryKey
				title: String
			}
		`;
		await loadGQLSchema(declare(1));
		await loadGQLSchema(declare(4));
		let Table = getDatabases()[database].FullTextLifecycle;
		if (Table.dbisDB.committed) await Table.dbisDB.committed;
		assert.strictEqual(primaryDescriptor(Table).fullTextIndexes[0].fields[0].weight, 4);

		resetDatabases();
		Table = getDatabases()[database].FullTextLifecycle;
		assert.strictEqual(Table.fullTextIndexes[0].fields[0].weight, 4);

		await loadGQLSchema(declare(1, false));
		Table = getDatabases()[database].FullTextLifecycle;
		if (Table.dbisDB.committed) await Table.dbisDB.committed;
		assert.deepStrictEqual(Table.fullTextIndexes, []);
		assert.strictEqual(primaryDescriptor(Table).fullTextIndexes, undefined);
	});

	it('requires audit and rejects source removal or retyping unless the declaration changes with it', async () => {
		assert.throws(
			() =>
				table({
					table: 'FullTextWithoutAudit',
					database: 'test',
					attributes: productAttributes(),
					fullTextIndexes: [{ name: 'search', fields: [{ name: 'title' }] }],
				}),
			/must explicitly enable audit logging/
		);

		const Table = table({
			table: 'FullTextSourceGuard',
			database: 'test',
			audit: true,
			attributes: productAttributes(),
			fullTextIndexes: [{ name: 'search', fields: [{ name: 'title' }] }],
		});
		assert.throws(
			() =>
				table({
					table: Table.tableName,
					database: Table.databaseName,
					audit: true,
					attributes: productAttributes().filter(({ name }) => name !== 'title'),
				}),
			/unknown source field/
		);
		assert.throws(
			() =>
				table({
					table: Table.tableName,
					database: Table.databaseName,
					audit: true,
					attributes: productAttributes().map((attribute) =>
						attribute.name === 'title' ? { ...attribute, type: 'Int' } : attribute
					),
				}),
			/must be String or \[String\]/
		);

		const Redeclared = table({
			table: Table.tableName,
			database: Table.databaseName,
			audit: true,
			attributes: productAttributes().filter(({ name }) => name !== 'title'),
			fullTextIndexes: [],
		});
		assert.deepStrictEqual(Redeclared.fullTextIndexes, []);
		assert.strictEqual(primaryDescriptor(Redeclared).fullTextIndexes, undefined);
		assert.strictEqual(Redeclared.dbisDB.getSync('FullTextSourceGuard/title'), undefined);
	});

	it('rejects explicit non-list declarations without mutating live state', () => {
		const Table = table({
			table: 'FullTextListValidation',
			database: 'test',
			audit: true,
			attributes: productAttributes(),
		});
		const schemaVersion = Table.schemaVersion;
		for (const fullTextIndexes of [null, {}, 'search']) {
			assert.throws(
				() =>
					table({
						table: Table.tableName,
						database: Table.databaseName,
						audit: true,
						attributes: productAttributes(),
						fullTextIndexes,
					}),
				(error) => error.statusCode === 400 && /must be a list/.test(error.message)
			);
		}
		assert.strictEqual(Table.schemaVersion, schemaVersion);
		assert.deepStrictEqual(Table.fullTextIndexes, []);
	});

	it('pins inherited audit eligibility when publishing a local declaration', () => {
		const previousAudit = environment.get(CONFIG_PARAMS.LOGGING_AUDITLOG);
		try {
			environment.setProperty(CONFIG_PARAMS.LOGGING_AUDITLOG, true);
			const Table = table({
				table: 'FullTextInheritedAudit',
				database: 'test',
				audit: true,
				attributes: productAttributes(),
			});
			const primary = { ...primaryDescriptor(Table) };
			delete primary.audit;
			Table.dbisDB.put(`${Table.tableName}/${Table.primaryKey}`, primary);

			table({
				table: Table.tableName,
				database: Table.databaseName,
				attributes: productAttributes(),
				fullTextIndexes: [{ name: 'search', fields: [{ name: 'title' }] }],
			});
			assert.strictEqual(primaryDescriptor(Table).audit, true);
			assert.strictEqual(primaryDescriptor(Table).fullTextIndexes[0].name, 'search');

			environment.setProperty(CONFIG_PARAMS.LOGGING_AUDITLOG, false);
			resetDatabases();
			const Reloaded = getDatabases().test.FullTextInheritedAudit;
			assert.strictEqual(Reloaded.fullTextIndexes[0].name, 'search');
		} finally {
			environment.setProperty(CONFIG_PARAMS.LOGGING_AUDITLOG, previousAudit);
		}
	});

	it('keeps boolean-less peer metadata inactive even when the global audit default is enabled', async () => {
		const previousAudit = environment.get(CONFIG_PARAMS.LOGGING_AUDITLOG);
		try {
			environment.setProperty(CONFIG_PARAMS.LOGGING_AUDITLOG, true);
			const Table = table({
				table: 'FullTextPeerWithoutDurableAudit',
				database: 'test',
				audit: true,
				attributes: productAttributes(),
			});
			const primary = { ...primaryDescriptor(Table) };
			delete primary.audit;
			primary.fullTextIndexes = compileFullTextDefinitions(
				[{ name: 'search', fields: [{ name: 'title' }] }],
				productAttributes()
			);
			Table.dbisDB.put(`${Table.tableName}/${Table.primaryKey}`, primary);
			if (Table.dbisDB.committed) await Table.dbisDB.committed;

			resetDatabases();
			const Reloaded = getDatabases().test.FullTextPeerWithoutDurableAudit;
			assert.deepStrictEqual(Reloaded.fullTextIndexes, []);
			assert.strictEqual(primaryDescriptor(Reloaded).fullTextIndexes[0].name, 'search');
		} finally {
			environment.setProperty(CONFIG_PARAMS.LOGGING_AUDITLOG, previousAudit);
		}
	});

	it('does not override a durable audit opt-out from ambient or peer settings', async () => {
		const previousAudit = environment.get(CONFIG_PARAMS.LOGGING_AUDITLOG);
		try {
			environment.setProperty(CONFIG_PARAMS.LOGGING_AUDITLOG, true);
			const Table = table({
				table: 'FullTextAuditOptOut',
				database: 'test',
				audit: false,
				attributes: productAttributes(),
			});
			if (Table.dbisDB.committed) await Table.dbisDB.committed;
			assert.throws(
				() =>
					table({
						table: Table.tableName,
						database: Table.databaseName,
						attributes: productAttributes(),
						fullTextIndexes: [{ name: 'search', fields: [{ name: 'title' }] }],
					}),
				/must enable audit logging/
			);

			const AfterPeer = table({
				table: Table.tableName,
				database: Table.databaseName,
				audit: true,
				attributes: [],
				fullTextIndexes: [{ name: 'search', fields: [{ name: 'title' }] }],
				origin: 'cluster',
			});
			assert.strictEqual(primaryDescriptor(AfterPeer).audit, false);
			assert.deepStrictEqual(AfterPeer.fullTextIndexes, []);
			assert.strictEqual(primaryDescriptor(AfterPeer).fullTextIndexes[0].name, 'search');
		} finally {
			environment.setProperty(CONFIG_PARAMS.LOGGING_AUDITLOG, previousAudit);
		}
	});

	it('quarantines malformed persisted metadata and heals it on a peer merge', async () => {
		const Table = table({
			table: 'FullTextMalformedMetadata',
			database: 'test',
			audit: true,
			attributes: productAttributes(),
			fullTextIndexes: [{ name: 'search', fields: [{ name: 'title' }] }],
		});
		if (Table.dbisDB.committed) await Table.dbisDB.committed;
		Table.dbisDB.put(`${Table.tableName}/${Table.primaryKey}`, {
			...primaryDescriptor(Table),
			fullTextIndexes: 1n,
		});

		assert.doesNotThrow(() =>
			table({
				table: Table.tableName,
				database: Table.databaseName,
				audit: true,
				attributes: [...productAttributes(), { name: 'description', type: 'String' }],
			})
		);
		assert.strictEqual(primaryDescriptor(Table).fullTextIndexes, 1n);

		table({
			table: Table.tableName,
			database: Table.databaseName,
			attributes: [],
			fullTextIndexes: [{ name: 'description', fields: [{ name: 'description' }] }],
			origin: 'cluster',
		});
		if (Table.dbisDB.committed) await Table.dbisDB.committed;
		assert.deepStrictEqual(
			primaryDescriptor(Table).fullTextIndexes.map(({ name }) => name),
			['description']
		);
	});

	it('orders source and declaration writes so every crash prefix is recoverable', async () => {
		const Removal = table({
			table: 'FullTextRemovalOrder',
			database: 'test',
			audit: true,
			attributes: productAttributes(),
			fullTextIndexes: [{ name: 'search', fields: [{ name: 'title' }] }],
		});
		if (Removal.dbisDB.committed) await Removal.dbisDB.committed;
		let removeOwner = Removal.dbisDB;
		while (removeOwner && !Object.hasOwn(removeOwner, 'removeSync')) removeOwner = Object.getPrototypeOf(removeOwner);
		const originalRemove = removeOwner.removeSync;
		removeOwner.removeSync = function (key, ...args) {
			if (String(key) === 'FullTextRemovalOrder/title') {
				assert.strictEqual(primaryDescriptor(Removal).fullTextIndexes, undefined);
				throw new Error('crash before source removal');
			}
			return originalRemove.call(this, key, ...args);
		};
		try {
			assert.throws(
				() =>
					table({
						table: Removal.tableName,
						database: Removal.databaseName,
						audit: true,
						attributes: productAttributes().filter(({ name }) => name !== 'title'),
						fullTextIndexes: [],
					}),
				/crash before source removal/
			);
		} finally {
			removeOwner.removeSync = originalRemove;
		}
		assert.strictEqual(primaryDescriptor(Removal).fullTextIndexes, undefined);
		assert.deepStrictEqual(Removal.fullTextIndexes, []);
		assert(Removal.dbisDB.getSync('FullTextRemovalOrder/title'));

		const Addition = table({
			table: 'FullTextAdditionOrder',
			database: 'test',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'Int' },
			],
		});
		if (Addition.dbisDB.committed) await Addition.dbisDB.committed;
		let putOwner = Addition.dbisDB;
		while (putOwner && !Object.hasOwn(putOwner, 'putSync')) putOwner = Object.getPrototypeOf(putOwner);
		const originalPut = putOwner.putSync;
		putOwner.putSync = function (key, value, ...args) {
			if (String(key) === 'FullTextAdditionOrder/title' && value?.type === 'String')
				throw new Error('crash before source publication');
			return originalPut.call(this, key, value, ...args);
		};
		try {
			assert.throws(
				() =>
					table({
						table: Addition.tableName,
						database: Addition.databaseName,
						audit: true,
						attributes: productAttributes().filter(({ name }) => name !== 'tags'),
						fullTextIndexes: [{ name: 'search', fields: [{ name: 'title' }] }],
					}),
				/crash before source publication/
			);
		} finally {
			putOwner.putSync = originalPut;
		}
		assert.strictEqual(primaryDescriptor(Addition).fullTextIndexes, undefined);
		assert.strictEqual(Addition.dbisDB.getSync('FullTextAdditionOrder/title').type, 'Int');
		assert.strictEqual(Addition.attributes.find(({ name }) => name === 'title').type, 'Int');
	});

	it('preserves GraphQL-only attribute metadata when a schema update rolls back', async () => {
		const declaration = (titleType, fullText) => `
			type FullTextRollbackDetails {
				label: String
			}
			type FullTextNestedRollback
				@table(database: "test", audit: true)
				${fullText ? '@fullText(name: "search", fields: [{ name: "title" }])' : ''} {
				id: ID @primaryKey
				title: ${titleType}
				details: FullTextRollbackDetails
			}
		`;
		await loadGQLSchema(declaration('String', true));
		const Table = getDatabases().test.FullTextNestedRollback;
		const originalDetails = Table.attributes.find(({ name }) => name === 'details');
		assert.strictEqual(originalDetails.propertyIsEnumerable('properties'), false);

		let putOwner = Table.dbisDB;
		while (putOwner && !Object.hasOwn(putOwner, 'putSync')) putOwner = Object.getPrototypeOf(putOwner);
		const originalPut = putOwner.putSync;
		putOwner.putSync = function (key, value, ...args) {
			if (String(key) === 'FullTextNestedRollback/title' && value?.type === 'Int')
				throw new Error('crash during nested schema update');
			return originalPut.call(this, key, value, ...args);
		};
		try {
			await assert.rejects(loadGQLSchema(declaration('Int', false)), /crash during nested schema update/);
		} finally {
			putOwner.putSync = originalPut;
		}

		const restoredDetails = Table.attributes.find(({ name }) => name === 'details');
		assert.strictEqual(restoredDetails.properties, originalDetails.properties);
		assert.strictEqual(restoredDetails.propertyIsEnumerable('properties'), false);
		assert.strictEqual(Table.attributes.find(({ name }) => name === 'title').type, 'String');
	});

	it('merges peer declarations additively and keeps local definitions authoritative', async () => {
		const Table = table({
			table: 'FullTextPeerMerge',
			database: 'test',
			audit: true,
			attributes: productAttributes(),
			fullTextIndexes: [{ name: 'search', fields: [{ name: 'title', weight: 2 }] }],
		});
		const Merged = table({
			table: Table.tableName,
			database: Table.databaseName,
			attributes: [{ name: 'description', type: 'String' }],
			fullTextIndexes: [
				{ name: 'search', fields: [{ name: 'title', weight: 9 }] },
				{ name: 'description', fields: [{ name: 'description' }] },
			],
			origin: 'cluster',
		});
		if (Merged.dbisDB.committed) await Merged.dbisDB.committed;
		assert.deepStrictEqual(
			Merged.fullTextIndexes.map(({ name }) => name),
			['description', 'search']
		);
		assert.strictEqual(Merged.fullTextIndexes.find(({ name }) => name === 'search').fields[0].weight, 2);
		assert.strictEqual(primaryDescriptor(Merged).fullTextIndexes.length, 2);

		table({
			table: Table.tableName,
			database: Table.databaseName,
			attributes: [{ name: 'another', type: 'String' }],
			origin: 'cluster',
		});
		assert.strictEqual(primaryDescriptor(Merged).fullTextIndexes.length, 2);

		for (const fullTextIndexes of [null, {}]) {
			assert.doesNotThrow(() =>
				table({
					table: Table.tableName,
					database: Table.databaseName,
					attributes: [],
					fullTextIndexes,
					origin: 'cluster',
				})
			);
		}
		assert.strictEqual(primaryDescriptor(Merged).fullTextIndexes.length, 2);

		const AfterPeerAuditFalse = table({
			table: Table.tableName,
			database: Table.databaseName,
			audit: false,
			attributes: [],
			fullTextIndexes: primaryDescriptor(Merged).fullTextIndexes,
			origin: 'cluster',
		});
		assert.strictEqual(primaryDescriptor(AfterPeerAuditFalse).audit, true);
		assert.strictEqual(AfterPeerAuditFalse.fullTextIndexes.length, 2);
	});

	it('keeps peer metadata durable but inactive when audit is unavailable', async () => {
		const Table = table({
			table: 'FullTextInactivePeer',
			database: 'test',
			audit: false,
			attributes: productAttributes(),
		});
		const AfterPeer = table({
			table: Table.tableName,
			database: Table.databaseName,
			attributes: [],
			fullTextIndexes: [{ name: 'search', fields: [{ name: 'title' }] }],
			origin: 'cluster',
		});
		if (AfterPeer.dbisDB.committed) await AfterPeer.dbisDB.committed;
		assert.deepStrictEqual(AfterPeer.fullTextIndexes, []);
		assert.strictEqual(primaryDescriptor(AfterPeer).fullTextIndexes[0].name, 'search');
		assert.match(primaryDescriptor(AfterPeer).fullTextIndexGenerations.search, /^[0-9a-f-]+$/);
	});
});

lmdbDescribe('@fullText LMDB eligibility', () => {
	before(() => setupTestDBPath());

	it('rejects local declarations but retains peer metadata as inactive', async () => {
		assert.throws(
			() =>
				table({
					table: 'FullTextLocalLMDB',
					database: 'test',
					audit: true,
					attributes: productAttributes(),
					fullTextIndexes: [{ name: 'search', fields: [{ name: 'title' }] }],
				}),
			/LMDB storage engine/
		);

		const Peer = table({
			table: 'FullTextPeerLMDB',
			database: 'test',
			audit: true,
			attributes: productAttributes(),
			fullTextIndexes: [{ name: 'search', fields: [{ name: 'title' }] }],
			origin: 'cluster',
		});
		if (Peer.dbisDB.committed) await Peer.dbisDB.committed;
		assert.deepStrictEqual(Peer.fullTextIndexes, []);
		assert.strictEqual(primaryDescriptor(Peer).fullTextIndexes[0].name, 'search');
		assert.match(primaryDescriptor(Peer).fullTextIndexGenerations.search, /^[0-9a-f-]+$/);

		let transactionOwner = Peer.primaryStore.rootStore;
		while (transactionOwner && !Object.hasOwn(transactionOwner, 'transactionSync'))
			transactionOwner = Object.getPrototypeOf(transactionOwner);
		const originalTransaction = transactionOwner.transactionSync;
		let schemaLocks = 0;
		transactionOwner.transactionSync = function (...args) {
			if (new Error().stack.includes('exclusiveLock')) schemaLocks++;
			return originalTransaction.apply(this, args);
		};
		try {
			table({
				table: Peer.tableName,
				database: Peer.databaseName,
				attributes: productAttributes(),
			});
		} finally {
			transactionOwner.transactionSync = originalTransaction;
		}
		assert.strictEqual(schemaLocks, 0);
	});

	it('does not acquire the LMDB schema lock for a plain GraphQL redeclaration', async () => {
		const declaration = `
			type FullTextPlainLMDB @table(database: "test") {
				id: ID @primaryKey
				title: String
			}
		`;
		await loadGQLSchema(declaration);
		const Table = getDatabases().test.FullTextPlainLMDB;
		let transactionOwner = Table.primaryStore.rootStore;
		while (transactionOwner && !Object.hasOwn(transactionOwner, 'transactionSync'))
			transactionOwner = Object.getPrototypeOf(transactionOwner);
		const originalTransaction = transactionOwner.transactionSync;
		let schemaLocks = 0;
		transactionOwner.transactionSync = function (...args) {
			if (new Error().stack.includes('exclusiveLock')) schemaLocks++;
			return originalTransaction.apply(this, args);
		};
		try {
			await loadGQLSchema(declaration);
		} finally {
			transactionOwner.transactionSync = originalTransaction;
		}
		assert.strictEqual(schemaLocks, 0);
	});
});
