'use strict';

const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { loadGQLSchema } = require('#src/resources/graphql');
const { setFullTextNativeBindingForTests } = require('#src/resources/derivedIndexes');
const { compileFullTextDefinition } = require('#src/resources/fullTextSchema');

class SchemaTestNativeModule {
	#payloads = new Map();

	async runtimeInfo() {
		return {
			packageVersion: 'test',
			tantivyVersion: 'test',
			nativeAbiVersion: 2,
			storageBackends: ['native'],
		};
	}

	async openNativeFullTextIndex(options) {
		const payloads = this.#payloads;
		return {
			committedPayload: payloads.get(options.generation),
			async apply(batch) {
				const mutations = JSON.parse(Buffer.from(batch).toString());
				return mutations.upserts.length + mutations.deletes.length;
			},
			async publish(payload) {
				payloads.set(options.generation, payload);
				this.committedPayload = payload;
				return 1n;
			},
			async close() {},
		};
	}

	encodeMutationBatch(batch) {
		return Buffer.from(JSON.stringify(batch));
	}
}

describe('@fullText schema declaration', () => {
	before(() => {
		setupTestDBPath();
		setFullTextNativeBindingForTests(new SchemaTestNativeModule());
	});
	after(async () => {
		for (const Table of Object.values(tables)) {
			if (!Table?.attributes?.some((attribute) => attribute.fullText)) continue;
			const runtime = Table.derivedIndexRuntime;
			Table.derivedIndexRuntime = undefined;
			await runtime?.close();
		}
		setFullTextNativeBindingForTests(undefined);
	});

	it('compiles structured fields and approved defaults into a separate descriptor', async () => {
		await loadGQLSchema(`
			type FullTextProduct @table(audit: true) {
				id: ID @primaryKey
				title: String
				tags: [String]
				search: FullText @fullText(fields: [
					{ name: "title", weight: 3.0 }
					{ name: "tags", highlight: false }
				])
			}
		`);
		const Table = tables.FullTextProduct;
		const attribute = Table.attributes.find((candidate) => candidate.name === 'search');
		assert.deepStrictEqual(attribute.fullText, {
			fields: [
				{ name: 'title', weight: 3 },
				{ name: 'tags', weight: 1, highlight: false },
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
			type FullTextDefaults @table(audit: true) {
				id: ID @primaryKey
				text: String
				search: FullText @fullText(fields: [{ name: "text" }])
			}
		`);
		const definition = tables.FullTextDefaults.attributes.find((attribute) => attribute.name === 'search').fullText;
		assert.deepStrictEqual(definition.synonyms, []);
		assert.strictEqual(definition.highlighting, undefined);
	});

	it('retains Blob as an accepted declaration source for the asynchronous extraction phase', () => {
		const target = { name: 'search', type: 'FullText' };
		const definition = compileFullTextDefinition(target, { fields: [{ name: 'manual' }] }, [
			{ name: 'manual', type: 'Blob' },
			target,
		]);
		assert.deepStrictEqual(definition.fields, [{ name: 'manual', weight: 1 }]);
	});

	it('accepts configurable structural options, synonyms, and opt-in highlighting', async () => {
		await loadGQLSchema(`
			type FullTextOptions @table(audit: true) {
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
			type FullTextMultiple @table(audit: true) {
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
			type FullTextPersistence @table(audit: true) {
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
			type FullTextWriteGuard @table(audit: true) {
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
	});
});
