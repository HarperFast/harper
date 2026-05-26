require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { parseQuery, resolveComparator, getNestedValue } = require('#src/resources/search');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

describe('Query Tier-1 additions', () => {
	let Items, People;

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);

		Items = table({
			table: 'Tier1Items',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true, type: 'Int' },
				{ name: 'status', indexed: true, type: 'String' },
				{ name: 'category', indexed: true, type: 'String' },
				{ name: 'price', indexed: true, type: 'Float' },
				{ name: 'description', type: 'String' }, // non-indexed
				{ name: 'metadata' }, // plain JSON object: { city, region: { state, country } }
				{ name: 'tags', elements: { type: 'String' } }, // array of strings
			],
		});

		People = table({
			table: 'Tier1People',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true, type: 'Int' },
				{ name: 'name', indexed: true, type: 'String' },
				{ name: 'children' }, // array of plain JSON objects: { name, age }
			],
		});

		const items = [
			{
				id: 1,
				status: 'active',
				category: 'A',
				price: 10,
				description: 'apple pie',
				metadata: { city: 'Denver', region: { state: 'CO', country: 'US' } },
				tags: ['fresh', 'sale'],
			},
			{
				id: 2,
				status: 'pending',
				category: 'B',
				price: 20,
				description: 'banana bread',
				metadata: { city: 'Boulder', region: { state: 'CO', country: 'US' } },
				tags: ['sale'],
			},
			{
				id: 3,
				status: 'inactive',
				category: 'A',
				price: 30,
				description: 'cherry tart',
				metadata: { city: 'Denver', region: { state: 'CO', country: 'US' } },
				tags: [],
			},
			{
				id: 4,
				status: 'active',
				category: 'C',
				price: 40,
				description: 'date scone',
				metadata: { city: 'Austin', region: { state: 'TX', country: 'US' } },
				tags: ['new'],
			},
			{
				id: 5,
				status: 'cancelled',
				category: 'B',
				price: 50,
				description: 'elderberry',
				metadata: { city: 'Toronto', region: { state: 'ON', country: 'CA' } },
				tags: ['fresh'],
			},
			{ id: 6, status: 'active', category: 'A', price: 60, description: 'fig roll', metadata: null, tags: [] },
		];
		for (const item of items) await Items.put(item);

		const people = [
			{
				id: 1,
				name: 'Alice',
				children: [
					{ name: 'Tim', age: 5 },
					{ name: 'Sara', age: 12 },
				],
			},
			{ id: 2, name: 'Bob', children: [{ name: 'Pat', age: 22 }] },
			{
				id: 3,
				name: 'Carol',
				children: [
					{ name: 'Lee', age: 13 },
					{ name: 'Max', age: 30 },
				],
			},
			{ id: 4, name: 'Dave', children: [{ name: 'Eve', age: 8 }] },
			{ id: 5, name: 'Eve', children: [] },
		];
		for (const p of people) await People.put(p);
	});

	async function collectIds(iter) {
		const ids = [];
		for await (const record of iter) ids.push(record.id);
		return ids.sort((a, b) => a - b);
	}

	describe('resolveComparator helper', () => {
		it('preserves existing aliases as-is', () => {
			assert.deepEqual(resolveComparator('eq'), { comparator: 'eq', negated: false });
			assert.deepEqual(resolveComparator('not_equal'), { comparator: 'not_equal', negated: false });
			assert.deepEqual(resolveComparator('greater_than'), { comparator: 'greater_than', negated: false });
		});
		it('strips not_ prefix on negatable comparators', () => {
			assert.deepEqual(resolveComparator('not_in'), { comparator: 'in', negated: true });
			assert.deepEqual(resolveComparator('not_starts_with'), { comparator: 'starts_with', negated: true });
			assert.deepEqual(resolveComparator('not_between'), { comparator: 'between', negated: true });
			assert.deepEqual(resolveComparator('not_contains'), { comparator: 'contains', negated: true });
			assert.deepEqual(resolveComparator('not_ends_with'), { comparator: 'ends_with', negated: true });
		});
		it('returns input unchanged for unknown comparators', () => {
			assert.deepEqual(resolveComparator('unknown'), { comparator: 'unknown', negated: false });
			assert.deepEqual(resolveComparator(undefined), { comparator: undefined, negated: false });
		});
	});

	describe('getNestedValue helper', () => {
		it('walks a single segment string', () => {
			assert.equal(getNestedValue({ a: 1 }, 'a'), 1);
			assert.equal(getNestedValue(null, 'a'), undefined);
		});
		it('walks a path array', () => {
			assert.equal(getNestedValue({ a: { b: { c: 7 } } }, ['a', 'b', 'c']), 7);
		});
		it('returns undefined for missing intermediates', () => {
			assert.equal(getNestedValue({ a: null }, ['a', 'b']), undefined);
			assert.equal(getNestedValue({}, ['a', 'b', 'c']), undefined);
		});
	});

	describe('REST query parsing', () => {
		it('parses (v1,v2,v3) list-value syntax with `in`', () => {
			const q = parseQuery('status=in=(active,pending,inactive)');
			assert.equal(q.conditions[0].comparator, 'in');
			assert.deepEqual(q.conditions[0].value, ['active', 'pending', 'inactive']);
		});
		it('parses single-element list', () => {
			const q = parseQuery('status=in=(active)');
			assert.deepEqual(q.conditions[0].value, ['active']);
		});
		it('parses empty list', () => {
			const q = parseQuery('status=in=()');
			assert.deepEqual(q.conditions[0].value, []);
		});
		it('parses not_in to negated in', () => {
			const q = parseQuery('status=not_in=(active,pending)');
			assert.equal(q.conditions[0].comparator, 'in');
			assert.deepEqual(q.conditions[0].value, ['active', 'pending']);
			assert.equal(q.conditions[0].negated, true);
		});
		it('parses not_starts_with as negated starts_with', () => {
			const q = parseQuery('name=not_starts_with=Joh');
			assert.equal(q.conditions[0].comparator, 'starts_with');
			assert.equal(q.conditions[0].value, 'Joh');
			assert.equal(q.conditions[0].negated, true);
		});
		it('parses between with list value', () => {
			const q = parseQuery('age=between=(18,65)');
			assert.equal(q.conditions[0].comparator, 'between');
			assert.deepEqual(q.conditions[0].value, ['18', '65']);
		});
		it('parses typed values inside list', () => {
			const q = parseQuery('id=in=(number:1,number:2,number:3)');
			assert.deepEqual(q.conditions[0].value, [1, 2, 3]);
		});
		it('preserves backwards-compat for non-list (...) values on non-list comparators', () => {
			// gt is not a list-value comparator, so (4) stays as a string
			const q = parseQuery('value=gt=(4)');
			assert.equal(q.conditions[0].value, '(4)');
		});
		it('accepts multi-character FIQL operators', () => {
			const q = parseQuery('a=between=(1,2)|b=in=(x,y)');
			assert.equal(q.conditions[0].comparator, 'between');
			assert.equal(q.conditions[1].comparator, 'in');
		});
	});

	describe('`in` comparator execution', () => {
		it('matches multiple values on indexed attribute (full scan in Phase 1)', async function () {
			const results = await collectIds(
				Items.search({
					allowFullScan: true,
					conditions: [{ attribute: 'status', comparator: 'in', value: ['active', 'pending'] }],
				})
			);
			assert.deepEqual(results, [1, 2, 4, 6]);
		});
		it('empty list matches nothing', async function () {
			const results = await collectIds(
				Items.search({ allowFullScan: true, conditions: [{ attribute: 'status', comparator: 'in', value: [] }] })
			);
			assert.deepEqual(results, []);
		});
		it('single-value list is equivalent to equals', async function () {
			const results = await collectIds(
				Items.search({ allowFullScan: true, conditions: [{ attribute: 'category', comparator: 'in', value: ['A'] }] })
			);
			assert.deepEqual(results, [1, 3, 6]);
		});
		it('combines with another indexed condition (no allowFullScan needed)', async function () {
			const results = await collectIds(
				Items.search({
					operator: 'and',
					conditions: [
						{ attribute: 'category', comparator: 'equals', value: 'A' }, // indexed
						{ attribute: 'status', comparator: 'in', value: ['active', 'inactive'] },
					],
				})
			);
			assert.deepEqual(results, [1, 3, 6]);
		});
		it('throws when in is used without indexed sibling and full scan disallowed', async function () {
			await assert.rejects(async () => {
				for await (const _ of Items.search({
					allowFullScan: false,
					conditions: [{ attribute: 'status', comparator: 'in', value: ['active'] }],
				}));
			}, /can not search for|index/i);
		});
		it('matches arrays of values on multi-valued attribute (some-of semantics)', async function () {
			const results = await collectIds(
				Items.search({
					allowFullScan: true,
					conditions: [{ attribute: 'tags', comparator: 'in', value: ['fresh', 'new'] }],
				})
			);
			// items 1 (fresh,sale), 4 (new), 5 (fresh) — items 2,3,6 don't have any of these
			assert.deepEqual(results, [1, 4, 5]);
		});
	});

	describe('negated comparators (`not_in`, `not_starts_with`, etc.)', () => {
		it('not_in matches records whose value is NOT in the list', async function () {
			const results = await collectIds(
				Items.search({
					allowFullScan: true,
					conditions: [{ attribute: 'status', comparator: 'in', value: ['active'], negated: true }],
				})
			);
			assert.deepEqual(results, [2, 3, 5]);
		});
		it('not_in via parser/REST shape', async function () {
			const results = await collectIds(
				Items.search({
					allowFullScan: true,
					conditions: [{ attribute: 'status', comparator: 'not_in', value: ['active', 'pending'] }],
				})
			);
			assert.deepEqual(results, [3, 5]);
		});
		it('not_starts_with', async function () {
			const results = await collectIds(
				Items.search({
					allowFullScan: true,
					conditions: [{ attribute: 'description', comparator: 'starts_with', value: 'a', negated: true }],
				})
			);
			// only id 1 starts with 'a' (apple pie); rest do not
			assert.deepEqual(results, [2, 3, 4, 5, 6]);
		});
		it('not_contains', async function () {
			const results = await collectIds(
				Items.search({
					allowFullScan: true,
					conditions: [{ attribute: 'description', comparator: 'contains', value: 'e', negated: true }],
				})
			);
			// 'banana bread', 'date scone', 'fig roll' do not contain 'e' wait
			// apple, cherry, elderberry, date, fig — let's compute:
			// id 1: 'apple pie' has 'e'
			// id 2: 'banana bread' has 'e'
			// id 3: 'cherry tart' has 'e'
			// id 4: 'date scone' has 'e'
			// id 5: 'elderberry' has 'e'
			// id 6: 'fig roll' no 'e'
			assert.deepEqual(results, [6]);
		});
		it('not_between', async function () {
			const results = await collectIds(
				Items.search({
					operator: 'and',
					conditions: [
						{ attribute: 'category', comparator: 'in', value: ['A', 'B', 'C'] },
						{ attribute: 'price', comparator: 'between', value: [20, 40], negated: true },
					],
				})
			);
			// prices not in [20, 40]: 10 (id 1), 50 (id 5), 60 (id 6)
			assert.deepEqual(results, [1, 5, 6]);
		});
	});

	describe('Nested-path filtering (plain JSON paths)', () => {
		it('filters on 2-level nested path', async function () {
			const results = await collectIds(
				Items.search({
					allowFullScan: true,
					conditions: [{ attribute: ['metadata', 'city'], comparator: 'equals', value: 'Denver' }],
				})
			);
			assert.deepEqual(results, [1, 3]);
		});
		it('filters on 3-level nested path', async function () {
			const results = await collectIds(
				Items.search({
					allowFullScan: true,
					conditions: [{ attribute: ['metadata', 'region', 'country'], comparator: 'equals', value: 'CA' }],
				})
			);
			assert.deepEqual(results, [5]);
		});
		it('handles missing intermediate (null metadata)', async function () {
			// id 6 has metadata: null — should NOT match any nested-path equality
			const results = await collectIds(
				Items.search({
					allowFullScan: true,
					conditions: [{ attribute: ['metadata', 'city'], comparator: 'equals', value: 'Denver' }],
				})
			);
			assert.equal(results.includes(6), false);
		});
		it('parses dot-notation REST query for nested path', () => {
			const q = parseQuery('metadata.city=Denver');
			assert.deepEqual(q.conditions[0].attribute, ['metadata', 'city']);
		});
		it('combines nested path filter with another indexed condition', async function () {
			const results = await collectIds(
				Items.search({
					operator: 'and',
					conditions: [
						{ attribute: 'category', comparator: 'equals', value: 'A' },
						{ attribute: ['metadata', 'city'], comparator: 'equals', value: 'Denver' },
					],
				})
			);
			assert.deepEqual(results, [1, 3]);
		});
		it('supports starts_with on nested path', async function () {
			const results = await collectIds(
				Items.search({
					allowFullScan: true,
					conditions: [{ attribute: ['metadata', 'region', 'state'], comparator: 'starts_with', value: 'C' }],
				})
			);
			assert.deepEqual(results, [1, 2, 3]);
		});
	});

	describe('Multi-value association: independent vs chained conditions', () => {
		it('independent conditions on multi-value attr: any element matches each (different elements OK)', async function () {
			// people with SOME child > 10 AND SOME child < 15 (could be different children)
			const results = await collectIds(
				People.search({
					operator: 'and',
					allowFullScan: true,
					conditions: [
						{ attribute: ['children', 'age'], comparator: 'gt', value: 10 },
						{ attribute: ['children', 'age'], comparator: 'lt', value: 15 },
					],
				})
			);
			// Alice: children ages [5,12] — 12>10 yes, 5<15 yes (different children) → match
			// Bob: [22] — 22>10 yes, 22<15 no → no match
			// Carol: [13,30] — 30>10 yes, 13<15 yes → match
			// Dave: [8] — 8>10 no → no match
			// Eve: [] → no match
			assert.deepEqual(results, [1, 3]);
		});
		it('chained conditions: same element must satisfy both (collapses to range)', async function () {
			// people with SOME child whose age is BOTH > 10 AND < 15
			const results = await collectIds(
				People.search({
					allowFullScan: true,
					conditions: [
						{
							attribute: ['children', 'age'],
							comparator: 'gt',
							value: 10,
							chainedConditions: [{ comparator: 'lt', value: 15 }],
						},
					],
				})
			);
			// Alice: child age 12 satisfies 10<age<15 → match
			// Carol: child age 13 satisfies 10<age<15 → match
			// Bob (22), Dave (8), Eve ([]) → no match
			assert.deepEqual(results, [1, 3]);
		});
		it('independent conditions can return more than chained (when different elements match each)', async function () {
			// Test: SOME child > 8 AND SOME child < 6 (separate elements ok)
			const independent = await collectIds(
				People.search({
					operator: 'and',
					allowFullScan: true,
					conditions: [
						{ attribute: ['children', 'age'], comparator: 'gt', value: 8 },
						{ attribute: ['children', 'age'], comparator: 'lt', value: 6 },
					],
				})
			);
			// Alice: [5,12] — 12>8 yes, 5<6 yes (different children) → match
			// no others have a child <6 — only Alice
			assert.deepEqual(independent, [1]);

			// Now chained: SOME child satisfies BOTH 8<age AND age<6 (impossible)
			const chained = await collectIds(
				People.search({
					allowFullScan: true,
					conditions: [
						{
							attribute: ['children', 'age'],
							comparator: 'gt',
							value: 8,
							chainedConditions: [{ comparator: 'lt', value: 6 }],
						},
					],
				})
			);
			assert.deepEqual(chained, []);
		});
	});

	describe('Comparator alias normalization at execution layer', () => {
		it('accepts not_in directly without going through parser', async function () {
			const results = await collectIds(
				Items.search({
					allowFullScan: true,
					conditions: [{ attribute: 'status', comparator: 'not_in', value: ['active', 'pending', 'cancelled'] }],
				})
			);
			assert.deepEqual(results, [3]); // only inactive
		});
	});

	describe('Edge cases', () => {
		it('not_in: records with null value match (since null is not in the list)', async function () {
			// Add a record with null status to confirm null behavior
			await Items.put({ id: 99, status: null, category: 'A', price: 1, description: 'null-status' });
			const results = await collectIds(
				Items.search({
					allowFullScan: true,
					conditions: [{ attribute: 'status', comparator: 'in', value: ['active', 'pending'], negated: true }],
				})
			);
			assert(results.includes(99), 'record with null status should match not_in');
			await Items.delete(99);
		});
		it('triple-nested path through array intermediate: some-of at every level', async function () {
			// children is array of objects; child.tags is an array of strings nested inside
			const Multi = table({
				table: 'Tier1Multi',
				database: 'test',
				attributes: [{ name: 'id', isPrimaryKey: true, type: 'Int' }, { name: 'children' }],
			});
			await Multi.put({
				id: 1,
				children: [
					{ name: 'A', items: [{ kind: 'red' }, { kind: 'blue' }] },
					{ name: 'B', items: [{ kind: 'green' }] },
				],
			});
			await Multi.put({
				id: 2,
				children: [{ name: 'C', items: [{ kind: 'green' }] }],
			});
			await Multi.put({ id: 3, children: [] });

			const results = [];
			for await (const r of Multi.search({
				allowFullScan: true,
				conditions: [{ attribute: ['children', 'items', 'kind'], comparator: 'equals', value: 'red' }],
			})) {
				results.push(r.id);
			}
			assert.deepEqual(results.sort(), [1]);
		});
		it('preserves backwards-compat: existing queries without (...) syntax', async function () {
			// Make sure regular equality still works exactly the same
			const results = await collectIds(
				Items.search({ conditions: [{ attribute: 'status', comparator: 'equals', value: 'active' }] })
			);
			assert.deepEqual(results, [1, 4, 6]);
		});
	});
});
