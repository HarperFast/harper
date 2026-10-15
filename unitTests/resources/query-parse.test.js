const assert = require('assert');
const { parseQuery } = require('#src/resources/search');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
// might want to enable an iteration with NATS being assigned as a source
describe('Parsing queries', () => {
	before(function () {});
	it('Basic AND query', function () {
		const query = parseQuery('id=1&name=2');
		const conditions = Array.from(query);
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
	it('Coerce date', function () {
		let query = parseQuery('time=lt=date:2024-01-05T20%3A07%3A27.955Z&time=gt=date:1602872124871');
		assert.equal(query.conditions.length, 2);
		assert.equal(query.conditions[0].attribute, 'time');
		assert.equal(query.conditions[0].value.getTime(), new Date('2024-01-05T20:07:27.955Z').getTime());
		assert.equal(query.conditions[1].value.getTime(), 1602872124871);
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
	it('Single-argument nested select keeps outer array wrapper (F-342)', function () {
		const braceQuery = parseQuery('select(child{id,label})');
		assert.ok(Array.isArray(braceQuery.select));
		assert.strictEqual(braceQuery.select.length, 1);
		assert.strictEqual(braceQuery.select[0].name, 'child');
		assert.deepStrictEqual(Array.from(braceQuery.select[0]), ['id', 'label']);

		const bracketQuery = parseQuery('select(child[select(id,label)])');
		assert.ok(Array.isArray(bracketQuery.select));
		assert.strictEqual(bracketQuery.select.length, 1);
		assert.strictEqual(bracketQuery.select[0].name, 'child');
		assert.deepStrictEqual(Array.from(bracketQuery.select[0].select), ['id', 'label']);

		const deepQuery = parseQuery('select(child{grandchild{id}})');
		assert.ok(Array.isArray(deepQuery.select));
		assert.strictEqual(deepQuery.select.length, 1);
		assert.strictEqual(deepQuery.select[0].name, 'child');
		assert.strictEqual(deepQuery.select[0][0].name, 'grandchild');
		assert.deepStrictEqual(Array.from(deepQuery.select[0][0]), ['id']);

		const scalarQuery = parseQuery('select(title)');
		assert.strictEqual(scalarQuery.select, 'title');
	});
	it('Rejects bracketed filter conditions inside select(...) with 400 SyntaxViolation (F-342)', function () {
		for (const raw of [
			'select(children[label=child-label-c1])',
			'select(id,children[label=child-label-c1])',
			'select(children[label=child-label-c1],id)',
		]) {
			assert.throws(
				() => parseQuery(raw),
				(err) => {
					assert.strictEqual(err.statusCode, 400);
					assert.match(err.message, /conditions\/comparisons are not allowed in a property list/);
					return true;
				}
			);
			const target = new RequestTarget(`?${raw}`);
			assert.ok(target.parseError);
			assert.strictEqual(target.parseError.statusCode, 400);
			assert.match(target.parseError.message, /conditions\/comparisons are not allowed in a property list/);
		}
	});
	it('Allows bracketed non-condition operators like sort() and limit() inside select(...)', function () {
		const query = parseQuery('select(id,children[sort(-id)&limit(5)])');
		assert.strictEqual(query.parseError, undefined);
		assert.strictEqual(query.select.length, 2);
		assert.strictEqual(query.select[0], 'id');
		assert.strictEqual(query.select[1].name, 'children');
		assert.strictEqual(query.select[1].sort.attribute, 'id');
		assert.strictEqual(query.select[1].sort.descending, true);
		assert.strictEqual(query.select[1].limit, 5);
	});
	it('Parses parenthesized OR group containing a bracketed relationship condition', function () {
		const query = parseQuery('(title=x|children[label=y])');
		assert.strictEqual(query.parseError, undefined);
		assert.strictEqual(query.conditions.length, 1);
		const group = query.conditions[0];
		assert.strictEqual(group.operator, 'or');
		assert.strictEqual(group.conditions.length, 2);
		assert.strictEqual(group.conditions[0].attribute, 'title');
		assert.strictEqual(group.conditions[0].value, 'x');
		assert.strictEqual(group.conditions[1].name, 'children');
		assert.strictEqual(group.conditions[1].conditions.length, 1);
		assert.strictEqual(group.conditions[1].conditions[0].attribute, 'label');
		assert.strictEqual(group.conditions[1].conditions[0].value, 'y');
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
	it('group-by records not-implemented error without falling through into sort', function () {
		const query = {};
		parseQuery('group-by(x)', query);
		assert.match(query.parseError.message, /group by is not implemented yet/);
		assert.equal(query.sort, undefined);
	});
	it('Bracket/array parameter', function () {
		let query = parseQuery('itemIds[]=1&itemIds[]=2');
		assert.equal(query.conditions.length, 2);
		assert.equal(query.conditions[0].value, '1');
		assert.equal(query.conditions[1].value, '2');
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
	it('Parenthesized group values parse like top-level values', function () {
		const query = parseQuery('(name=(value)|tags=in=(a,b))');
		const group = query.conditions[0];
		assert.equal(group.operator, 'or');
		assert.equal(group.conditions[0].value, '(value)');
		assert.deepEqual(group.conditions[1].value, ['a', 'b']);
	});
	it('Empty FIQL values before a separator or group closer', function () {
		for (const [query, operator] of [
			['(a=eq=|b=B)', 'or'],
			['(a=eq=&b=B)', 'and'],
			['[a=eq=|b=B]', 'or'],
		]) {
			const group = parseQuery(query).conditions[0];
			assert.equal(group.operator, operator, query);
			assert.deepEqual(
				group.conditions.map(({ attribute, value }) => [attribute, value]),
				[
					['a', ''],
					['b', 'B'],
				],
				query
			);
		}
		const topLevel = parseQuery('a=eq=&b=B');
		assert.deepEqual(
			topLevel.conditions.map(({ attribute, value }) => [attribute, value]),
			[
				['a', ''],
				['b', 'B'],
			]
		);
		assert.equal(parseQuery('(a=eq=)').conditions[0].conditions[0].value, '');
	});
	it('Truncated groups are rejected, and a valid parse after a failed one is unaffected', function () {
		for (const query of ['(a=in=(x,y)', '(a=eq=foo(bar)', '((a=1|b=2)', '(a=1&(b=in=(x,y))', '[a=1']) {
			assert.throws(() => parseQuery(query), /but encountered end of string/, query);
			assert.match(new RequestTarget('/T/?' + query).parseError?.message, /end of string/, query);
		}
		const query = parseQuery('(a=in=(x,y))');
		assert.deepEqual(query.conditions[0].conditions[0].value, ['x', 'y']);
	});
	it('A condition pending at the end of the string is kept', function () {
		const single = parseQuery('a=eq=');
		assert.deepEqual(
			single.conditions.map(({ attribute, value }) => [attribute, value]),
			[['a', '']]
		);
		assert.equal(parseQuery('b=B&a=eq=').conditions.length, 2);
		const chained = parseQuery('price=ge=10&=le=');
		assert.equal(chained.conditions[0].chainedConditions.length, 1);
		assert.equal(chained.conditions[0].chainedConditions[0].comparator, 'le');
	});
	it('Grouping and comparisons are rejected where they cannot apply', function () {
		assert.throws(() => parseQuery('(a=eq=(b=1))'), /unexpected '\(' in a value/);
		assert.throws(() => parseQuery('a=eq=[b=1]'), /unexpected '\[' in a value/);
		assert.throws(() => parseQuery('select(a=1,b)'), /not allowed in a property list/);
		assert.throws(() => parseQuery('select(a<1)'), /not allowed in a property list/);
		assert.equal(parseQuery('(note=eq=select(id))').conditions[0].conditions[0].value, 'select(id)');
		assert.throws(
			() => parseQuery('a=gt=x{y}'),
			(error) => error.statusCode === 400 && /in a value/.test(error.message)
		);
		assert.throws(() => parseQuery('p=ge=1&=5'), /chained condition needs a FIQL comparator/);
		assert.throws(
			() => parseQuery('a=gt=1&b{c}'),
			(error) =>
				error.statusCode === 400 && /property sets are not allowed/.test(error.message) && !/push/.test(error.message)
		);
	});
	it('A character no tokenizer accepts ends the parse with an error instead of looping', function () {
		// a child process, so a regression fails on the timeout instead of hanging the suite
		const script = `
			const { parseQuery } = require('#src/resources/search');
			for (const query of ['(?a=1)', 'a=gt=1&(?)', 'select(?)', 'a=gt=1&?b=2']) {
				try {
					parseQuery(query);
					console.log(query + ': no error');
				} catch (error) {
					console.log(query + ': ' + error.message);
				}
			}`;
		const result = spawnSync(process.execPath, ['-e', script], {
			cwd: path.join(__dirname, '../..'),
			encoding: 'utf8',
			timeout: 20000,
		});
		assert.equal(result.error, undefined, result.error?.message);
		const lines = result.stdout.trim().split('\n');
		assert.equal(lines.length, 4, result.stdout + result.stderr);
		for (const line of lines) assert.match(line, /unexpected character '\?'/);
	});
	it('Single-argument select forms', function () {
		assert.equal(parseQuery('select(name)').select, 'name');
		assert.deepEqual(parseQuery('select(name,)').select, ['name']);
		const asArray = parseQuery('select([name,id])').select;
		assert.deepEqual([...asArray], ['name', 'id']);
		assert.equal(asArray.asArray, true);
	});
	it('Bad nesting', function () {
		assert.throws(() => parseQuery('(name=value)shouldntbehere'), /expected operator/);
		assert.throws(() => parseQuery('(name))'), /no attribute/);
		assert.throws(() => parseQuery('(=value&=test)'), /attribute must be specified/);
		assert.throws(() => parseQuery('(name=value))'), /unexpected token '\)'/);
		assert.throws(() => parseQuery('(name=value'), /expected '\)', but encountered end of string/);
		assert.throws(() => parseQuery('name=value|test=3&foo=bar'), /mix operators/);
		assert.throws(() => parseQuery('name=value&[test=3&foo=bar|test=4]'), /mix operators/);
	});
});
describe('Parsing queries with RequestTarget', function () {
	it('Basic AND query', function () {
		const query = new RequestTarget('?id=1&name=2');
		const conditions = Array.from(query);
		assert.equal(conditions.length, 2);
		assert.equal(conditions[0][0], 'id');
		assert.equal(conditions[0][1], '1');
		assert.equal(conditions[1][0], 'name');
		assert.equal(conditions[1][1], '2');
	});
	it('Basic OR query', function () {
		let query = new RequestTarget('/somepath/?id=1|name=2');
		assert.equal(query.operator, 'or');
		assert.equal(query.conditions.length, 2);
		assert.equal(query.conditions[0].attribute, 'id');
		assert.equal(query.conditions[0].value, '1');
		assert.equal(query.conditions[1].attribute, 'name');
		assert.equal(query.conditions[1].value, '2');
	});
	it('Basic AND and nested OR query', function () {
		let query = new RequestTarget('something?id=1&(value=gt=4|name=2)');
		assert.equal(query.conditions.length, 2);
		assert.equal(query.conditions[0].attribute, 'id');
		assert.equal(query.conditions[0].value, '1');
		assert.equal(query.conditions[1].operator, 'or');
		assert.equal(query.conditions[1].conditions[0].attribute, 'value');
		assert.equal(query.conditions[1].conditions[0].comparator, 'gt');
		assert.equal(query.conditions[1].conditions[1].comparator, 'equals');
		assert.equal(query.conditions[1].conditions[1].value, '2');
	});
});
describe('RequestTarget collection semantics', () => {
	it('bare resource path (empty, no trailing slash) is well-defined: null id, not a collection', function () {
		const target = new RequestTarget('');
		assert.strictEqual(target.isCollection, false);
		assert.strictEqual(target.id, null);
	});
	it('root slash is a collection with null id', function () {
		const target = new RequestTarget('/');
		assert.strictEqual(target.isCollection, true);
		assert.strictEqual(target.id, null);
	});
	it('query-only target is a collection', function () {
		const target = new RequestTarget('?name=1');
		assert.strictEqual(target.isCollection, true);
		assert.strictEqual(target.id, null);
	});
	it('id path is not a collection', function () {
		const target = new RequestTarget('some-id');
		assert.strictEqual(target.isCollection, undefined);
		assert.strictEqual(target.id, 'some-id');
	});
	it('argless construction leaves isCollection unset for callers to assign', function () {
		const target = new RequestTarget();
		assert.strictEqual(target.isCollection, undefined);
		assert.strictEqual(target.id, undefined);
	});
});
