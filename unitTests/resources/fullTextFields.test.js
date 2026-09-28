'use strict';

const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { loadGQLSchema } = require('#src/resources/graphql');
const { compileFullTextDefinitions } = require('#src/resources/fullTextSchema');
const { getDatabases } = require('#src/resources/databases');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { deriveCreateSchema, deriveSearchSchema } = require('#src/components/mcp/tools/schemas/derive');

describe('full-text field names', () => {
	it('rejects index names that conflict with current stored attributes', () => {
		const attributes = [{ name: 'title', type: 'String' }];
		assert.throws(
			() => compileFullTextDefinitions([{ name: 'title', fields: [{ name: 'title' }] }], attributes),
			/stored attribute/
		);
	});
});

const rocksDescribe = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? describe.skip : describe;
rocksDescribe('FullText field declarations', () => {
	before(() => setupTestDBPath());

	it('preserves the last type for duplicate ordinary fields', async () => {
		await loadGQLSchema(`
			type DuplicateOrdinaryFields @table(database: "fulltext_fields") {
				id: ID @primaryKey
				value: String
				value: Int
			}
		`);
		const Table = getDatabases().fulltext_fields.DuplicateOrdinaryFields;
		assert.strictEqual(Table.properties.value.type, 'integer');
		assert(Table.attributes.filter(({ name }) => name === 'value').every(({ type }) => type === 'Int'));
	});

	it('compiles forward source references without creating a record property', async () => {
		await loadGQLSchema(`
			type VirtualSearchProduct @table(database: "fulltext_fields", audit: true) {
				catalogSearch: FullText @fullText(fields: [{ name: "title", weight: 3 }, { name: "tags" }])
				id: ID @primaryKey
				title: String
				tags: [String]
			}
		`);
		const Product = getDatabases().fulltext_fields.VirtualSearchProduct;
		assert.strictEqual(Product.fullTextIndexes[0].name, 'catalogSearch');
		assert.strictEqual(Product.fullTextIndexes[0].fields[0].weight, 3);
		assert(!Product.attributes.some(({ name }) => name === 'catalogSearch'));
		assert(!Object.hasOwn(Product.properties, 'catalogSearch'));
		assert(!Object.hasOwn(Product.indices, 'catalogSearch'));
		assert.strictEqual(Product.dbisDB.getSync('VirtualSearchProduct/catalogSearch'), undefined);
		for (const schema of [
			Product.properties,
			deriveCreateSchema(Product.attributes),
			deriveSearchSchema(Product.attributes),
		]) {
			assert(!JSON.stringify(schema).includes('FullText'));
			assert(!JSON.stringify(schema).includes('catalogSearch'));
		}
	});

	let invalidIndex = 0;
	for (const [field, pattern, tableDirective = '@table(audit: true)'] of [
		['search: String @fullText(fields: [{ name: "title" }])', /nullable FullText type/],
		['search: FullText! @fullText(fields: [{ name: "title" }])', /nullable FullText type/],
		['search: [FullText] @fullText(fields: [{ name: "title" }])', /nullable FullText type/],
		['search: FullText', /require.* @fullText/],
		['search: [FullText]', /require.* @fullText/],
		['search: [[FullText!]]', /require.* @fullText/],
		['search: FullText @fullText(name: "other", fields: [{ name: "title" }])', /remove its name argument/],
		['search: FullText @fullText(fields: [{ name: "title" }]) @allow(role: "admin")', /cannot use @allow/],
		['search: FullText @computed @fullText(fields: [{ name: "title" }])', /cannot use @computed/],
		['search: FullText @fullText(fields: [{ name: "search" }])', /unknown source field/],
		['search: FullText @fullText(fields: [{ name: "title" }]) search: String', /conflicts with a stored attribute/],
		['search: String search: FullText @fullText(fields: [{ name: "title" }])', /conflicts with a stored attribute/],
		[
			'search: FullText @fullText(fields: [{ name: "title" }]) search: FullText @fullText(fields: [{ name: "title" }])',
			/declared more than once/,
		],
		['search: FullText @fullText(fields: [{ name: "title" }]) @fullText(fields: [{ name: "title" }])', /exactly one/],
		['search: FullText @fullText(fields: [{ name: "title" }])', /only supported on a @table type/, ''],
		[
			'search: FullText @fullText(fields: [{ name: "title" }])',
			/must be declared on a FullText field/,
			'@table(audit: true) @fullText(name: "search", fields: [{ name: "title" }])',
		],
	]) {
		it(`rejects ${field} (${tableDirective || 'non-table'})`, async () => {
			await assert.rejects(
				loadGQLSchema(
					`type InvalidFullTextField${invalidIndex++} ${tableDirective} { id: ID @primaryKey title: String ${field} }`
				),
				(error) => error.statusCode === 400 && pattern.test(error.message)
			);
		});
	}

	it('protects query-only names on unsealed tables', async () => {
		await loadGQLSchema(`
			type GuardedSearchProduct @table(database: "fulltext_fields", audit: true) {
				id: ID @primaryKey
				title: String
				searchText: FullText @fullText(fields: [{ name: "title" }])
			}
		`);
		const Product = getDatabases().fulltext_fields.GuardedSearchProduct;
		await Product.put('one', { title: 'trail shoes', extra: 'allowed' });
		for (const write of [
			() => Product.put('two', { title: 'shoes', searchText: 'injected' }),
			() => Product.patch('one', { searchText: 'injected' }),
			() => Product.patch('one', Object.assign(Object.create({ searchText: 'inherited' }), { title: 'updated' })),
		]) {
			await assert.rejects(async () => write(), /query-only and cannot be written/);
		}
		for (const query of [
			{ select: ['searchText'] },
			{ select: [{ name: 'searchText' }] },
			{ conditions: [{ attribute: 'searchText', comparator: 'equals', value: 'shoes' }] },
			{ conditions: [{ attribute: ['searchText', 'nested'], comparator: 'equals', value: 'shoes' }] },
			{ sort: { attribute: 'searchText' } },
		]) {
			await assert.rejects(async () => {
				for await (const _record of await Product.search(query)) {
				}
			}, /query-only/);
		}
		await assert.rejects(async () => Product.get({ id: 'one', select: ['searchText'] }), /query-only/);
		const record = await Product.get('one');
		assert.strictEqual(record.extra, 'allowed');
		assert(!Object.hasOwn(record, 'searchText'));
	});

	it('ignores virtual-name permissions in generated projections and preserved update fields', async () => {
		await loadGQLSchema(`
			type PermissionSearchProduct @table(database: "fulltext_fields", audit: true) {
				id: ID @primaryKey
				title: String
				searchText: FullText @fullText(fields: [{ name: "title" }])
			}
		`);
		const Product = getDatabases().fulltext_fields.PermissionSearchProduct;
		await Product.put('one', { title: 'trail shoes' });
		const user = {
			role: {
				permission: {
					fulltext_fields: {
						tables: {
							PermissionSearchProduct: {
								read: true,
								update: true,
								attribute_permissions: [
									{ attribute_name: 'id', read: true, update: true },
									{ attribute_name: 'title', read: true, update: true },
									{ attribute_name: 'searchText', read: true, update: false },
								],
							},
						},
					},
				},
			},
		};
		for (const read of [false, true]) {
			user.role.permission.fulltext_fields.tables.PermissionSearchProduct.attribute_permissions[2].read = read;
			await assert.rejects(
				async () => Product.get({ id: 'one', select: ['searchText'], checkPermission: true }, { user }),
				/query-only/
			);
		}
		const record = await Product.get({ id: 'one', checkPermission: true }, { user });
		assert.deepStrictEqual(record, { id: 'one', title: 'trail shoes' });
		const results = [];
		for await (const result of await Product.search({ checkPermission: true }, { user })) results.push(result);
		assert.deepStrictEqual(results, [{ id: 'one', title: 'trail shoes' }]);
		const updateTarget = new RequestTarget();
		updateTarget.id = 'one';
		updateTarget.checkPermission = true;
		await Product.put(updateTarget, { title: 'updated shoes' }, { user });
		const updated = await Product.get('one');
		assert.strictEqual(updated.title, 'updated shoes');
		assert(!Object.hasOwn(updated, 'searchText'));
	});

	it('rejects nested relationship selections and sorts without rejecting ordinary nested JSON names', async () => {
		await loadGQLSchema(`
			type RelatedSearchProduct @table(database: "fulltext_fields", audit: true) {
				id: ID @primaryKey
				title: String
				details: Any
				searchText: FullText @fullText(fields: [{ name: "title" }])
			}
			type SearchProductOwner @table(database: "fulltext_fields") {
				id: ID @primaryKey
				productId: ID
				product: RelatedSearchProduct @relationship(from: "productId")
				products: [RelatedSearchProduct] @relationship(from: "productId")
			}
		`);
		const { RelatedSearchProduct: Product, SearchProductOwner: Owner } = getDatabases().fulltext_fields;
		await Product.put('one', { title: 'trail shoes', details: { searchText: 'ordinary nested value' } });
		await Owner.put('owner', { productId: 'one' });
		for (const select of [
			[{ name: 'product', select: ['searchText'] }],
			[{ name: 'products', select: ['id'], sort: { attribute: 'searchText' } }],
		]) {
			await assert.rejects(async () => Owner.get({ id: 'owner', select }), /query-only/);
			await assert.rejects(async () => {
				for await (const _record of await Owner.search({ select })) {
				}
			}, /query-only/);
		}
		const records = [];
		for await (const record of await Owner.search({
			select: [{ name: 'product', select: [{ name: 'details', select: ['searchText'] }] }],
		})) {
			records.push(record);
		}
		assert.deepStrictEqual(records, [{ product: { details: { searchText: 'ordinary nested value' } } }]);
	});
});
