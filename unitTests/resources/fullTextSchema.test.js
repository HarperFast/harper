'use strict';

const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { loadGQLSchema } = require('#src/resources/graphql');
const { storedFieldsOnly } = require('#src/resources/RecordEncoder');

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
