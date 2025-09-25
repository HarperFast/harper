require('../test_utils');
const assert = require('assert');
const { getMockLMDBPath } = require('../test_utils');
const { parseQuery } = require('../../resources/search');
const { table } = require('../../resources/databases');
const { transaction } = require('../../resources/transaction');
const { setMainIsWorker } = require('../../server/threads/manageThreads');
let x = 532532;
function random(max) {
	x = (x * 16843009 + 3014898611) >>> 0;
	return x % max;
}

// might want to enable an iteration with NATS being assigned as a source
describe('Querying through Resource API', () => {
	let QueryTable, RelatedTable, ManyToMany, many_to_many_attribute;
	let long_str = 'testing' + Math.random();
	for (let i = 0; i < 100; i++) {
		long_str += 'testing';
	}
	before(async function () {
		getMockLMDBPath();
		setMainIsWorker(true); // TODO: Should be default until changed
		let relationship_attribute = {
			name: 'related',
			type: 'RelatedTable',
			relationship: { from: 'relatedId' },
			definition: {},
		};
		many_to_many_attribute = {
			name: 'manyToMany',
			elements: { type: 'ManyToMany', definition: {} },
			relationship: { from: 'manyToManyIds' },
		};
		QueryTable = table({
			table: 'QueryTable',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
				{ name: 'sparse', indexed: true },
				{ name: 'relatedId', indexed: true },
				{ name: 'notIndexed' },
				{ name: 'manyToManyIds', elements: { type: 'ID' }, indexed: true },
				relationship_attribute,
				many_to_many_attribute,
				{ name: 'computed', computed: true, indexed: true },
				{
					name: 'nestedData',
					properties: [
						{ name: 'id', type: 'String' },
						{ name: 'name', type: 'String' },
					],
				},
			],
		});
		QueryTable.setComputedAttribute('computed', (instance) => instance.name + ' computed');
		const children_of_self_attribute = {
			name: 'childrenOfSelf',
			relationship: { to: 'parentId' },
			elements: { type: 'RelatedTable', definition: {} },
		};
		const parent_of_self_attribute = {
			name: 'parentOfSelf',
			relationship: { from: 'parentId' },
			type: 'RelatedTable',
			definition: {},
		};
		RelatedTable = table({
			table: 'RelatedTable',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true, type: 'Int' },
				{ name: 'aFlag', type: 'Boolean', indexed: true },
				{ name: 'name', indexed: true },
				{ name: 'parentId', indexed: true },
				{
					name: 'relatedToMany',
					relationship: { to: 'relatedId' },
					elements: { type: 'QueryTable', definition: { tableClass: QueryTable } },
				},
				children_of_self_attribute,
				parent_of_self_attribute,
				{
					name: 'badRelationship',
					relationship: { to: 'relatedId' },
					elements: { type: 'BadRomance' },
				},
				{
					name: 'badRelationship2',
					relationship: { to: 'unrelatedId' },
					elements: { type: 'QueryTable', definition: { tableClass: QueryTable } },
				},
				{
					name: 'badRelationship3',
					relationship: { from: 'unrelatedId' },
					type: 'QueryTable',
					definition: { tableClass: QueryTable },
				},
			],
		});
		children_of_self_attribute.elements.definition.tableClass = RelatedTable;
		parent_of_self_attribute.definition.tableClass = RelatedTable;
		ManyToMany = table({
			table: 'ManyToMany',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
				{
					name: 'reverseManyToMany',
					relationship: { to: 'manyToManyIds' },
					elements: { type: 'QueryTable', definition: { tableClass: QueryTable } },
				},
			],
		});
		relationship_attribute.definition.tableClass = RelatedTable;
		many_to_many_attribute.elements.definition.tableClass = ManyToMany;

		for (let i = 0; i < 5; i++) {
			RelatedTable.put({
				id: i,
				name: 'related name ' + i,
				aFlag: i % 3 === 0,
				parentId: i % 2,
			});
		}
		for (let i = 0; i < 25; i++) {
			ManyToMany.put({
				id: i,
				name: i === 17 ? [long_str] : i === 18 ? long_str : 'many-to-many entry ' + i,
			});
		}
		let last;
		for (let i = 0; i < 100; i++) {
			let many_ids = [];
			for (let j = 0; j < i % 5; j++) {
				many_ids.push((j + i) % 29); // even include some that don't exist
			}
			last = QueryTable.put({
				id: 'id-' + i,
				name: i > 0 ? 'name-' + i : null,
				relatedId: i % 5,
				sparse: i % 6 === 2 ? i : null,
				manyToManyIds: many_ids,
				notIndexed: 'not indexed ' + i,
				nestedData: i > 0 ? { id: 'nested-' + i, name: 'nested name ' + i } : null,
			});
		}
		await last;
	});
	// This test should be working. My local reproduction works fine with the code changes. I'm sure this has to do with how I created the tables and records in the `before()` maybe?
	it('should properly evaluate an `and` operation', async function () {
		let results = [];
		for await (let record of QueryTable.search({
			operation: 'and',
			conditions: [
				{ attribute: 'manyToManyIds', value: 1 },
				{ attribute: 'manyToManyIds', value: 2 },
			],
		})) {
			results.push(record);
		}

		for (let result of results) {
			assert(result.manyToManyIds.includes(1) && result.manyToManyIds.includes(2));
		}
	});
	it('should properly evaluate an `or` operation', async function () {
		let results = [];
		for await (let record of QueryTable.search({
			operation: 'or',
			conditions: [
				{ attribute: 'manyToManyIds', value: 1 },
				{ attribute: 'manyToManyIds', value: 2 },
			],
		})) {
			results.push(record);
		}

		for (let result of results) {
			assert(result.manyToManyIds.includes(1) || result.manyToManyIds.includes(2));
		}
	});
	it('Query data in a table with not-equal', async function () {
		let results = [];
		for await (let record of QueryTable.search({
			conditions: [
				{ attribute: 'id', comparator: 'less_than_equal', value: 'id-1' },
				{ attribute: 'name', comparator: 'not_equal', value: null },
			],
		})) {
			results.push(record);
		}
		assert.equal(results.length, 1);
	});
	it('Query data in a table with non-indexed property', async function () {
		let results = [];
		for await (let record of QueryTable.search({
			allowFullScan: true,
			conditions: [{ attribute: 'notIndexed', comparator: 'less_than_equal', value: 'not indexed 4' }],
		})) {
			results.push(record);
		}
		assert.equal(results.length, 35);
	});
	it('Query sparse property in a table with null', async function () {
		let results = [];
		for await (let record of QueryTable.search({
			conditions: [{ attribute: 'sparse', comparator: 'equals', value: null }],
		})) {
			results.push(record);
		}
		assert.equal(results.length, 83);
	});
	it('Query sparse property in a table with not_equal null', async function () {
		let results = [];
		for await (let record of QueryTable.search({
			conditions: [{ attribute: 'sparse', comparator: 'not_equal', value: null }],
		})) {
			results.push(record);
		}
		assert.equal(results.length, 17);
	});
	it('Query property in a table with limit', async function () {
		let results = [];
		for await (let record of QueryTable.search({
			conditions: [{ attribute: 'relatedId', comparator: 'equals', value: 3 }],
			limit: 1,
		})) {
			results.push(record);
		}
		assert.equal(results.length, 1);
	});
	it('Collapse into between query', async function () {
		let query = parseQuery('id=ge=id-2&=le=id-4');
		query.explain = true;
		let explanation = QueryTable.search(query);
		assert.equal(explanation.conditions.length, 1);
		assert.equal(explanation.conditions[0].comparator, 'gele');
		query = parseQuery('id=ge=id-2&=le=id-4');
		let results = [];
		let start_count = QueryTable.primaryStore.readCount;
		for await (let record of QueryTable.search(query)) {
			results.push(record);
		}
		assert.equal(results.length, 23);
		assert(QueryTable.primaryStore.readCount - start_count < 25);
	});
	it('Query on computed index', async function () {
		let results = [];
		for await (let record of QueryTable.search({
			conditions: [{ attribute: 'computed', comparator: 'equals', value: 'name-2 computed' }],
		})) {
			results.push(record);
		}
		assert.equal(results.length, 1);
		assert.equal(results[0].id, 'id-2');
	});
	it('Select with computed index', async function () {
		let results = [];
		for await (let record of QueryTable.search({
			conditions: [{ attribute: 'name', comparator: 'equals', value: 'name-3' }],
			select: ['id', 'computed'],
		})) {
			results.push(record);
		}
		assert.equal(results.length, 1);
		assert.equal(results[0].id, 'id-3');
		assert.equal(results[0].computed, 'name-3 computed');
	});
	it('Sort by nested property', async function () {
		let results = [];
		for await (let record of QueryTable.search({
			conditions: [],
			allowFullScan: true,
			sort: { attribute: ['nestedData', 'name'], descending: true },
		})) {
			results.push(record);
		}
		assert.equal(results.length, 100);
		assert.equal(results[0].nestedData.name, 'nested name 99');
	});
	it('Not equal to null for objects', async function () {
		let results = [];
		for await (let record of QueryTable.search({
			conditions: [
				{
					attribute: 'nestedData',
					comparator: 'not_equal',
					value: null,
				},
			],
		})) {
			results.push(record);
		}
		assert.equal(results.length, 99);
	});

	describe('joins', function () {
		it('Query data in a table with relationships', async function () {
			let results = [];
			for await (let record of QueryTable.search({
				conditions: [{ attribute: 'id', comparator: 'equals', value: 'id-1' }],
				select: ['id', 'related', 'name'],
			})) {
				results.push(record);
			}
			assert.equal(results.length, 1);
			assert.equal(results[0].related.name, 'related name 1');
		});

		it('Query relational data in a table with one-to-many', async function () {
			let results = [];
			for await (let record of RelatedTable.search({
				conditions: [{ attribute: 'id', value: 2 }],
				select: ['id', 'relatedToMany', 'name'],
			})) {
				results.push(record);
			}
			assert.equal(results.length, 1);
			let related = await results[0].relatedToMany;
			assert.equal(related.length, 20);
			assert.equal(related[0].name, 'name-12');
			assert.equal(related[1].name, 'name-17');
		});

		it('Query relational data in a table with many-to-one', async function () {
			let results = [];
			for await (let record of QueryTable.search({
				conditions: [{ attribute: 'id', value: 'id-1' }],
				select: ['id', 'related', 'name'],
			})) {
				results.push(record);
			}
			assert.equal(results.length, 1);
			assert.equal(results[0].related.name, 'related name 1');
		});

		it('Query by simple join with many-to-one', async function () {
			let results = [];
			let start_count = QueryTable.primaryStore.readCount;
			for await (let record of QueryTable.search({
				conditions: [{ attribute: ['related', 'name'], value: 'related name 1' }],
				select: ['id', 'related', 'name'],
			})) {
				results.push(record);
			}
			assert.equal(results.length, 20);
			assert.equal(results[0].related.name, 'related name 1');
			assert.equal(results[0].id, 'id-1');
			assert.equal(results[1].id, 'id-11');
			assert(QueryTable.primaryStore.readCount - start_count < 30);
		});
		it('Query by simple join with many-to-one with primary key of secondary table', async function () {
			let results = [];
			let start_count = QueryTable.primaryStore.readCount;
			for await (let record of QueryTable.search({
				conditions: [{ attribute: ['related', 'id'], value: 2 }],
				select: ['id', 'related', 'name'],
			})) {
				results.push(record);
			}
			assert.equal(results.length, 20);
			assert.equal(results[0].related.name, 'related name 2');
			assert.equal(results[0].id, 'id-12');
			assert.equal(results[1].id, 'id-17');
			assert(QueryTable.primaryStore.readCount - start_count < 30);
		});

		it('Query by simple join with nested partial select', async function () {
			let results = [];
			let start_count = QueryTable.primaryStore.readCount;
			for await (let record of QueryTable.search({
				conditions: [{ attribute: ['related', 'name'], value: 'related name 1' }],
				select: ['id', { name: 'related', select: ['name', { name: 'relatedToMany', select: ['id'] }] }, 'name'],
			})) {
				results.push(record);
			}
			assert.equal(results.length, 20);
			assert.equal(results[0].related.name, 'related name 1');
			assert.equal(results[0].related.id, undefined);
			let many_to_one_to_many = await results[0].related.relatedToMany;
			assert.equal(many_to_one_to_many.length, 20);
			assert(many_to_one_to_many[1].id.startsWith('id-'));
			assert.equal(many_to_one_to_many[1].name, undefined);
		});

		it('Query by simple join with nested partial select using parser', async function () {
			let results = [];
			let start_count = QueryTable.primaryStore.readCount;
			for await (let record of QueryTable.search(
				parseQuery('related.name=related name 1&select(id,related[select(name,relatedToMany{id})])')
			)) {
				results.push(record);
			}
			assert.equal(results.length, 20);
			assert.equal(results[0].related.name, 'related name 1');
			assert.equal(results[0].related.id, undefined);
			let many_to_one_to_many = await results[0].related.relatedToMany;
			assert.equal(many_to_one_to_many.length, 20);
			assert(many_to_one_to_many[1].id.startsWith('id-'));
			assert.equal(many_to_one_to_many[1].name, undefined);
		});

		it('Query by simple join in nested condition using parser', async function () {
			let results = [];
			for await (let record of QueryTable.search(
				parseQuery('id!=null&[id=id-3|id=id-4|related.name=related name' + ' 2]')
			)) {
				results.push(record);
			}
			assert.equal(results.length, 22);
			assert.equal(results[0].id, 'id-3');
			assert.equal(results[2].relatedId, 2);
		});
		it('Query by simple join in more nested condition using parser', async function () {
			let results = [];
			for await (let record of QueryTable.search(
				parseQuery('id!=null&[[id=id-32|id=gt=id-4]&related.name=related name 2]')
			)) {
				results.push(record);
			}
			assert.equal(results.length, 14);
			assert.equal(results[0].id, 'id-32');
			assert.equal(results[2].relatedId, 2);
		});
		it('Query by simple join in other nested condition using parser', async function () {
			let results = [];
			for await (let record of QueryTable.search(
				parseQuery('related.name=lt=related name 2|[id=gt=id-3&[id=lt=id-4|[sparse==null&id=id-89]]]')
			)) {
				results.push(record);
			}
			assert.equal(results.length, 47);
		});
		it('Query by simple join in nested condition with non-matching condition using parser', async function () {
			let results = [];
			for await (let record of QueryTable.search(
				parseQuery('sparse==null&[[name=none|id=lt=id-2]&related.name=ge=related name 4]')
			)) {
				results.push(record);
			}
			assert.equal(results.length, 1);
		});
		it('Query by two joined conditions with many-to-one', async function () {
			let results = [];
			for await (let record of QueryTable.search({
				conditions: [
					{ attribute: ['related', 'name'], comparator: 'greater_than', value: 'related name 1' },
					{ attribute: ['related', 'id'], comparator: 'less_than', value: 4 },
				],
				select: ['id', 'related', 'name'],
			})) {
				results.push(record);
			}
			assert.equal(results.length, 40);
			assert(results.every((record) => record.related.name > 'related name 1'));
			assert(results.every((record) => record.related.id < 4));
		});
		it('Query by joined condition with many-to-one and standard condition (preferring join first)', async function () {
			let results = [];
			let start_count = QueryTable.primaryStore.readCount;
			for await (let record of QueryTable.search({
				conditions: [
					{ attribute: 'id', comparator: 'greater_than', value: 'id-90' },
					{ attribute: ['related', 'name'], comparator: 'equals', value: 'related name 3' },
				],
				select: ['id', 'related', 'name'],
			})) {
				results.push(record);
			}
			assert.equal(results.length, 2);
			assert(QueryTable.primaryStore.readCount - start_count < 30);
		});
		it('Query by joined condition with many-to-one and standard condition (preferring standard first)', async function () {
			let results = [];
			let start_count = QueryTable.primaryStore.readCount;
			for await (let record of QueryTable.search({
				conditions: [
					{ attribute: ['related', 'name'], comparator: 'equals', value: 'related name 3' },
					{ attribute: 'id', comparator: 'equals', value: 'id-93' },
				],
				select: ['id', 'related', 'name'],
			})) {
				results.push(record);
			}
			assert.equal(results.length, 1);
			assert(QueryTable.primaryStore.readCount - start_count < 3);
		});
		it('Query by standard condition and two joined conditions in union', async function () {
			let results = [];
			for await (let record of QueryTable.search({
				conditions: [
					{ attribute: 'id', comparator: 'ge', value: 'id-93' },
					{
						operator: 'or',
						conditions: [
							{ attribute: ['related', 'name'], comparator: 'equals', value: 'related name 3' },
							{ attribute: ['related', 'name'], comparator: 'equals', value: 'related name 1' },
						],
					},
				],
				select: ['id', 'relatedId', 'name'],
			})) {
				results.push(record);
			}
			assert.equal(results.length, 3);
			for (let result of results) {
				assert(result.relatedId === 1 || result.relatedId === 3);
			}
		});

		it('Query by joined condition with many-to-one and multiple joined condition', async function () {
			let results = [];
			let start_count = RelatedTable.primaryStore.readCount;
			for await (let record of QueryTable.search({
				conditions: [
					{ attribute: ['related', 'name'], comparator: 'greater_than_equal', value: 'related name 3' },
					{ attribute: ['related', 'id'], comparator: 'less_than', value: 5 },
				],
				select: ['id', 'related', 'name'],
			})) {
				results.push(record);
			}
			assert.equal(results.length, 40);
		});

		it('Query by join with one-to-many', async function () {
			let results = [];
			for await (let record of RelatedTable.search({
				conditions: { attribute: ['relatedToMany', 'id'], value: 'id-2' },
				select: ['id', 'relatedToMany', 'name'],
			})) {
				results.push(record);
			}
			assert.equal(results.length, 1);
			let related = await results[0].relatedToMany;
			assert.equal(related.length, 1);
			assert.equal(related[0].name, 'name-2');
			assert.equal(results[0].id, 2);
		});
		it('Query by join with one-to-many with multiple conditions', async function () {
			let results = [];
			for await (let record of RelatedTable.search({
				conditions: [
					{ attribute: ['relatedToMany', 'id'], comparator: 'greater_than', value: 'id-2' },
					{ attribute: ['relatedToMany', 'name'], comparator: 'less_than', value: 'name-3' },
				],
				select: ['id', 'relatedToMany', 'name'],
			})) {
				results.push(record);
			}
			assert.equal(results.length, 5);
			let related = await results[0].relatedToMany;
			assert.equal(related.length, 2);
			assert.equal(related[0].name, 'name-20');
		});
		it('Query by join with one-to-many with relational condition as filter', async function () {
			let results = [];
			for await (let record of RelatedTable.search({
				conditions: [
					{ attribute: ['name'], comparator: 'greater_than', value: 'related' },
					{ attribute: ['relatedToMany', 'sparse'], value: null },
				],
				select: ['id', 'relatedToMany', 'name'],
			})) {
				results.push(record);
			}
			assert.equal(results.length, 5);
			let related = await results[0].relatedToMany;
			assert.equal(related.length, 17);
			assert(related.every((r) => r.sparse === null));
		});
		it('Query by join with many-to-many with relational to condition as filter', async function () {
			let results = [];
			for await (let record of ManyToMany.search({
				conditions: [
					{ attribute: ['name'], comparator: 'greater_than', value: 'many' },
					{ attribute: ['reverseManyToMany', 'relatedId'], value: 3 },
				],
				select: ['id', 'reverseManyToMany', 'name'],
			})) {
				results.push(record);
			}
			assert.equal(results.length, 25);
			let related = await results[0].reverseManyToMany;
			assert.equal(related.length, 2);
			assert(related.every((r) => r.relatedId === 3));
		});
		it('Query by join with many-to-many (forward)', async function () {
			let results = [];
			for await (let record of QueryTable.search({
				conditions: [{ attribute: ['manyToMany', 'name'], value: 'many-to-many entry 13' }],
				select: ['id', 'manyToMany', 'manyToManyIds', 'name'],
			})) {
				results.push(record);
			}
			assert.equal(results.length, 8);
			let related = results[0].manyToMany;
			assert.equal(related.length, 1);
			assert.equal(related[0].name, 'many-to-many entry 13');
			related = results[1].manyToMany;
			assert.equal(related.length, 1);
			assert.equal(related[0].name, 'many-to-many entry 13');
		});
		it('Query by join with many-to-many sync iteration', async function () {
			let results = [];
			for (let record of QueryTable.search({
				conditions: [{ attribute: ['manyToMany', 'name'], value: 'many-to-many entry 13' }],
				select: ['id', 'manyToMany', 'manyToManyIds', 'name'],
			})) {
				results.push(record);
			}
			assert.equal(results.length, 8);
			let related = results[0].manyToMany;
			assert.equal(related.length, 1);
			assert.equal(related[0].name, 'many-to-many entry 13');
			related = results[1].manyToMany;
			assert.equal(related.length, 1);
			assert.equal(related[0].name, 'many-to-many entry 13');
		});

		it('Query by joined condition with many-to-many and multiple joined condition', async function () {
			let results = [];
			for await (let record of QueryTable.search({
				conditions: [
					{ attribute: ['manyToMany', 'name'], comparator: 'greater_than', value: 'many-to-many entry 4' },
					{ attribute: ['manyToMany', 'id'], comparator: 'less_than', value: 8 },
				],
				select: ['id', 'manyToMany', 'manyToManyIds', 'name'],
			})) {
				results.push(record);
			}
			assert.equal(results.length, 14);
			for (let result of results) {
				const related = await result.manyToMany;
				assert(related.every((record) => record.name > 'many-to-many entry 4'));
				assert(related.every((record) => record.id < 8));
			}
		});

		it('Query with many-to-many selected, but non-existent entries (forward)', async function () {
			let results = [];
			for await (let record of QueryTable.search({
				conditions: [{ attribute: ['id'], comparator: 'between', value: ['id-27', 'id-29'] }],
				select: ['id', 'manyToMany', 'manyToManyIds', 'name'],
			})) {
				results.push(record);
			}
			assert.equal(results.length, 3);
			assert.equal(results[0].manyToManyIds[0], 27);
			let related = await results[0].manyToMany;
			assert.equal(related.length, 2);
			assert.equal(related[0], undefined);
			assert.equal(related[1], undefined);
			related = await results[1].manyToMany;
			assert.equal(related.length, 3);
			assert.equal(related[0], undefined);
			assert.equal(related[1].name, 'many-to-many entry 0');
		});

		it('Query parent many-to-one self-relationships', async function () {
			let results = [];
			for await (let record of RelatedTable.search({
				conditions: [{ attribute: ['parentOfSelf', 'name'], value: 'related name 1' }],
				select: ['id', 'name', 'parentId', 'parentOfSelf', 'childrenOfSelf'],
			})) {
				results.push(record);
			}
			assert.equal(results.length, 2);
			assert.equal(results[1].parentOfSelf.id, 1);
			assert.equal(results[0].parentId, 1);
			assert.equal(results[0].childrenOfSelf.length, 2);
			assert.equal(results[0].childrenOfSelf[1].parentId, 1);
			assert.equal(results[1].childrenOfSelf.length, 0);
		});
		it('Query children one-to-many self-relationships', async function () {
			let results = [];
			for await (let record of RelatedTable.search({
				conditions: [{ attribute: ['childrenOfSelf', 'id'], comparator: 'between', value: [2, 3] }],
				select: ['id', 'name', 'parentId', 'parentOfSelf', 'childrenOfSelf'],
			})) {
				results.push(record);
			}
			assert.equal(results.length, 2);
			assert.equal(results[0].parentId, 0);
			assert.equal(results[1].parentId, 1);
			assert.equal(results[0].childrenOfSelf.length, 1);
			assert.equal(results[0].childrenOfSelf[0].id, 2);
			assert.equal(results[1].childrenOfSelf.length, 1);
			assert.equal(results[1].childrenOfSelf[0].id, 3);
		});

		it('Query children multi-level recursive self-relationships', async function () {
			let results = [];
			for await (let record of RelatedTable.search({
				conditions: [{ attribute: ['childrenOfSelf', 'childrenOfSelf', 'id'], comparator: 'between', value: [2, 4] }],
				select: [
					'id',
					'name',
					'parentId',
					'parentOfSelf',
					{ name: 'childrenOfSelf', select: ['id', 'name', 'childrenOfSelf'] },
				],
			})) {
				results.push(record);
			}
			assert.equal(results.length, 2);
			assert.equal(results[0].parentId, 0);
			assert.equal(results[1].parentId, 1);
			assert.equal(results[0].childrenOfSelf.length, 1);
			assert.equal(results[0].childrenOfSelf[0].childrenOfSelf.length, 2);
			assert.equal(results[0].childrenOfSelf[0].childrenOfSelf[1].id, 4);
			assert.equal(results[1].childrenOfSelf[0].childrenOfSelf[0].id, 3);
		});

		describe('With filterMissing', function () {
			before(function () {
				many_to_many_attribute.relationship.filterMissing = true;
			});
			after(function () {
				many_to_many_attribute.relationship.filterMissing = false;
			});
			it('Query by with many-to-many selected, but non-existent entries that are filtered', async function () {
				let results = [];
				for await (let record of QueryTable.search({
					conditions: [{ attribute: ['id'], comparator: 'between', value: ['id-27', 'id-29'] }],
					select: ['id', 'manyToMany', 'manyToManyIds', 'name'],
				})) {
					results.push(record);
				}
				let related = await results[0].manyToMany;
				assert.equal(related.length, 0);
				related = await results[1].manyToMany;
				assert.equal(related.length, 2);
			});
		});

		it('Query by join with many-to-many (reverse)', async function () {
			let results = [];
			for await (let record of ManyToMany.search({
				conditions: [
					{ attribute: ['reverseManyToMany', 'name'], comparator: 'between', value: ['name-16', 'name-19'] },
				],
				select: ['id', 'name', 'reverseManyToMany'],
			})) {
				results.push(record);
			}
			assert.equal(results.length, 7);
			assert.equal(results[0].name, 'many-to-many entry 16');
			let related = await results[0].reverseManyToMany;
			assert.equal(related.length, 1);
			assert(related[0].manyToManyIds.includes(16));
		});
		it('Query by double join', async function () {
			let results = [];
			for await (let record of RelatedTable.search({
				conditions: [{ attribute: ['relatedToMany', 'manyToMany', 'name'], value: 'many-to-many entry 13' }],
				select: ['id', 'relatedToMany', 'name'],
			})) {
				results.push(record);
			}
			let related_count = 0;
			assert.equal(results.length, 4);
			assert(
				results.every((record) => {
					related_count += record.relatedToMany.length;
					return record.relatedToMany.every((record) => record.manyToManyIds.includes(13));
				})
			);
			assert.equal(related_count, 8);
		});
		it('Query by double join 2', async function () {
			let results = [];
			for await (let record of ManyToMany.search({
				conditions: [{ attribute: ['reverseManyToMany', 'related', 'name'], value: 'related name 3' }],
				select: ['id', 'reverseManyToMany', 'name'],
			})) {
				results.push(record);
			}
			let related_count = 0;
			assert.equal(results.length, 25);
			assert(
				results.every((record) => {
					related_count += record.reverseManyToMany.length;
					return record.reverseManyToMany.every((record) => record.relatedId === 3);
				})
			);
			assert.equal(related_count, 53);
		});

		it('Query data in a table with join, returning primary key and but use records', async function () {
			let results = [];
			const select = ['id'];
			select.asArray = true;
			for await (let record of QueryTable.search({
				conditions: [
					{ attribute: ['related', 'name'], comparator: 'equals', value: 'related name 3' },
					{ attribute: 'name', comparator: 'greater_than', value: 'name' },
				],
				select,
			})) {
				results.push(record);
			}
			assert.equal(results.length, 20);
			assert.equal(results[0][0], 'id-13');
		});
		it('Explain query in a table with join, returning primary key and but use records', function () {
			const explanation = QueryTable.search({
				conditions: [
					{ attribute: 'name', comparator: 'ne', value: null },
					{ attribute: ['related', 'name'], comparator: 'equals', value: 'related name 3' },
				],
				select: ['id'],
				explain: true,
			});
			assert.equal(explanation.conditions[0].attribute[0], 'related');
			assert(explanation.conditions[0].estimated_count < 1000);
		});
		it('Get and later access related data', async function () {
			let instance = await QueryTable.get('id-1');
			let related = await instance.related;
			assert.equal(related.name, 'related name 1');
		});
	});
	describe('Sorting', function () {
		it('Query data in a table with sorting', async function () {
			let results = [];
			for await (let record of QueryTable.search({
				conditions: [{ attribute: 'id', comparator: 'greater_than', value: 'id-90' }],
				sort: { attribute: 'id', descending: true },
			})) {
				results.push(record);
			}
			assert.equal(results.length, 9);
			assert.equal(results[0].id, 'id-99');
			assert.equal(results[1].id, 'id-98');
		});
		it('Query data in a table with sorting on different property', async function () {
			let results = [];
			for await (let record of QueryTable.search({
				conditions: [{ attribute: 'id', comparator: 'greater_than', value: 'id-90' }],
				sort: { attribute: 'name', descending: true },
			})) {
				results.push(record);
			}
			assert.equal(results.length, 9);
			assert.equal(results[0].id, 'id-99');
			assert.equal(results[1].id, 'id-98');
		});
		it('Query data in a table with narrow constraint sorting on primary key property', async function () {
			let results = [];
			let start_count = QueryTable.primaryStore.readCount;
			for await (let record of QueryTable.search({
				conditions: [{ attribute: 'id', comparator: 'between', value: ['id-90', 'id-95'] }],
				sort: { attribute: 'name', descending: true },
			})) {
				results.push(record);
			}
			assert.equal(results.length, 6);
			assert.equal(results[0].id, 'id-95');
			assert.equal(results[1].id, 'id-94');
			assert(QueryTable.primaryStore.readCount - start_count < 25);
		});
		it('Query data in a table with narrow constraint sorting on different property', async function () {
			let results = [];
			let start_count = QueryTable.primaryStore.readCount;
			for await (let record of QueryTable.search({
				conditions: [{ attribute: 'relatedId', value: 3 }],
				sort: { attribute: 'name', descending: true },
			})) {
				results.push(record);
			}
			assert.equal(results.length, 20);
			assert(QueryTable.primaryStore.readCount - start_count < 25);
			assert.equal(results[0].id, 'id-98');
			assert.equal(results[1].id, 'id-93');
		});
		it('Query data in a table with narrow constraint with multiple sorting on different properties', async function () {
			let results = [];
			for await (let record of QueryTable.search({
				conditions: [{ attribute: 'id', comparator: 'between', value: ['id-90', 'id-95'] }],
				sort: { attribute: 'sparse', next: { attribute: 'name', descending: true } },
			})) {
				results.push(record);
			}
			assert.equal(results.length, 6);
			assert.equal(results[0].id, 'id-95');
			assert.equal(results[1].id, 'id-94');
			assert.equal(results[3].id, 'id-91');
			assert.equal(results[3].sparse, null);
			assert.equal(results[5].id, 'id-92');
			assert.equal(results[5].sparse, 92);
		});
		it('Query data in a table with no constraint with multiple sorting on different properties', async function () {
			let results = [];
			for await (let record of QueryTable.search({
				allowFullScan: true,
				sort: { attribute: 'relatedId', next: { attribute: 'name', descending: true } },
			})) {
				results.push(record);
			}
			assert.equal(results.length, 100);
			assert.equal(results[0].id, 'id-95');
			assert.equal(results[1].id, 'id-90');
			assert.equal(results[2].id, 'id-85');
		});
		it('Query data in a table with contains filter and sorting on same property', async function () {
			let results = [];
			for await (let record of QueryTable.search({
				allowFullScan: true,
				conditions: [{ attribute: 'name', comparator: 'contains', value: 'ame' }],
				sort: { attribute: 'name', descending: true },
			})) {
				results.push(record);
			}
			assert.equal(results.length, 99);
			assert.equal(results[0].id, 'id-99');
			assert.equal(results[1].id, 'id-98');
			assert.equal(results[2].id, 'id-97');
		});
		it('Does not allow search when no value is provided', async function () {
			assert.throws(() => {
				for (let record of QueryTable.search({
					conditions: [{ attribute: 'name', descending: true }],
				})) {
				}
			});
		});
		it('Sort on non-indexed property', async function () {
			assert.throws(() => {
				for (let record of QueryTable.search({
					sort: { attribute: 'notIndexed', descending: true },
				})) {
				}
			});
			let results = [];
			for await (let record of QueryTable.search({
				allowFullScan: true,
				sort: { attribute: 'notIndexed', descending: true },
			})) {
				results.push(record);
			}
			assert.equal(results.length, 100);
			assert.equal(results[0].notIndexed, 'not indexed 99');
		});
		it('Query data in a table with constraint same attribute as first sorting order', async function () {
			let results = [];
			for await (let record of QueryTable.search({
				conditions: [{ attribute: 'relatedId', comparator: 'greater_than', value: 2 }],
				sort: { attribute: 'relatedId', descending: true, next: { attribute: 'name' } },
			})) {
				results.push(record);
			}
			assert.equal(results.length, 40);
			assert.equal(results[0].id, 'id-14');
			assert.equal(results[1].id, 'id-19');
			assert.equal(results[20].id, 'id-13');
			assert.equal(results[21].id, 'id-18');
		});
		it('Query data in a table with constraint same non-indexed attribute as first sorting order', async function () {
			let results = [];
			for await (let record of QueryTable.search({
				allowFullScan: true,
				conditions: [{ attribute: 'notIndexed', comparator: 'greater_than', value: 'not indexed 9' }],
				sort: { attribute: 'notIndexed', descending: true },
			})) {
				results.push(record);
			}
			assert.equal(results.length, 10);
			assert.equal(results[0].id, 'id-99');
			assert.equal(results[1].id, 'id-98');
		});
		it('Sort on joined attribute', async function () {
			let results = [];
			for await (let record of QueryTable.search({
				allowFullScan: true,
				sort: { attribute: ['related', 'name'], descending: true },
			})) {
				results.push(record);
			}
			assert.equal(results.length, 100);
			assert.equal(results[0].id, 'id-99');
			assert.equal(results[0].relatedId, 4);
			assert.equal(results[1].id, 'id-94');
		});
		it('Explain query with constraint same attribute as first sorting order', async function () {
			const explanation = QueryTable.search({
				conditions: [{ attribute: 'relatedId', comparator: 'greater_than', value: 2 }],
				sort: { attribute: 'relatedId', descending: true, next: { attribute: 'name' } },
				explain: true,
			});
			assert.equal(explanation.postOrdering.attribute, 'name');
			assert.equal(explanation.postOrdering.dbOrderedAttribute, 'relatedId');
		});
	});
	describe('Grouped conditions', function () {
		it('Query data with AND with nested OR', async function () {
			let results = [];
			for await (let record of QueryTable.search({
				conditions: [
					{
						operator: 'or',
						conditions: [
							{ attribute: 'name', comparator: 'less_than', value: 'name-95' },
							{ attribute: 'sparse', comparator: 'greater_than', value: 40 },
						],
					},
					{ attribute: 'id', comparator: 'greater_than', value: 'id-90' },
				],
				sort: { attribute: 'id', descending: true },
			})) {
				results.push(record);
			}
			assert.equal(results.length, 5);
			assert.equal(results[0].id, 'id-98');
			assert.equal(results[1].id, 'id-94');
		});
		it('Query data with OR with nested AND', async function () {
			let results = [];
			for await (let record of QueryTable.search({
				operator: 'or',
				conditions: [
					{
						operator: 'and',
						conditions: [
							{ attribute: 'name', comparator: 'greater_than', value: 'name-60' },
							{ attribute: 'sparse', comparator: 'greater_than', value: 40 },
						],
					},
					{ attribute: 'sparse', comparator: 'equals', value: 32 },
					{ attribute: 'sparse', comparator: 'equals', value: 38 },
				],
				sort: { attribute: 'id' },
			})) {
				results.push(record);
			}
			assert.equal(results.length, 9);
			assert.equal(results[0].id, 'id-32');
			assert.equal(results[1].id, 'id-38');
			assert.equal(results[7].id, 'id-92');
			assert.equal(results[8].id, 'id-98');
		});
	});
	describe('Query optimizations', function () {
		let Bigger, BiggerRelated;
		before(async function () {
			Bigger = table({
				table: 'Bigger',
				database: 'test',
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: '10values', type: 'Int', indexed: true },
					{ name: '20values', type: 'Int', indexed: true },
					{ name: '40values', type: 'Int', indexed: true },
					{ name: '50values', type: 'Int', indexed: true },
					{ name: '100values', type: 'Int', indexed: true },
					{ name: 'relatedId', type: 'Int', indexed: true },
					{
						name: 'related',
						type: 'RelatedTable',
						relationship: { from: 'relatedId' },
						definition: { tableClass: RelatedTable },
					},
					{ name: 'relatedName', type: 'String', indexed: true },
					{
						name: 'relatedByName',
						relationship: { from: 'relatedName', to: 'name' },
						elements: { type: 'RelatedTable', definition: { tableClass: RelatedTable } },
					},
				],
			});
			BiggerRelated = table({
				table: 'BiggerRelated',
				database: 'test',
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: '20values', type: 'Int', indexed: true },
					{ name: 'biggerId', indexed: true },
					{
						name: 'bigger',
						type: 'Bigger',
						relationship: { from: 'biggerId' },
						definition: { tableClass: Bigger },
					},
				],
			});
			let last;
			for (let i = 0; i < 1000; i++) {
				last = Bigger.put({
					'id': [i >> 8, i & 255],
					'10values': random(10),
					'20values': random(20),
					'40values': random(40),
					'50values': random(50),
					'100values': random(100),
					'relatedId': random(5),
					'relatedName': 'related name ' + (i % 7),
				});
			}
			for (let i = 0; i < 100; i++) {
				last = BiggerRelated.put({
					'id': i,
					'20values': random(20),
					'biggerId': [0, random(256)],
				});
			}
			await last;
		});
		it('Uses both indices for two similar conditions', async function () {
			let results = [];
			let start_read_count = Bigger.primaryStore.readCount;
			for await (let record of Bigger.search({
				conditions: [
					{ attribute: '20values', value: 4 },
					{ attribute: '40values', value: 24 },
				],
			})) {
				results.push(record);
			}

			assert.equal(results.length, 15);
			for (let result of results) {
				assert.equal(result['20values'], 4);
				assert.equal(result['40values'], 24);
			}
			assert(Bigger.primaryStore.readCount - start_read_count < 20);
		});
		it('Uses both indices for two kinda similar conditions', async function () {
			let results = [];
			let start_read_count = Bigger.primaryStore.readCount;
			for await (let record of Bigger.search({
				conditions: [
					{ attribute: '20values', value: 4 },
					{ attribute: '100values', value: 20 },
				],
			})) {
				results.push(record);
			}

			assert.equal(results.length, 10);
			for (let result of results) {
				assert.equal(result['20values'], 4);
				assert.equal(result['100values'], 20);
			}
			assert(Bigger.primaryStore.readCount - start_read_count < 15);
		});
		it('Uses at least two indices for three similar conditions', async function () {
			let results = [];
			let start_read_count = Bigger.primaryStore.readCount;
			for await (let record of Bigger.search({
				conditions: [
					{ attribute: '20values', value: 4 },
					{ attribute: '40values', value: 24 },
					{ attribute: '50values', value: 0 },
				],
			})) {
				results.push(record);
			}

			assert.equal(results.length, 3);
			for (let result of results) {
				assert.equal(result['20values'], 4);
				assert.equal(result['40values'], 24);
				assert.equal(result['50values'], 0);
			}
			assert(Bigger.primaryStore.readCount - start_read_count < 15);
		});

		it('Stick to filtering for wide secondary condition', async function () {
			let results = [];
			let start_read_count = Bigger.primaryStore.readCount;
			for await (let record of Bigger.search({
				conditions: [
					{ attribute: '20values', comparator: 'greater_than', value: 4 },
					{ attribute: '100values', value: 20 },
				],
			})) {
				results.push(record);
			}

			assert.equal(results.length, 25);
			for (let result of results) {
				assert(result['20values'] > 4);
				assert.equal(result['100values'], 20);
			}
			assert(Bigger.primaryStore.readCount - start_read_count > 35);
		});

		it('Uses primary key filtering after indexed search', async function () {
			let results = [];
			let start_read_count = Bigger.primaryStore.readCount;
			for await (let record of Bigger.search({
				conditions: [
					{ attribute: '40values', value: 24 },
					{ attribute: 'id', comparator: 'ge', value: [1, 240] },
				],
			})) {
				results.push(record);
			}

			assert.equal(results.length, 58);
			for (let result of results) {
				assert.equal(result['40values'], 24);
				assert(result.id[0] > 1 || result.id[1] >= 240);
			}
			assert(Bigger.primaryStore.readCount - start_read_count < 60);
		});
		it('Uses primary key filtering with prefix after indexed search', async function () {
			let results = [];
			let start_read_count = Bigger.primaryStore.readCount;
			for await (let record of Bigger.search({
				conditions: [
					{ attribute: '40values', value: 24 },
					{ attribute: 'id', comparator: 'prefix', value: [2] },
				],
			})) {
				results.push(record);
			}

			assert.equal(results.length, 27);
			for (let result of results) {
				assert.equal(result['40values'], 24);
				assert.equal(result.id[0], 2);
			}
			assert(Bigger.primaryStore.readCount - start_read_count < 30);
		});
		it('Combine medium condition with join', async function () {
			let results = [];
			let start_read_count = Bigger.primaryStore.readCount;
			for await (let record of Bigger.search({
				conditions: [
					{ attribute: '10values', value: 2 },
					{ attribute: ['related', 'name'], value: 'related name 3' },
				],
			})) {
				results.push(record);
			}

			assert.equal(results.length, 36);
			for (let result of results) {
				assert.equal(result['10values'], 2);
				assert.equal(result.relatedId, 3);
			}
			assert(Bigger.primaryStore.readCount - start_read_count < 40);
		});

		it('Combine medium condition with join to non-primary key', async function () {
			let results = [];
			let start_read_count = Bigger.primaryStore.readCount;
			for await (let record of Bigger.search({
				conditions: [
					{ attribute: '10values', value: 2 },
					{ attribute: ['relatedByName', 'name'], value: 'related name 3' },
				],
				select: ['10values', 'relatedByName', 'relatedName'],
			})) {
				results.push(record);
			}

			assert.equal(results.length, 27);
			for (let result of results) {
				assert.equal(result['10values'], 2);
				assert.equal(result.relatedName, 'related name 3');
				assert.equal(result.relatedByName[0].name, 'related name 3');
				assert.equal(result.relatedByName[0].id, 3);
			}
			assert(Bigger.primaryStore.readCount - start_read_count < 40);
		});

		it('Combine narrower condition with join', async function () {
			let results = [];
			let start_read_count = Bigger.primaryStore.readCount;
			let start_related_count = RelatedTable.primaryStore.readCount;
			for await (let record of Bigger.search({
				conditions: [
					{ attribute: '100values', value: 64 },
					{ attribute: ['related', 'name'], value: 'related name 2' },
				],
				select: ['100values', 'relatedId'],
			})) {
				results.push(record);
			}

			assert.equal(results.length, 16);
			for (let result of results) {
				assert.equal(result['100values'], 64);
				assert.equal(result.relatedId, 2);
			}
			assert(RelatedTable.primaryStore.readCount - start_related_count < 3);
			assert(Bigger.primaryStore.readCount - start_read_count < 20);
		});
		it('Combine condition with larger join', async function () {
			let results = [];
			let start_read_count = Bigger.primaryStore.readCount;
			let start_related_count = BiggerRelated.primaryStore.readCount;
			for await (let record of BiggerRelated.search({
				conditions: [
					{ attribute: '20values', value: 12 },
					{ attribute: ['bigger', '20values'], value: 12 },
				],
				select: ['*', 'bigger'],
			})) {
				results.push(record);
			}
			//results = results.filter((r) => r.bigger['20values'] === 12);
			assert.equal(results.length, 3);
			for (let result of results) {
				assert.equal(result['20values'], 12);
				assert.equal(result.bigger['20values'], 12);
			}
			assert(BiggerRelated.primaryStore.readCount - start_related_count < 20);
			assert(Bigger.primaryStore.readCount - start_read_count < 20);
		});
	});
	it('Query data in a table with greater_than_equal comparator', async function () {
		let results = [];
		for await (let record of QueryTable.search({
			conditions: [{ attribute: 'id', comparator: 'greater_than_equal', value: 'id-90' }],
		})) {
			results.push(record);
		}

		assert.equal(results.length, 10);
	});
	it('Query data in a table with reverse and equals', async function () {
		let results = [];
		for await (let record of RelatedTable.search({
			reverse: true,
			limit: 100,
			conditions: [{ attribute: 'id', comparator: 'equals', value: 2 }],
		})) {
			results.push(record);
		}
		assert.equal(results.length, 1);
		assert.equal(results[0].id, 2);
	});

	it('Query data in a table and select with special properties', async function () {
		let results = [];
		for await (let record of QueryTable.search({
			conditions: [{ attribute: 'id', comparator: 'greater_than_equal', value: 'id-90' }],
			select: ['$id', 'id', '$updatedtime', '$record'],
		})) {
			results.push(record);
		}

		assert.equal(results.length, 10);
		assert.equal(results[0].$id, 'id-90');
		assert.equal(results[0].id, 'id-90');
		assert.equal(results[0].$record.id, 'id-90');
		assert(results[0].$updatedtime > 1701181789552);
		assert.equal(results[1].$id, 'id-91');
	});
	it('Parsed query data in a table and select with special properties and star', async function () {
		let results = [];
		for await (let record of QueryTable.search({ url: '?id=ge=id-90&select($id,$updatedtime,*)' })) {
			results.push(record);
		}

		assert.equal(results.length, 10);
		assert.equal(results[0].$id, 'id-90');
		assert.equal(results[0].id, 'id-90');
		assert.equal(results[0].name, 'name-90');
		assert(results[0].$updatedtime > 1701181789552);
		assert.equal(results[1].$id, 'id-91');
		assert.equal(results[1].name, 'name-91');
	});

	it('Parsed nested query data in a table', async function () {
		let results = [];
		for await (let record of QueryTable.search({ url: '?(id=ge=id-90&id=le=id-93)|(name=name-95&id=ge=id-94)' })) {
			results.push(record);
		}
		assert.equal(results.length, 5);
		assert.equal(results[0].id, 'id-90');
		assert.equal(results[4].id, 'id-95');
	});
	it('Parsed nested query data in a table with brackets', async function () {
		let results = [];
		for await (let record of QueryTable.search({ url: '?[id=ge=id-90&id=le=id-93]|[name=name-95&id=ge=id-94]' })) {
			results.push(record);
		}
		assert.equal(results.length, 5);
		assert.equal(results[0].id, 'id-90');
		assert.equal(results[4].id, 'id-95');
	});
	it('Parsed nested query data in a table with joined sort', async function () {
		let results = [];
		for await (let record of QueryTable.search({
			url: '?(id>id-80&id<=id-93)|(name=name-95&id>id-94)&sort(-related.name)',
		})) {
			results.push(record);
		}
		assert.equal(results.length, 15);
		assert.equal(results[0].id, 'id-84');
		assert.equal(results[1].id, 'id-89');
		assert.equal(results[14].id, 'id-95');
	});
	it('Parsed query data in a table with one-to-many joined sort that is not primary', async function () {
		let results = [];
		for await (let record of RelatedTable.search({
			url: '?name=related name 3&sort(-relatedToMany.name)&select(id,relatedToMany)',
		})) {
			results.push(record);
		}
		assert.equal(results.length, 1);
		const related = await results[0].relatedToMany;
		assert.equal(related[0].id, 'id-98');
		assert.equal(related[1].id, 'id-93');
		assert.equal(related[14].id, 'id-33');
	});
	it('Parsed query data in a table with many-to-many joined sort that is not primary', async function () {
		let results = [];
		for await (let record of QueryTable.search({
			url: '?id=id-14&sort(-manyToMany.name)&select(id,manyToMany)',
		})) {
			results.push(record);
		}
		assert.equal(results.length, 1);
		const related = await results[0].manyToMany;
		assert.equal(related[0].id, 17);
		assert.equal(related[1].id, 16);
		assert.equal(related.length, 4);
	});
	it('Parsed query data in a table with many-to-many joined sort that has missing entries and multiple sorts', async function () {
		let results = [];
		for await (let record of QueryTable.search({
			url: '?id=id-12|id=id-24&sort(-id,-manyToMany.name)&select(id,manyToMany,manyToManyIds)',
		})) {
			results.push(record);
		}
		assert.equal(results.length, 2);
		let related = await results[0].manyToMany;
		assert.equal(related[0].id, 24);
		assert.equal(related.length, 1);
		related = await results[1].manyToMany;
		assert.equal(related.length, 2);
		assert.equal(related[0].id, 13);
	});

	it('Parsed query data in a table with not equal to null', async function () {
		let results = [];
		for await (let record of QueryTable.search({
			url: '?sparse!=null',
		})) {
			results.push(record);
		}
		assert.equal(results.length, 17);
		for (let result of results) {
			assert(result.sparse !== null);
		}
	});
	it('Parsed query with boolean equal to true', async function () {
		let results = [];
		for await (let record of RelatedTable.search({
			url: '?aFlag==true',
		})) {
			results.push(record);
		}
		assert.equal(results.length, 2);
		for (let result of results) {
			assert(result.aFlag);
		}
	});
	it('Parsed query with boolean equal to false', async function () {
		let results = [];
		for await (let record of RelatedTable.search({
			url: '?aFlag==false',
		})) {
			results.push(record);
		}
		assert.equal(results.length, 3);
		for (let result of results) {
			assert(!result.aFlag);
		}
	});
	it('Query should remove any lastModified on context', async function () {
		let results = [];
		let context = {};
		await RelatedTable.get(1, context); // This will set the lastModified on the context
		assert(isFinite(context.lastModified));
		for await (let record of RelatedTable.search(
			{
				url: '?aFlag==true',
			},
			context
		)) {
			results.push(record);
		}
		assert(!isFinite(context.lastModified));
		await RelatedTable.get(2, context); // This should _not_ reset the lastModified on the context
		assert(!isFinite(context.lastModified));
	});

	it('Query data in a table with bad attribute', async function () {
		let caught_error;
		try {
			for await (let record of QueryTable.search({
				conditions: [{ attribute: [], value: 'id-1' }],
			})) {
				results.push(record);
			}
		} catch (error) {
			caught_error = error;
		}
		assert(caught_error.message.includes('is not a defined attribute'));
	});

	it('Query data in a table with bad comparator', async function () {
		let results = [];
		let caught_error;
		try {
			for await (let record of QueryTable.search({
				conditions: [{ attribute: 'id', comparator: 'great_than_equal', value: 'id-1' }],
			})) {
				results.push(record);
			}
		} catch (error) {
			caught_error = error;
		}
		assert(caught_error.message.includes('Unknown query comparator'));
	});
	it('Query data in a table with bad secondary comparator', async function () {
		let results = [];
		let caught_error;
		try {
			for await (let record of QueryTable.search({
				conditions: [
					{ attribute: 'name', value: 'name 1' },
					{ attribute: 'id', comparator: 'great_than_equal', value: 'id-1' },
				],
			})) {
				results.push(record);
			}
		} catch (error) {
			caught_error = error;
		}
		assert(caught_error.message.includes('Unknown query comparator'));
	});
	it('Query data in a table with bad relationships', async function () {
		let results = [];
		for await (let record of RelatedTable.search({
			select: ['id', 'badRelationship', 'badRelationship3'],
		})) {
			results.push(record);
		}
		assert.equal(results[0].badRelationship, undefined);
		assert.equal(results[0].badRelationship3, undefined);
	});
	it('Query data in a table with another bad relationship', async function () {
		let results = [];
		let caught_error;
		try {
			for await (let record of RelatedTable.search({
				select: ['id', 'badRelationship2'],
			})) {
				results.push(record);
			}
		} catch (error) {
			caught_error = error;
		}
		assert(caught_error.message.includes('not indexed'));
	});
	it('Prevent query data in a table with null', async function () {
		let results = [];
		let caught_error;
		try {
			for await (let record of QueryTable.search({
				allowFullScan: false,
				conditions: [{ attribute: 'id', value: null }],
			})) {
				results.push(record);
			}
		} catch (error) {
			caught_error = error;
		}
		assert(caught_error.message.includes('rebuilt'));
	});
	it('Get with big key should fail', async function () {
		const key = [];
		for (let i = 0; i < 50; i++) key.push('testing a big key that is too big for HarperDB');
		let get_error;
		for (let i = 0; i < 5; i++) {
			get_error = null;
			try {
				let result;
				result = await QueryTable.get(key);
				console.log(result);
			} catch (error) {
				get_error = error;
			}
			assert(get_error.message.includes('key size is too large'));
		}
		for (let i = 0; i < 5; i++) {
			get_error = null;
			try {
				let result;
				result = await QueryTable.get(key.toString());
				console.log(result);
			} catch (error) {
				get_error = error;
			}
			assert(get_error.message.includes('key size is too large'));
		}
		let put_error;
		try {
			let result;
			result = await QueryTable.put(key, { name: 'should be too big' });
			console.log(result);
		} catch (error) {
			put_error = error;
		}
		assert(put_error.message.includes('key size is too large'));
	});
	it('Query with big value that should work', async function () {
		let results = [];
		for await (let record of ManyToMany.search({
			conditions: [
				{
					attribute: 'name',
					comparator: 'equals',
					value: long_str,
				},
			],
		})) {
			results.push(record);
		}
		assert.equal(results.length, 2);
	});
	it('Query with big value and greater than or equal should work', async function () {
		let results = [];
		for await (let record of ManyToMany.search({
			conditions: [
				{
					attribute: 'name',
					comparator: 'ge',
					value: long_str,
				},
			],
		})) {
			results.push(record);
		}
		assert.equal(results.length, 2);
	});
	it('Too many read transactions should fail, but work afterwards', async function () {
		this.timeout(10000);
		let resolvers = [];
		await assert.rejects(async () => {
			QueryTable.primaryStore.useReadTransaction = function () {
				// force the expected error so we don't have to wait for the timeout
				throw new Error('MDB_READERS_FULL');
			};
			try {
				for (let i = 0; i < 3000; i++) {
					await QueryTable.put('test-txn', { name: 'do a txn' + i });
					let context = {};
					transaction(context, () => {
						QueryTable.get('test-txn', context);
						return new Promise((resolve) => {
							resolvers.push(resolve);
						});
					});
				}
			} finally {
				// restore the original
				delete QueryTable.primaryStore.useReadTransaction;
			}
		});
		for (let resolve of resolvers) {
			resolve();
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
		await QueryTable.delete('test-txn');
	});
	describe('Query after deletes', () => {
		before(async () => {
			for await (let id of QueryTable.search({
				select: 'id',
				conditions: [{ attribute: 'relatedId', comparator: 'equals', value: 3 }],
				limit: 2,
			})) {
				await QueryTable.delete(id);
			}
		});
		it('Query property in a table with limit after deletes', async function () {
			let results = [];
			for await (let id of QueryTable.search({
				select: 'id',
				conditions: [{ attribute: 'relatedId', comparator: 'equals', value: 3 }],
				limit: 2,
			})) {
				results.push(id);
			}
			assert.equal(results.length, 2);
		});
	});

	describe('Setting conditions on dynamic attributes', () => {
		const records = [
			{
				id: 'zzz-10000',
				name: 'the-one-with-the-dynamic-attr',
				dynamic: 'foo',
			},
			{
				id: 'zzz-10001',
				name: 'another-one',
				dynamic: 'bar',
			},
			{
				id: 'zzz-10002',
				name: 'yet-another-one',
				dynamic: 'baz',
			}
		];

		before(async () => {
			for (const record of records) {
				await QueryTable.put(record.id, record);
			}
		});

		after(async () => {
			for (const record of records) {
				await QueryTable.delete(record.id);
			}
		});

		it('throws an error if not requested', async () => {
			await assert.rejects(async () => {
				QueryTable.search({
					conditions: [{ attribute: 'dynamic', comparator: 'equals', value: 'foo' }],
				});
			});
		});
		it('works if requested', async () => {
			let results = [];
			for await (let record of QueryTable.search({
				allowConditionsOnDynamicAttributes: true,
				conditions: [{ attribute: 'dynamic', comparator: 'equals', value: 'foo' }],
			})) {
				results.push(record);
			}
			assert.equal(results.length, 1);
			assert.equal(results[0].name, 'the-one-with-the-dynamic-attr');
		});
		it('works if requested with starts_with', async () => {
			let results = [];
			for await (let record of QueryTable.search({
				allowConditionsOnDynamicAttributes: true,
				conditions: [
					{ attribute: 'dynamic', comparator: 'starts_with', value: 'ba' },
				],
			})) {
				results.push(record);
			}
			assert.equal(results.length, 2, `results: ${JSON.stringify(results)}`);
			assert.equal(results[0].name, 'another-one');
			assert.equal(results[1].name, 'yet-another-one');
		});
	});
});
