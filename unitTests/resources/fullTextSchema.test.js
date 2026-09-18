'use strict';

const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { loadGQLSchema } = require('#src/resources/graphql');
const { compileFullTextDefinitions } = require('#src/resources/fullTextSchema');
const { closeDatabase, getDatabases, resetDatabases, table } = require('#src/resources/databases');

function descriptor(Table) {
	return Table.dbisDB.getSync(`${Table.tableName}/${Table.primaryKey}`) ?? Table.dbisDB.getSync(`${Table.tableName}/`);
}

describe('@fullText table declaration', () => {
	before(() => setupTestDBPath());

	it('compiles defaults into table-level derived-index metadata', async () => {
		await loadGQLSchema(`
			type FullTextProduct
				@table(audit: true)
				@fullText(name: "search", fields: [
					{ name: "title", weight: 3.0 }
					{ name: "tags", highlight: false }
					{ name: "manual", weight: 0.5, highlight: true }
				]) {
				id: ID @primaryKey
				title: String
				tags: [String]
				manual: String
			}
		`);
		const Table = tables.FullTextProduct;
		assert.deepStrictEqual(Table.fullTextIndexes, [
			{
				name: 'search',
				fields: [
					{ name: 'title', weight: 3 },
					{ name: 'tags', weight: 1, highlight: false },
					{ name: 'manual', weight: 0.5, highlight: true },
				],
				analyzer: 'english@1',
				stopWords: true,
				positions: true,
				surfaceTerms: true,
				synonyms: [],
			},
		]);
		assert.strictEqual(
			Table.attributes.some(({ name }) => name === 'search'),
			false
		);
		assert.strictEqual(Object.hasOwn(Table.properties, 'search'), false);
		assert.strictEqual(Table.indices.search, undefined);
	});

	it('accepts configurable structural options, synonyms, and opt-in highlighting', async () => {
		await loadGQLSchema(`
			type FullTextOptions
				@table(audit: true)
				@fullText(
					name: "search"
					fields: [{ name: "text", weight: 2 }]
					analyzer: "english@1"
					stopWords: false
					positions: false
					surfaceTerms: false
					synonyms: [{ source: "sneaker", replacements: ["shoe", "trainer"] }]
					highlighting: { maxFragments: 2, fragmentLength: 180 }
				) {
				id: ID @primaryKey
				text: String
			}
		`);
		assert.deepStrictEqual(tables.FullTextOptions.fullTextIndexes[0], {
			name: 'search',
			fields: [{ name: 'text', weight: 2 }],
			analyzer: 'english@1',
			stopWords: false,
			positions: false,
			surfaceTerms: false,
			synonyms: [{ source: 'sneaker', replacements: ['shoe', 'trainer'] }],
			highlighting: { maxFragments: 2, fragmentLength: 180 },
		});
	});

	it('supports multiple indexes and stores them canonically by name', async () => {
		await loadGQLSchema(`
			type FullTextMultiple
				@table(audit: true)
				@fullText(name: "titleSearch", fields: [{ name: "title" }])
				@fullText(name: "bodySearch", fields: [{ name: "description" }]) {
				id: ID @primaryKey
				title: String
				description: String
			}
		`);
		assert.deepStrictEqual(
			tables.FullTextMultiple.fullTextIndexes.map(({ name, fields }) => [name, fields[0].name]),
			[
				['bodySearch', 'description'],
				['titleSearch', 'title'],
			]
		);
	});

	it('persists declaration changes only on the canonical table descriptor', async () => {
		const declaration = (weight) => `
			type FullTextPersistence
				@table(audit: true)
				@fullText(name: "search", fields: [{ name: "text", weight: ${weight} }]) {
				id: ID @primaryKey
				text: String
			}
		`;
		await loadGQLSchema(declaration(1));
		let Table = tables.FullTextPersistence;
		if (Table.dbisDB.committed) await Table.dbisDB.committed;
		assert.strictEqual(descriptor(Table).fullTextIndexes[0].fields[0].weight, 1);
		assert.strictEqual(Table.dbisDB.getSync('FullTextPersistence/search'), undefined);

		await loadGQLSchema(declaration(4));
		Table = tables.FullTextPersistence;
		if (Table.dbisDB.committed) await Table.dbisDB.committed;
		assert.strictEqual(descriptor(Table).fullTextIndexes[0].fields[0].weight, 4);
	});

	it('reloads declarations from the catalog after a worker-style database reset', async () => {
		const databaseName = 'fulltext_schema_restart';
		await loadGQLSchema(`
			type FullTextRestart
				@table(database: "${databaseName}", audit: true)
				@fullText(name: "search", fields: [{ name: "text" }]) {
				id: ID @primaryKey
				text: String
			}
		`);
		const Before = getDatabases()[databaseName].FullTextRestart;
		if (Before.dbisDB.committed) await Before.dbisDB.committed;

		const rootStore = Before.primaryStore.rootStore;
		let closing;
		const originalClose = rootStore.close.bind(rootStore);
		rootStore.close = (...args) => (closing = originalClose(...args));
		assert(closeDatabase(databaseName));
		await closing;
		resetDatabases();
		const Reopened = getDatabases()[databaseName].FullTextRestart;
		assert.notStrictEqual(Reopened, Before);
		assert.deepStrictEqual(
			Reopened.fullTextIndexes.map(({ name, fields }) => [name, fields[0].name]),
			[['search', 'text']]
		);
		assert.strictEqual(
			Reopened.attributes.some(({ name }) => name === 'search'),
			false
		);
	});

	it('removes the persisted declaration when the schema removes it', async () => {
		await loadGQLSchema(`
			type FullTextRemoval
				@table(audit: true)
				@fullText(name: "search", fields: [{ name: "text" }]) {
				id: ID @primaryKey
				text: String
			}
		`);
		await loadGQLSchema(`
			type FullTextRemoval @table(audit: true) {
				id: ID @primaryKey
				text: String
			}
		`);
		const Table = tables.FullTextRemoval;
		if (Table.dbisDB.committed) await Table.dbisDB.committed;
		assert.deepStrictEqual(Table.fullTextIndexes, []);
		assert.strictEqual(descriptor(Table).fullTextIndexes, undefined);
	});

	it('clears a declaration before removing one of its source rows', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip();
		await loadGQLSchema(`
			type FullTextSourceRemovalOrder
				@table(audit: true)
				@fullText(name: "search", fields: [{ name: "text" }]) {
				id: ID @primaryKey
				text: String @indexed
			}
		`);
		const Table = tables.FullTextSourceRemovalOrder;
		if (Table.indexingOperation) await Table.indexingOperation;
		if (Table.dbisDB.committed) await Table.dbisDB.committed;
		assert(Table.dbisDB.getSync('FullTextSourceRemovalOrder/text'));
		let removeOwner = Table.dbisDB;
		while (removeOwner && !Object.hasOwn(removeOwner, 'removeSync')) removeOwner = Object.getPrototypeOf(removeOwner);
		assert(removeOwner, 'the catalog handle must expose a synchronous remove primitive');
		const originalRemove = removeOwner.removeSync;
		const crashBeforeSourceRemoval = function (key, ...args) {
			if (String(key) === 'FullTextSourceRemovalOrder/text') {
				assert.strictEqual(descriptor(Table).fullTextIndexes, undefined);
				throw new Error('simulated crash before source removal');
			}
			return originalRemove.call(this, key, ...args);
		};
		removeOwner.removeSync = crashBeforeSourceRemoval;
		try {
			assert.throws(
				() =>
					table({
						table: 'FullTextSourceRemovalOrder',
						database: 'test',
						schemaDefined: true,
						audit: true,
						attributes: [{ name: 'id', type: 'ID', isPrimaryKey: true }],
						fullTextIndexes: [],
					}),
				/simulated crash before source removal/
			);
		} finally {
			removeOwner.removeSync = originalRemove;
		}
		assert.strictEqual(descriptor(Table).fullTextIndexes, undefined);
		assert(Table.dbisDB.getSync('FullTextSourceRemovalOrder/text'));
	});

	it('preserves dynamic record data with the same name as an index', async () => {
		await loadGQLSchema(`
			type FullTextDynamicCollision @table(audit: true) {
				id: ID @primaryKey
				title: String
			}
		`);
		let Table = tables.FullTextDynamicCollision;
		await Table.put({ id: 'one', title: 'before', search: 'record data' });
		await loadGQLSchema(`
			type FullTextDynamicCollision
				@table(audit: true)
				@fullText(name: "search", fields: [{ name: "title" }]) {
				id: ID @primaryKey
				title: String
			}
		`);
		Table = tables.FullTextDynamicCollision;
		await Table.patch('one', { title: 'after' });
		const record = await Table.get('one');
		assert.strictEqual(record.search, 'record data');
		assert.strictEqual(record.title, 'after');
	});

	it('requires audit logging before publishing a declaration', async () => {
		await assert.rejects(
			loadGQLSchema(`
				type FullTextAuditRequired
					@table(audit: false)
					@fullText(name: "search", fields: [{ name: "text" }]) {
					id: ID @primaryKey
					text: String
				}
			`),
			/must explicitly enable audit logging/
		);
	});

	it('rejects duplicate index names', async () => {
		await assert.rejects(
			loadGQLSchema(`
				type FullTextDuplicate
					@table(audit: true)
					@fullText(name: "search", fields: [{ name: "title" }])
					@fullText(name: "search", fields: [{ name: "description" }]) {
					id: ID @primaryKey
					title: String
					description: String
				}
			`),
			/declared more than once/
		);
	});

	it('rejects table directives outside a table and field-level declarations', async () => {
		await assert.rejects(
			loadGQLSchema(`
				type FullTextNotTable @fullText(name: "search", fields: [{ name: "text" }]) {
					text: String
				}
			`),
			/only supported on a @table type/
		);
		await assert.rejects(
			loadGQLSchema(`
				type FullTextFieldLevel @table(audit: true) {
					id: ID @primaryKey
					text: String @fullText(name: "search", fields: [{ name: "text" }])
				}
			`),
			/must be declared on a @table type/
		);
	});

	it('does not take the LMDB writer lock for an unchanged declaration', async function () {
		if (process.env.HARPER_STORAGE_ENGINE !== 'lmdb') this.skip();
		const declaration = `
			type FullTextNoopReload
				@table(audit: true)
				@fullText(name: "search", fields: [{ name: "text" }]) {
				id: ID @primaryKey
				text: String
			}
		`;
		await loadGQLSchema(declaration);
		const rootStore = tables.FullTextNoopReload.primaryStore.rootStore;
		const originalTransactionSync = rootStore.transactionSync;
		let transactions = 0;
		rootStore.transactionSync = function (...args) {
			transactions++;
			return originalTransactionSync.apply(this, args);
		};
		try {
			await loadGQLSchema(declaration);
		} finally {
			rootStore.transactionSync = originalTransactionSync;
		}
		assert.strictEqual(transactions, 0);
	});

	it('persists computed metadata used to reject invalid peer sources', async () => {
		await loadGQLSchema(`
			type FullTextComputedMetadata @table(audit: true) {
				id: ID @primaryKey
				text: String
				derived: String
			}
		`);
		await loadGQLSchema(`
			type FullTextComputedMetadata @table(audit: true) {
				id: ID @primaryKey
				text: String
				derived: String @computed
			}
		`);
		const Table = tables.FullTextComputedMetadata;
		if (Table.dbisDB.committed) await Table.dbisDB.committed;
		assert.strictEqual(Table.dbisDB.getSync('FullTextComputedMetadata/derived').computed, true);
	});

	it('prevents removing a source while an index references it', async () => {
		await loadGQLSchema(`
			type FullTextRemoveSource
				@table(audit: true)
				@fullText(name: "search", fields: [{ name: "text" }]) {
				id: ID @primaryKey
				text: String
			}
		`);
		await assert.rejects(tables.FullTextRemoveSource.removeAttributes(['text']), /while @fullText index 'search'/);
	});

	it('revalidates retained declarations when a non-schema caller changes a source', () => {
		const Table = table({
			table: 'FullTextRetainedSourceValidation',
			database: 'test',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'text', type: 'String' },
			],
			fullTextIndexes: [{ name: 'search', fields: [{ name: 'text' }] }],
		});
		assert.throws(
			() =>
				table({
					table: 'FullTextRetainedSourceValidation',
					database: 'test',
					audit: true,
					attributes: Table.attributes.map((attribute) =>
						attribute.name === 'text' ? { ...attribute, type: 'Int' } : attribute
					),
				}),
			/must be String/
		);
	});

	it('sorts index names by code point rather than the host locale', () => {
		const definitions = compileFullTextDefinitions(
			[
				{ name: 'ä', fields: [{ name: 'text' }] },
				{ name: 'z', fields: [{ name: 'text' }] },
				{ name: 'A', fields: [{ name: 'text' }] },
			],
			[{ name: 'text', type: 'String' }]
		);
		assert.deepStrictEqual(
			definitions.map(({ name }) => name),
			['A', 'z', 'ä']
		);
	});

	for (const [name, definition, attributes, expected] of [
		['missing name', { fields: [{ name: 'text' }] }, [{ name: 'text', type: 'String' }], /requires.*name/],
		['empty fields', { name: 'search', fields: [] }, [{ name: 'text', type: 'String' }], /non-empty "fields"/],
		['unknown source', { name: 'search', fields: [{ name: 'missing' }] }, [], /unknown source field/],
		['unsupported source', { name: 'search', fields: [{ name: 'count' }] }, [{ name: 'count', type: 'Int' }], /String/],
		[
			'computed source',
			{ name: 'search', fields: [{ name: 'derived' }] },
			[{ name: 'derived', type: 'String', computed: true }],
			/stored record data/,
		],
		[
			'duplicate source',
			{ name: 'search', fields: [{ name: 'text' }, { name: 'text' }] },
			[{ name: 'text', type: 'String' }],
			/more than once/,
		],
		[
			'invalid weight',
			{ name: 'search', fields: [{ name: 'text', weight: 0 }] },
			[{ name: 'text', type: 'String' }],
			/greater than zero/,
		],
		[
			'unknown analyzer',
			{ name: 'search', fields: [{ name: 'text' }], analyzer: 'standard' },
			[{ name: 'text', type: 'String' }],
			/english@1/,
		],
		[
			'unknown option',
			{ name: 'search', fields: [{ name: 'text' }], typo: true },
			[{ name: 'text', type: 'String' }],
			/does not support/,
		],
	]) {
		it(`rejects ${name}`, () => {
			assert.throws(() => compileFullTextDefinitions([definition], attributes), expected);
		});
	}

	it('rejects a relationship source without resolving its lazy type', () => {
		const relationship = { name: 'author', relationship: { from: 'authorId' } };
		Object.defineProperty(relationship, 'type', {
			enumerable: true,
			get() {
				throw new Error('resolved a forward relationship');
			},
		});
		assert.throws(
			() => compileFullTextDefinitions([{ name: 'search', fields: [{ name: 'author' }] }], [relationship]),
			/@relationship/
		);
	});
});
