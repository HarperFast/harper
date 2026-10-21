require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { parseQuery } = require('#src/resources/search');
const { table } = require('#src/resources/databases');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

describe('FIQL list values, groups, chained legs, and parse-error status', () => {
	let Items;

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		Items = table({
			table: 'FiqlListGroupItems',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true, type: 'Int' },
				{ name: 'status', indexed: true, type: 'String' },
				{ name: 'statusPlain', type: 'String' },
				{ name: 'price', indexed: true, type: 'Float' },
				{ name: 'pricePlain', type: 'Float' },
				{ name: 'note', type: 'String' },
				{ name: 'name', type: 'String' },
				{ name: 'role', type: 'String' },
				{ name: 'profile' },
			],
		});
		const rows = [
			{ id: 1, status: 'active', price: 10, note: 'hello,world', profile: { name: 'Ann', role: 'admin' } },
			{ id: 2, status: 'pending', price: 20, note: 'foo(bar)', profile: { name: 'Bob', role: 'user' } },
			{ id: 3, status: 'inactive', price: 30, note: 'plain', profile: { name: 'Cy', role: 'user' } },
			{ id: 4, status: 'closed', price: 40, note: 'other', profile: { name: 'Di', role: 'guest' } },
		];
		for (const row of rows) {
			await Items.put({
				...row,
				statusPlain: row.status,
				pricePlain: row.price,
				name: 'top-name-' + row.id,
				role: 'top-role-' + row.id,
			});
		}
	});

	async function ids(query) {
		const found = [];
		for await (const record of Items.search(new RequestTarget('?' + query))) found.push(record.id);
		return found.sort((a, b) => a - b);
	}
	async function searchError(query) {
		try {
			await ids(query);
		} catch (error) {
			return error;
		}
		assert.fail(`expected ${query} to be rejected`);
	}
	async function idsOnBothPaths(query) {
		const indexed = await ids(query.replace(/\{s\}/g, 'status').replace(/\{p\}/g, 'price'));
		const unindexed = await ids(query.replace(/\{s\}/g, 'statusPlain').replace(/\{p\}/g, 'pricePlain'));
		assert.deepEqual(unindexed, indexed, `indexed and unindexed disagree for ${query}`);
		return indexed;
	}
	async function assertRejectedOnBothPaths(query, messagePattern) {
		for (const [s, p] of [
			['status', 'price'],
			['statusPlain', 'pricePlain'],
		]) {
			const resolved = query.replace(/\{s\}/g, s).replace(/\{p\}/g, p);
			const error = await searchError(resolved);
			assert.equal(error.statusCode, 400, `${resolved}: ${error.message}`);
			if (messagePattern) assert.match(error.message, messagePattern, resolved);
		}
	}

	describe('list-valued comparators', () => {
		it('parses (a,b) for the includes alias', async function () {
			assert.deepEqual(await idsOnBothPaths('{s}=includes=(active,pending)'), [1, 2]);
		});
		it('parses (a,b) for not_includes', async function () {
			assert.deepEqual(await idsOnBothPaths('{s}=not_includes=(active,pending)'), [3, 4]);
		});
		it('parses typed (a,b) for every range comparator', async function () {
			assert.deepEqual(await idsOnBothPaths('{p}=gele=(number:10,number:30)'), [1, 2, 3]);
			assert.deepEqual(await idsOnBothPaths('{p}=gelt=(number:10,number:30)'), [1, 2]);
			assert.deepEqual(await idsOnBothPaths('{p}=gtle=(number:10,number:30)'), [2, 3]);
			assert.deepEqual(await idsOnBothPaths('{p}=gtlt=(number:10,number:30)'), [2]);
		});
		it('parses untyped (a,b) for a range comparator as bounds, not characters', async function () {
			assert.deepEqual(await idsOnBothPaths('{s}=gele=(active,inactive)'), [1, 3, 4]);
		});
		it('treats the ... alias like between on both paths', async function () {
			for (const attribute of ['price', 'pricePlain']) {
				const found = [];
				for await (const record of Items.search({
					conditions: [{ attribute, comparator: '...', value: [10, 20] }],
				}))
					found.push(record.id);
				assert.deepEqual(
					found.sort((a, b) => a - b),
					[1, 2],
					attribute
				);
			}
		});
	});

	describe('range comparator values', () => {
		it('rejects a value that is not a two-element list with 400', async function () {
			await assertRejectedOnBothPaths('{p}=between=null', /two-element/);
			await assertRejectedOnBothPaths('{p}=between=(number:10)', /two-element/);
			await assertRejectedOnBothPaths('{p}=between=()', /two-element/);
			await assertRejectedOnBothPaths('{p}=between=number:10', /two-element/);
			await assertRejectedOnBothPaths('{s}=between=active', /two-element/);
			await assertRejectedOnBothPaths('{p}=gtlt=(number:10,number:20,number:30)', /two-element/);
		});
		it('rejects a malformed programmatic range value with 400', async function () {
			for (const attribute of ['price', 'pricePlain']) {
				let error;
				try {
					for await (const _ of Items.search({ conditions: [{ attribute, comparator: 'between', value: null }] }));
				} catch (caught) {
					error = caught;
				}
				assert.equal(error?.statusCode, 400, attribute);
			}
		});
	});

	describe('parenthesized condition groups', () => {
		it('still parses the documented simple group form', async function () {
			assert.deepEqual(await idsOnBothPaths('{s}=closed|({p}=gt=number:10&{p}=lt=number:30)'), [2, 4]);
		});
		it('parses list values inside a group', async function () {
			assert.deepEqual(await idsOnBothPaths('({s}=in=(active,pending)|{p}=eq=number:40)'), [1, 2, 4]);
			assert.deepEqual(await idsOnBothPaths('({p}=between=(number:10,number:20)|{s}=eq=closed)'), [1, 2, 4]);
		});
		it('parses values containing commas and balanced parentheses inside a group', async function () {
			assert.deepEqual(await ids('(note=eq=hello,world|price=eq=number:30)'), [1, 3]);
			assert.deepEqual(await ids('(note=eq=foo(bar)|price=eq=number:30)'), [2, 3]);
		});
		it('parses a chained leg inside a group', async function () {
			assert.deepEqual(await idsOnBothPaths('({p}=ge=number:10&=le=number:20|{s}=eq=inactive)'), [1, 2, 3]);
		});
		it('parses nested groups holding list values', async function () {
			assert.deepEqual(await idsOnBothPaths('({p}=gt=number:15&({s}=in=(pending,closed)))'), [2, 4]);
		});
	});

	describe('chained legs', () => {
		it('accepts a chained leg as the last condition of a group', async function () {
			assert.deepEqual(await idsOnBothPaths('[{p}=ge=number:10&=le=number:20]'), [1, 2]);
			assert.deepEqual(await idsOnBothPaths('({p}=ge=number:10&=le=number:20)'), [1, 2]);
			assert.deepEqual(await idsOnBothPaths('{s}=active|[{p}=ge=number:20&=le=number:30]'), [1, 2, 3]);
		});
		it('parses a second chained leg and rejects it with 400', async function () {
			const query = parseQuery('price=ge=1&=le=2&=ge=3', new RequestTarget());
			assert.equal(query.parseError, undefined);
			assert.equal(query.conditions[0].chainedConditions.length, 2);
			await assertRejectedOnBothPaths('{p}=ge=number:10&=le=number:30&=ge=number:20', /more than one condition/);
		});
		it('rejects an or-chained leg with 400', async function () {
			await assertRejectedOnBothPaths('{p}=ge=number:10|=le=number:20', /\|=/);
		});
		it('rejects a programmatic chain with an unknown operator', async function () {
			let error;
			try {
				for await (const _ of Items.search({
					conditions: [
						{
							attribute: 'price',
							comparator: 'ge',
							value: 10,
							operator: 'xor',
							chainedConditions: [{ comparator: 'le', value: 20 }],
						},
					],
				}));
			} catch (caught) {
				error = caught;
			}
			assert.equal(error?.statusCode, 400);
			assert.match(error.message, /Unknown chained condition operator/);
		});
		it('rejects a chain whose lower leg is not gt or ge, instead of reinterpreting it', async function () {
			await assertRejectedOnBothPaths('{p}=eq=number:10&=le=number:20', /greater than/);
		});
		it('records a parse error for a second FIQL comparator on one condition', function () {
			for (const query of ['price=eq=ge=&status=active', 'price<ge=5', '(price=eq=ge=5)']) {
				const target = parseQuery(query, new RequestTarget());
				assert.match(target.parseError?.message ?? '', /unexpected FIQL operator/, query);
			}
			const emptyValue = parseQuery('price=eq=&status=active', new RequestTarget());
			assert.equal(emptyValue.parseError, undefined);
			const chained = parseQuery('price=ge=1&=le=2', new RequestTarget());
			assert.equal(chained.parseError, undefined);
		});
		it('records a parse error for a chained leg with no comparison before it', function () {
			const query = parseQuery('(name=a)&=le=2', new RequestTarget());
			assert.equal(query.parseError?.statusCode, 400);
		});
	});

	describe('parse error status', () => {
		it('stores parse errors on the request target with statusCode 400', async function () {
			const target = new RequestTarget('/FiqlListGroupItems/?(status=in=(active,pending)');
			assert(target.parseError);
			assert.equal(target.parseError.statusCode, 400);
			const error = await searchError('(status=in=(active,pending)');
			assert.equal(error.statusCode, 400);
		});
		it('throws a SyntaxViolation, not a TypeError, from parseQuery without a target', function () {
			assert.throws(
				() => parseQuery('limit(5,10'),
				(error) => error.name === 'SyntaxViolation' && error.statusCode === 400 && /expected '\)'/.test(error.message)
			);
		});
	});

	describe('select with a single nested argument', () => {
		it('parses select(profile{name,role}) as a one-entry property list', function () {
			const query = parseQuery('select(profile{name,role})', new RequestTarget());
			assert.equal(query.select.length, 1);
			assert.equal(query.select[0].name, 'profile');
			assert.deepEqual([...query.select[0]], ['name', 'role']);
		});
		it('projects the nested object rather than root properties', async function () {
			const results = [];
			for await (const record of Items.search(new RequestTarget('?id=2&select(profile{name,role})')))
				results.push(record);
			assert.deepEqual(results, [{ profile: { name: 'Bob', role: 'user' } }]);
		});
	});
});
