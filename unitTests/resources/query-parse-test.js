require('../test_utils');
const assert = require('assert');
const { parseQuery } = require('../../resources/search');
// might want to enable an iteration with NATS being assigned as a source
describe('Parsing queries', () => {
	let QueryTable, RelatedTable;
	before(function () {});
	it('Basic AND query', function () {
		const query = parseQuery('id=1&name=2');
		const conditions = Array.from(query.conditions);
		assert.equal(conditions.length, 2);
		assert.equal(conditions[0][0], 'id');
		assert.equal(conditions[0][1], '1');
		assert.equal(conditions[1][0], 'name');
		assert.equal(conditions[1][1], '2');
	});
	it('Basic OR query', function () {
		let query = parseQuery('id=1|name=2');
		assert.equal(query.operator, 'or');
		assert.equal(query.conditions.length, 2);
		assert.equal(query.conditions[0].attribute, 'id');
		assert.equal(query.conditions[0].value, '1');
		assert.equal(query.conditions[1].attribute, 'name');
		assert.equal(query.conditions[1].value, '2');
	});
	it('Basic AND and nested OR query', function () {
		let query = parseQuery('id=1&(value=gt=4|name=2)');
		assert.equal(query.conditions.length, 2);
		assert.equal(query.conditions[0].attribute, 'id');
		assert.equal(query.conditions[0].value, '1');
		assert.equal(query.conditions[1].operator, 'or');
		assert.equal(query.conditions[1].conditions[0].attribute, 'value');
		assert.equal(query.conditions[1].conditions[0].comparator, 'gt');
		assert.equal(query.conditions[1].conditions[1].comparator, 'equals');
		assert.equal(query.conditions[1].conditions[1].value, '2');
	});
	it('Basic OR and nested AND/OR query', function () {
		let query = parseQuery('(value!=4&name=2)|id=5|(foo=bar&name=2&(value=gt=4|name=2))');
		assert.equal(query.operator, 'or');
		assert.equal(query.conditions.length, 3);
		assert.equal(query.conditions[0].operator, 'and');
		assert.equal(query.conditions[0].conditions[0].attribute, 'value');
		assert.equal(query.conditions[0].conditions[0].comparator, 'ne');
		assert.equal(query.conditions[0].conditions[0].value, '4');
		assert.equal(query.conditions[0].conditions[1].attribute, 'name');
		assert.equal(query.conditions[0].conditions[1].comparator, 'equals');
		assert.equal(query.conditions[0].conditions[1].value, '2');
		assert.equal(query.conditions[1].attribute, 'id');
		assert.equal(query.conditions[1].value, '5');
		assert.equal(query.conditions[2].operator, 'and');
		assert.equal(query.conditions[2].conditions[0].attribute, 'foo');
		assert.equal(query.conditions[2].conditions[0].comparator, 'equals');
		assert.equal(query.conditions[2].conditions[0].value, 'bar');
		assert.equal(query.conditions[2].conditions[1].attribute, 'name');
		assert.equal(query.conditions[2].conditions[1].comparator, 'equals');
		assert.equal(query.conditions[2].conditions[1].value, '2');
		assert.equal(query.conditions[2].conditions[2].operator, 'or');
		assert.equal(query.conditions[2].conditions[2].conditions[0].attribute, 'value');
		assert.equal(query.conditions[2].conditions[2].conditions[0].comparator, 'gt');
		assert.equal(query.conditions[2].conditions[2].conditions[0].value, '4');
		assert.equal(query.conditions[2].conditions[2].conditions[1].comparator, 'equals');
		assert.equal(query.conditions[2].conditions[2].conditions[1].value, '2');
	});
	it('OR and nested AND/OR query with brackets and parans in values', function () {
		let query = parseQuery('[value!=4&name=2]|id=5|[foo=ba)r&name=2&[value=gt=(4)|name=2]]|id=6');
		assert.equal(query.operator, 'or');
		assert.equal(query.conditions.length, 4);
		assert.equal(query.conditions[0].operator, 'and');
		assert.equal(query.conditions[0].conditions[0].attribute, 'value');
		assert.equal(query.conditions[0].conditions[0].comparator, 'ne');
		assert.equal(query.conditions[0].conditions[0].value, '4');
		assert.equal(query.conditions[0].conditions[1].attribute, 'name');
		assert.equal(query.conditions[0].conditions[1].comparator, 'equals');
		assert.equal(query.conditions[0].conditions[1].value, '2');
		assert.equal(query.conditions[1].attribute, 'id');
		assert.equal(query.conditions[1].value, '5');
		assert.equal(query.conditions[2].operator, 'and');
		assert.equal(query.conditions[2].conditions[0].attribute, 'foo');
		assert.equal(query.conditions[2].conditions[0].comparator, 'equals');
		assert.equal(query.conditions[2].conditions[0].value, 'ba)r');
		assert.equal(query.conditions[2].conditions[1].attribute, 'name');
		assert.equal(query.conditions[2].conditions[1].comparator, 'equals');
		assert.equal(query.conditions[2].conditions[1].value, '2');
		assert.equal(query.conditions[2].conditions[2].operator, 'or');
		assert.equal(query.conditions[2].conditions[2].conditions[0].attribute, 'value');
		assert.equal(query.conditions[2].conditions[2].conditions[0].comparator, 'gt');
		assert.equal(query.conditions[2].conditions[2].conditions[0].value, '(4)');
		assert.equal(query.conditions[2].conditions[2].conditions[1].comparator, 'equals');
		assert.equal(query.conditions[2].conditions[2].conditions[1].value, '2');
		assert.equal(query.conditions[3].attribute, 'id');
	});
	it('Query and select and limit', function () {
		let query = parseQuery('id=1&name=2&select(id,name)&limit(10)');
		assert.equal(query.conditions.length, 2);
		assert.equal(query.conditions[0].attribute, 'id');
		assert.equal(query.conditions[0].value, '1');
		assert.equal(query.conditions[1].attribute, 'name');
		assert.equal(query.conditions[1].value, '2');
		assert.equal(query.select.length, 2);
		assert.equal(query.select[0], 'id');
		assert.equal(query.select[1], 'name');
		assert.equal(query.limit, 10);
	});
	it('Limit with offset', function () {
		let query = parseQuery('limit(5,10)');
		assert.equal(query.conditions.length, 0);
		assert.equal(query.offset, 5);
		assert.equal(query.limit, 5);
	});
	it('Coercible vs strict', function () {
		let query = parseQuery(
			'id=1&foo==number:5&bar==null&baz!=boolean:true&qux!=date:2024-01-05T20%3A07%3A27.955Z&strict===number:5'
		);
		assert.equal(query.conditions.length, 6);
		assert.equal(query.conditions[0].attribute, 'id');
		assert.equal(query.conditions[0].value, '1');
		assert.equal(query.conditions[1].value, 5);
		assert.equal(query.conditions[2].value, null);
		assert.equal(query.conditions[3].value, true);
		assert(query.conditions[4].value instanceof Date);
		assert.equal(query.conditions[5].value, 'number:5');
	});

	it('Nested select', function () {
		let query = parseQuery('select(related{name,otherTable{other_name}},id,name)');
		assert.equal(query.conditions.length, 0);
		assert.equal(query.select.length, 3);
		assert.equal(query.select[0].name, 'related');
		assert.equal(query.select[0].length, 2);
		assert.equal(query.select[0][0], 'name');
		assert.equal(query.select[0][1].name, 'otherTable');
		assert.equal(query.select[0][1].length, 1);
		assert.equal(query.select[0][1][0], 'other_name');
	});
	it('Nested select using select', function () {
		let query = parseQuery('select(related[select(name,otherTable[select(other_name,)])],id,name)');
		assert.equal(query.conditions.length, 0);
		assert.equal(query.select.length, 3);
		assert.equal(query.select[0].name, 'related');
		assert.equal(query.select[0].select.length, 2);
		assert.equal(query.select[0].select[0], 'name');
		assert.equal(query.select[0].select[1].name, 'otherTable');
		assert.equal(query.select[0].select[1].select.length, 1);
		assert.equal(query.select[0].select[1].select[0], 'other_name');
	});
	it('Multi-part properties', function () {
		let query = parseQuery('name.subname=2');
		assert.equal(query.conditions.length, 1);
		assert.deepEqual(query.conditions[0].attribute, ['name', 'subname']);
	});
	it('Multi-part properties in sort', function () {
		let query = parseQuery('name.subname=2&sort(name.subname)');
		assert.equal(query.conditions.length, 1);
		assert.deepEqual(query.conditions[0].attribute, ['name', 'subname']);
		assert.deepEqual(query.sort.attribute, ['name', 'subname']);
	});
	it('Multi-part properties in complex sort', function () {
		let query = parseQuery('name.subname=2&sort(+name.subname,-otherName)');
		assert.deepEqual(query.sort.attribute, ['name', 'subname']);
		assert.equal(query.sort.descending, false);
		assert.equal(query.sort.next.attribute, 'otherName');
		assert.equal(query.sort.next.descending, true);
	});
	it('Union with calls', function () {
		let query = parseQuery('select(name,age)&name=2|name=3&sort(+name)');
		assert.equal(query.sort.attribute, 'name');
		assert.equal(query.operator, 'or');
		assert.equal(query.conditions.length, 2);
		assert.deepEqual(query.select, ['name', 'age']);
	});
	it('Bad calls', function () {
		assert.throws(() => parseQuery('limit(5,10'), /expected '\)'/);
		assert.throws(() => parseQuery('unknown(5,10)'), /unknown query function call/);
		assert.throws(() => parseQuery('select([)'), /expected '\]'/);
		assert.throws(() => parseQuery('select)'), /unexpected token '\)'/);
	});

	it.skip('Bad queries', function () {
		// If we are using UrlSearchParams, these are actually valid
		assert.throws(() => parseQuery('name=value&no-value'), /no comparison/);
		assert.throws(() => parseQuery('name==value'), /unexpected operator/);
		assert.throws(() => parseQuery('name&'), /no comparison/);
	});
	it('Bad nesting', function () {
		assert.throws(() => parseQuery('(name=value)shouldntbehere'), /expected operator/);
		assert.throws(() => parseQuery('(name))'), /no attribute/);
		assert.throws(() => parseQuery('(=value&=test)'), /attribute must be specified/);
		assert.throws(() => parseQuery('(name=(value))'), /no attribute/);
		assert.throws(() => parseQuery('name=value|test=3&foo=bar'), /mix operators/);
		assert.throws(() => parseQuery('name=value&[test=3&foo=bar|test=4]'), /mix operators/);
	});
});
