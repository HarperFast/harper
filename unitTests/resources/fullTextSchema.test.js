'use strict';

const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { loadGQLSchema } = require('#src/resources/graphql');
const { storedFieldsOnly } = require('#src/resources/RecordEncoder');
const { ResourceBridge } = require('#src/dataLayer/harperBridge/ResourceBridge');
const { table } = require('#src/resources/databases');

describe('@fullText schema declaration', () => {
	before(() => setupTestDBPath());

	it('compiles structured fields and approved defaults into a separate descriptor', async () => {
		await loadGQLSchema(`
			type FullTextProduct @table {
				id: ID @primaryKey
				title: String
				tags: [String]
				manual: Blob
				search: FullText @fullText(fields: [
					{ name: "title", weight: 3.0 }
					{ name: "tags", highlight: false }
					{ name: "manual", weight: 0.5, highlight: true }
				])
			}
		`);
		const Table = tables.FullTextProduct;
		const attribute = Table.attributes.find((candidate) => candidate.name === 'search');
		assert.deepStrictEqual(attribute.fullText, {
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
		});
		assert.strictEqual(attribute.indexed, undefined, '@fullText must not create an ordinary index');
		assert.strictEqual(attribute.hidden, true, 'the query handle must stay out of generated record schemas');
		assert.strictEqual(Table.indices.search, undefined);
		assert.strictEqual(Table.properties.search.hidden, true);
	});

	it('keeps synonyms and highlighting disabled unless configured', async () => {
		await loadGQLSchema(`
			type FullTextDefaults @table {
				id: ID @primaryKey
				text: String
				search: FullText @fullText(fields: [{ name: "text" }])
			}
		`);
		const definition = tables.FullTextDefaults.attributes.find((attribute) => attribute.name === 'search').fullText;
		assert.deepStrictEqual(definition.synonyms, []);
		assert.strictEqual(definition.highlighting, undefined);
	});

	it('accepts configurable structural options, synonyms, and opt-in highlighting', async () => {
		await loadGQLSchema(`
			type FullTextOptions @table {
				id: ID @primaryKey
				text: String
				search: FullText @fullText(
					fields: [{ name: "text", weight: 2 }]
					analyzer: "english@1"
					stopWords: false
					positions: false
					surfaceTerms: false
					synonyms: [{ source: "sneaker", replacements: ["shoe", "trainer"] }]
					highlighting: { maxFragments: 2, fragmentLength: 180 }
				)
			}
		`);
		const definition = tables.FullTextOptions.attributes.find((attribute) => attribute.name === 'search').fullText;
		assert.deepStrictEqual(definition, {
			fields: [{ name: 'text', weight: 2 }],
			analyzer: 'english@1',
			stopWords: false,
			positions: false,
			surfaceTerms: false,
			synonyms: [{ source: 'sneaker', replacements: ['shoe', 'trainer'] }],
			highlighting: { maxFragments: 2, fragmentLength: 180 },
		});
	});

	it('supports multiple independent declarations on one table', async () => {
		await loadGQLSchema(`
			type FullTextMultiple @table {
				id: ID @primaryKey
				title: String
				description: String
				titleSearch: FullText @fullText(fields: [{ name: "title" }])
				bodySearch: FullText @fullText(fields: [{ name: "description" }])
			}
		`);
		const definitions = tables.FullTextMultiple.attributes.filter((attribute) => attribute.fullText);
		assert.deepStrictEqual(
			definitions.map((attribute) => [attribute.name, attribute.fullText.fields[0].name]),
			[
				['titleSearch', 'title'],
				['bodySearch', 'description'],
			]
		);
	});

	it('persists declaration changes in the canonical table descriptor', async () => {
		const declaration = (weight) => `
			type FullTextPersistence @table {
				id: ID @primaryKey
				text: String
				search: FullText @fullText(fields: [{ name: "text", weight: ${weight} }])
			}
		`;
		await loadGQLSchema(declaration(1));
		let Table = tables.FullTextPersistence;
		if (Table.dbisDB.committed) await Table.dbisDB.committed;
		assert.strictEqual(Table.dbisDB.getSync('FullTextPersistence/search').fullText.fields[0].weight, 1);

		await loadGQLSchema(declaration(4));
		Table = tables.FullTextPersistence;
		if (Table.dbisDB.committed) await Table.dbisDB.committed;
		assert.strictEqual(Table.dbisDB.getSync('FullTextPersistence/search').fullText.fields[0].weight, 4);
	});

	for (const [name, field, expected] of [
		['wrong target type', 'search: String @fullText(fields: [{ name: "text" }])', /FullText scalar/],
		['missing fields', 'search: FullText @fullText', /non-empty "fields"/],
		['empty fields', 'search: FullText @fullText(fields: [])', /non-empty "fields"/],
		['unknown source', 'search: FullText @fullText(fields: [{ name: "missing" }])', /unknown source field/],
		[
			'unsupported source type',
			'search: FullText @fullText(fields: [{ name: "count" }])',
			/String, \[String\], or Blob/,
		],
		[
			'computed source',
			'derived: String @computed(from: "text")\nsearch: FullText @fullText(fields: [{ name: "derived" }])',
			/must be stored record data/,
		],
		[
			'relationship source',
			'related: String @relationship(from: "text")\nsearch: FullText @fullText(fields: [{ name: "related" }])',
			/must be stored record data/,
		],
		[
			'duplicate source',
			'search: FullText @fullText(fields: [{ name: "text" }, { name: "text" }])',
			/declares source field "text" more than once/,
		],
		['invalid weight', 'search: FullText @fullText(fields: [{ name: "text", weight: 0 }])', /weight greater than zero/],
		['unknown analyzer', 'search: FullText @fullText(fields: [{ name: "text" }], analyzer: "english")', /english@1/],
		[
			'non-boolean option',
			'search: FullText @fullText(fields: [{ name: "text" }], positions: "yes")',
			/must be a Boolean/,
		],
		[
			'ordinary index conflict',
			'search: FullText @indexed @fullText(fields: [{ name: "text" }])',
			/cannot be combined with @indexed/,
		],
		[
			'unknown option',
			'search: FullText @fullText(fields: [{ name: "text" }], path: "elsewhere")',
			/does not support the "path" option/,
		],
		[
			'self-replacing synonym',
			'search: FullText @fullText(fields: [{ name: "text" }], synonyms: [{ source: "shoe", replacements: ["shoe"] }])',
			/cannot replace a term with itself/,
		],
		[
			'invalid highlighting limit',
			'search: FullText @fullText(fields: [{ name: "text" }], highlighting: { maxFragments: 0 })',
			/highlighting.maxFragments/,
		],
		[
			'duplicate nested option',
			'search: FullText @fullText(fields: [{ name: "text", name: "count" }])',
			/declares "name" more than once/,
		],
		[
			'null non-null highlighting limit',
			'search: FullText @fullText(fields: [{ name: "text" }], highlighting: { maxFragments: null })',
			/highlighting.maxFragments/,
		],
		[
			'created-time lifecycle conflict',
			'search: FullText @createdTime @fullText(fields: [{ name: "text" }])',
			/field-lifecycle directive/,
		],
		[
			'updated-time lifecycle conflict',
			'search: FullText @updatedTime @fullText(fields: [{ name: "text" }])',
			/field-lifecycle directive/,
		],
		[
			'expiry lifecycle conflict',
			'search: FullText @expiresAt @fullText(fields: [{ name: "text" }])',
			/field-lifecycle directive/,
		],
		[
			'enumerable conflict',
			'search: FullText @enumerable @fullText(fields: [{ name: "text" }])',
			/cannot be combined with @enumerable/,
		],
		['non-null query handle', 'search: FullText! @fullText(fields: [{ name: "text" }])', /must be nullable/],
	]) {
		it(`rejects ${name}`, async () => {
			await assert.rejects(
				loadGQLSchema(`
					type FullTextInvalid${name.replaceAll(/[^A-Za-z0-9]/g, '')} @table {
						id: ID @primaryKey
						text: String
						count: Int
						${field}
					}
				`),
				(error) => {
					assert.strictEqual(error.statusCode, 400);
					assert.match(error.message, expected);
					return true;
				}
			);
		});
	}

	it('treats a nullable source highlight as unspecified', async () => {
		await loadGQLSchema(`
			type FullTextNullableHighlight @table {
				id: ID @primaryKey
				text: String
				search: FullText @fullText(fields: [{ name: "text", highlight: null }])
			}
		`);
		assert.deepStrictEqual(
			tables.FullTextNullableHighlight.attributes.find(({ name }) => name === 'search').fullText.fields,
			[{ name: 'text', weight: 1 }]
		);
	});

	it('rejects replacing a stored field with a FullText query handle', async () => {
		await loadGQLSchema(`
			type FullTextStoredReplacement @table {
				id: ID @primaryKey
				text: String
				search: String
			}
		`);
		await tables.FullTextStoredReplacement.put({ id: 'one', text: 'source', search: 'stored' });
		await assert.rejects(
			loadGQLSchema(`
				type FullTextStoredReplacement @table {
					id: ID @primaryKey
					text: String
					search: FullText @fullText(fields: [{ name: "text" }])
				}
			`),
			/Declare a new FullText field name instead/
		);
	});

	it('removes a FullText handle before a simultaneously removed source', async () => {
		await loadGQLSchema(`
			type FullTextRemovalOrder @table {
				id: ID @primaryKey
				aSource: String
				zSearch: FullText @fullText(fields: [{ name: "aSource" }])
			}
		`);
		const Table = tables.FullTextRemovalOrder;
		if (Table.dbisDB.committed) await Table.dbisDB.committed;
		const removals = [];
		const databasePrototype = Object.getPrototypeOf(Table.dbisDB);
		const removeSync = databasePrototype.removeSync;
		databasePrototype.removeSync = function (key, ...args) {
			removals.push(String(key));
			return removeSync.call(this, key, ...args);
		};
		try {
			await loadGQLSchema(`
				type FullTextRemovalOrder @table {
					id: ID @primaryKey
				}
			`);
		} finally {
			databasePrototype.removeSync = removeSync;
		}
		assert.deepStrictEqual(removals.slice(0, 2), ['FullTextRemovalOrder/zSearch', 'FullTextRemovalOrder/aSource']);
	});

	it('persists a replacement source and handle before removing the old source', async () => {
		await loadGQLSchema(`
			type FullTextRetargetOrder @table {
				id: ID @primaryKey
				oldSource: String
				search: FullText @fullText(fields: [{ name: "oldSource" }])
			}
		`);
		const Table = tables.FullTextRetargetOrder;
		if (Table.dbisDB.committed) await Table.dbisDB.committed;
		const operations = [];
		const databasePrototype = Object.getPrototypeOf(Table.dbisDB);
		const putSync = databasePrototype.putSync;
		const removeSync = databasePrototype.removeSync;
		databasePrototype.putSync = function (key, ...args) {
			operations.push(`put:${String(key)}`);
			return putSync.call(this, key, ...args);
		};
		databasePrototype.removeSync = function (key, ...args) {
			operations.push(`remove:${String(key)}`);
			return removeSync.call(this, key, ...args);
		};
		const currentSearch = Table.attributes.find(({ name }) => name === 'search');
		const retargetedSearch = Object.create(
			Object.getPrototypeOf(currentSearch),
			Object.getOwnPropertyDescriptors(currentSearch)
		);
		retargetedSearch.fullText = {
			...currentSearch.fullText,
			fields: [{ name: 'newSource', weight: 1 }],
		};
		try {
			table({
				table: 'FullTextRetargetOrder',
				database: 'data',
				schemaDefined: true,
				removedAttributes: ['oldSource'],
				attributes: [
					{ name: 'id', type: 'ID', isPrimaryKey: true },
					{ name: 'newSource', type: 'String' },
					retargetedSearch,
				],
			});
		} finally {
			databasePrototype.putSync = putSync;
			databasePrototype.removeSync = removeSync;
		}
		for (const expected of [
			'put:FullTextRetargetOrder/newSource',
			'put:FullTextRetargetOrder/search',
			'remove:FullTextRetargetOrder/oldSource',
		])
			assert(operations.includes(expected), `missing catalog operation ${expected}: ${operations}`);
		assert(
			operations.indexOf('put:FullTextRetargetOrder/newSource') < operations.indexOf('put:FullTextRetargetOrder/search')
		);
		assert(
			operations.indexOf('put:FullTextRetargetOrder/search') <
				operations.indexOf('remove:FullTextRetargetOrder/oldSource')
		);
	});

	it('persists a retargeted handle before changing its old source type', async () => {
		await loadGQLSchema(`
			type FullTextRetargetedSourceType @table {
				id: ID @primaryKey
				oldSource: String
				newSource: String
				search: FullText @fullText(fields: [{ name: "oldSource" }])
			}
		`);
		const Table = tables.FullTextRetargetedSourceType;
		if (Table.dbisDB.committed) await Table.dbisDB.committed;
		const operations = [];
		const databasePrototype = Object.getPrototypeOf(Table.dbisDB);
		const putSync = databasePrototype.putSync;
		const removeSync = databasePrototype.removeSync;
		databasePrototype.putSync = function (key, ...args) {
			operations.push(`put:${String(key)}`);
			return putSync.call(this, key, ...args);
		};
		databasePrototype.removeSync = function (key, ...args) {
			operations.push(`remove:${String(key)}`);
			return removeSync.call(this, key, ...args);
		};
		const currentSearch = Table.attributes.find(({ name }) => name === 'search');
		const retargetedSearch = Object.create(
			Object.getPrototypeOf(currentSearch),
			Object.getOwnPropertyDescriptors(currentSearch)
		);
		retargetedSearch.fullText = {
			...currentSearch.fullText,
			fields: [{ name: 'newSource', weight: 1 }],
		};
		try {
			table({
				table: 'FullTextRetargetedSourceType',
				database: 'data',
				schemaDefined: true,
				attributes: [
					{ name: 'id', type: 'ID', isPrimaryKey: true },
					{ name: 'oldSource', type: 'Int' },
					{ name: 'newSource', type: 'String' },
					retargetedSearch,
				],
			});
		} finally {
			databasePrototype.putSync = putSync;
			databasePrototype.removeSync = removeSync;
		}
		const removeHandle = operations.indexOf('remove:FullTextRetargetedSourceType/search');
		const updateOldSource = operations.indexOf('put:FullTextRetargetedSourceType/oldSource');
		const replaceHandle = operations.indexOf('put:FullTextRetargetedSourceType/search');
		assert(updateOldSource >= 0, `missing old source update: ${operations}`);
		assert(replaceHandle >= 0, `missing replacement handle write: ${operations}`);
		assert.strictEqual(removeHandle, -1, `retarget unnecessarily removed the handle: ${operations}`);
		assert(replaceHandle < updateOldSource);
	});

	it('updates full-text weights without removing the durable handle', async () => {
		await loadGQLSchema(`
			type FullTextWeightChange @table {
				id: ID @primaryKey
				text: String
				search: FullText @fullText(fields: [{ name: "text", weight: 1 }])
			}
		`);
		const Table = tables.FullTextWeightChange;
		if (Table.dbisDB.committed) await Table.dbisDB.committed;
		const removals = [];
		const databasePrototype = Object.getPrototypeOf(Table.dbisDB);
		const removeSync = databasePrototype.removeSync;
		databasePrototype.removeSync = function (key, ...args) {
			removals.push(String(key));
			return removeSync.call(this, key, ...args);
		};
		try {
			await loadGQLSchema(`
				type FullTextWeightChange @table {
					id: ID @primaryKey
					text: String
					search: FullText @fullText(fields: [{ name: "text", weight: 2 }])
				}
			`);
		} finally {
			databasePrototype.removeSync = removeSync;
		}
		assert.strictEqual(removals.includes('FullTextWeightChange/search'), false);
	});

	it('removes a handle before persisting an incompatible source type', async () => {
		await loadGQLSchema(`
			type FullTextSourceTypeChange @table {
				id: ID @primaryKey
				text: String
				search: FullText @fullText(fields: [{ name: "text" }])
			}
		`);
		const Table = tables.FullTextSourceTypeChange;
		if (Table.dbisDB.committed) await Table.dbisDB.committed;
		const operations = [];
		const databasePrototype = Object.getPrototypeOf(Table.dbisDB);
		const putSync = databasePrototype.putSync;
		const removeSync = databasePrototype.removeSync;
		databasePrototype.putSync = function (key, ...args) {
			operations.push(`put:${String(key)}`);
			return putSync.call(this, key, ...args);
		};
		databasePrototype.removeSync = function (key, ...args) {
			operations.push(`remove:${String(key)}`);
			return removeSync.call(this, key, ...args);
		};
		try {
			table({
				table: 'FullTextSourceTypeChange',
				database: 'data',
				schemaDefined: true,
				removedAttributes: ['search'],
				attributes: [
					{ name: 'id', type: 'ID', isPrimaryKey: true },
					{ name: 'text', type: 'Int' },
				],
			});
		} finally {
			databasePrototype.putSync = putSync;
			databasePrototype.removeSync = removeSync;
		}
		const removeHandle = operations.indexOf('remove:FullTextSourceTypeChange/search');
		const putSource = operations.indexOf('put:FullTextSourceTypeChange/text');
		assert(removeHandle >= 0, `missing handle removal: ${operations}`);
		assert(putSource >= 0, `missing source update: ${operations}`);
		assert(removeHandle < putSource, `source changed before handle removal: ${operations}`);
	});

	it('rejects a FullText field without an index declaration', async () => {
		await assert.rejects(
			loadGQLSchema(`
				type FullTextMissingDeclaration @table {
					id: ID @primaryKey
					search: FullText
				}
			`),
			/requires an @fullText declaration/
		);
	});

	it('rejects FullText nested in a list without an index declaration', async () => {
		await assert.rejects(
			loadGQLSchema(`
				type FullTextListMissingDeclaration @table {
					id: ID @primaryKey
					search: [[FullText]]
				}
			`),
			/must be a scalar with an @fullText declaration/
		);
	});

	it('rejects a full-text declaration outside a table', async () => {
		await assert.rejects(
			loadGQLSchema(`
				type FullTextNested {
					text: String
					search: FullText @fullText(fields: [{ name: "text" }])
				}
			`),
			/@table type/
		);
	});

	it('rejects direct writes to the query-only handle', async () => {
		await loadGQLSchema(`
			type FullTextWriteGuard @table {
				id: ID @primaryKey
				text: String
				search: FullText @fullText(fields: [{ name: "text" }])
			}
		`);
		const instance = new tables.FullTextWriteGuard();
		assert.throws(
			() => instance.validate({ id: 'one', text: 'hello', search: 'not record data' }),
			/Full-text query property search may not be directly assigned/
		);
		const stored = storedFieldsOnly(tables.FullTextWriteGuard.primaryStore.encoder, {
			id: 'one',
			text: 'hello',
			search: 'source or replay data',
		});
		assert.strictEqual(Object.hasOwn(stored, 'search'), false, 'storage projection must remove the query handle');
	});

	it('aggregates query-handle and ordinary validation errors', async () => {
		await loadGQLSchema(`
			type FullTextWriteErrors @table {
				id: ID @primaryKey
				text: String
				search: FullText @fullText(fields: [{ name: "text" }])
			}
		`);
		assert.throws(
			() => new tables.FullTextWriteErrors().validate({ id: 'one', text: 5, search: 'not record data' }),
			(error) => {
				assert.deepStrictEqual(
					error.errors.map(({ path, code }) => [path, code]),
					[
						['search', 'full_text'],
						['text', 'type'],
					]
				);
				return true;
			}
		);
	});

	it('prevents removing a source while its full-text declaration remains', async () => {
		await loadGQLSchema(`
			type FullTextSourceRemoval @table {
				id: ID @primaryKey
				text: String
				search: FullText @fullText(fields: [{ name: "text" }])
			}
		`);
		await assert.rejects(
			tables.FullTextSourceRemoval.removeAttributes(['text']),
			/Cannot remove attribute 'text' while @fullText field 'search' references it/
		);
		await assert.doesNotReject(tables.FullTextSourceRemoval.removeAttributes(['text', 'search']));
	});

	it('checks source removal against the locked durable declaration', async () => {
		await loadGQLSchema(`
			type FullTextDurableSourceRemoval @table {
				id: ID @primaryKey
				text: String
				search: FullText @fullText(fields: [{ name: "text" }])
			}
		`);
		const Table = tables.FullTextDurableSourceRemoval;
		if (Table.dbisDB.committed) await Table.dbisDB.committed;
		assert.throws(
			() =>
				table({
					database: 'data',
					table: 'FullTextDurableSourceRemoval',
					schemaDefined: true,
					attributes: Table.attributes.filter(({ name }) => name !== 'text' && name !== 'search'),
					removedAttributes: ['text'],
				}),
			/Cannot remove attribute 'text' while @fullText field 'search' references it/
		);
	});

	it('removes stale resolved accessors when a query handle becomes stored data', async () => {
		await loadGQLSchema(`
			type FullTextToStored @table {
				id: ID @primaryKey
				text: String
				value: FullText @fullText(fields: [{ name: "text" }])
			}
		`);
		await loadGQLSchema(`
			type FullTextToStored @table {
				id: ID @primaryKey
				text: String
				value: String
			}
		`);
		await tables.FullTextToStored.put({ id: 'one', text: 'source', value: 'stored' });
		assert.strictEqual((await tables.FullTextToStored.get('one')).value, 'stored');
	});

	it('rejects full-text descriptors added outside the schema compiler', async () => {
		await loadGQLSchema(`
			type FullTextAddAttributeGuard @table {
				id: ID @primaryKey
			}
		`);
		await assert.rejects(
			tables.FullTextAddAttributeGuard.addAttributes([{ name: 'search', type: 'FullText' }]),
			/must be declared with @fullText/
		);
		await assert.rejects(
			tables.FullTextAddAttributeGuard.addAttributes([
				{ name: 'search', type: 'String', fullText: { fields: [{ name: 'missing' }] } },
			]),
			/must be declared with @fullText/
		);
	});

	it('rejects full-text descriptors in create_table operations', async () => {
		const bridge = new ResourceBridge();
		for (const attribute of [
			{ name: 'search', type: 'FullText' },
			{ name: 'search', type: 'String', fullText: { fields: [{ name: 'missing' }] } },
		]) {
			await assert.rejects(
				bridge.createTable(undefined, {
					database: 'data',
					table: 'FullTextCreateTableGuard',
					attributes: [{ name: 'id', type: 'ID', is_primary_key: true }, attribute],
				}),
				/must be declared with @fullText/
			);
		}
	});

	it('does not inspect full-text metadata while validating an ordinary table write', async () => {
		await loadGQLSchema(`
			type FullTextOrdinaryWrite @table {
				id: ID @primaryKey
				text: String
			}
		`);
		const text = tables.FullTextOrdinaryWrite.attributes.find((attribute) => attribute.name === 'text');
		Object.defineProperty(text, 'fullText', {
			configurable: true,
			get() {
				throw new Error('ordinary write inspected full-text metadata');
			},
		});
		try {
			assert.doesNotThrow(() => new tables.FullTextOrdinaryWrite().validate({ id: 'one', text: 'hello' }));
		} finally {
			delete text.fullText;
		}
	});
});
