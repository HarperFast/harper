require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

// harper#1572: Table.search({ conditions, sort }) must not mutate the caller's
// conditions array. The planner pushes a `{ comparator: 'sort' }` pseudo-condition
// onto the array to align with an index's order; when that pseudo-condition sorts
// first by estimate it is kept and leaks into the caller's array, so a later reuse
// of the same array treats the valueless pseudo-condition as a real condition and
// throws a coercion error.
//
// A sort pseudo-condition estimates at totalCount/2, so it lands first (and leaks)
// whenever the real condition matches MORE than half the rows — hence `category`
// matching every row below.
async function drain(iterable) {
	let count = 0;
	for await (const _ of await iterable) count++;
	return count;
}

describe('#1572 query does not mutate the caller conditions array', () => {
	let T;
	before(async function () {
		this.timeout(60000);
		setupTestDBPath();
		setMainIsWorker(true);
		T = table({
			table: 'MutTest',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'category', indexed: true },
				// typed sort attribute: on reuse, coercion runs on the leaked valueless
				// pseudo-condition and throws (as the reported Date attribute did)
				{ name: 'ts', type: 'Date', indexed: true },
			],
		});
		let last;
		for (let i = 0; i < 20; i++) last = T.put({ id: i, category: 'common', ts: new Date(1_700_000_000_000 + i) });
		await last;
	});

	it('leaves the conditions array unchanged after a sort query', async () => {
		await transaction(async () => {
			const conditions = [{ attribute: 'category', comparator: 'equals', value: 'common' }];
			await drain(T.search({ conditions, sort: { attribute: 'ts', descending: true } }));

			assert.strictEqual(conditions.length, 1, 'conditions array grew (sort pseudo-condition leaked)');
			assert.ok(
				!conditions.some((c) => c.comparator === 'sort'),
				'a sort pseudo-condition leaked into the caller array'
			);
		});
	});

	it('allows reusing the same conditions array after a sort query', async () => {
		await transaction(async () => {
			const conditions = [{ attribute: 'category', comparator: 'equals', value: 'common' }];
			// query 1 — sorted; must not poison `conditions`
			await drain(T.search({ conditions, sort: { attribute: 'ts', descending: true } }));
			// query 2 — reuse the same array; a leaked pseudo-condition throws here
			const count = await drain(T.search({ conditions }));
			assert.strictEqual(count, 20);
		});
	});

	it('does not mutate a conditions array (or its entries) passed as the target directly', async () => {
		await transaction(async () => {
			// array-form target: search(conditions) rather than search({ conditions }).
			// `ts` is Date-typed, so planning coerces the string bound to a Date — that
			// coercion (and any estimate annotation) must land on our copy, not the
			// caller's entry object.
			const conditions = [{ attribute: 'ts', comparator: 'greater_than', value: '2023-11-14T22:13:20.000Z' }];
			await drain(T.search(conditions));
			assert.strictEqual(conditions.length, 1, 'array-form target array was mutated');
			assert.strictEqual(
				conditions[0].value,
				'2023-11-14T22:13:20.000Z',
				'caller condition value was coerced in place'
			);
			assert.ok(!('estimated_count' in conditions[0]), 'estimated_count leaked onto the caller condition');
		});
	});

	it('does not leak a sort descending flag onto a reused condition object', async () => {
		await transaction(async () => {
			// condition on the SAME attribute as the sort: planning aligns the sort by
			// setting `descending` on the existing condition entry. That must not persist
			// onto the caller's object and reverse an unrelated later query.
			const condition = { attribute: 'ts', comparator: 'greater_than', value: new Date(0) };
			await drain(T.search({ conditions: [condition], sort: { attribute: 'ts', descending: true } }));
			assert.ok(!('descending' in condition), 'descending leaked onto the caller condition object');

			// reuse without a sort: results must be in ascending (natural) order
			const seen = [];
			for await (const r of await T.search({ conditions: [condition] })) seen.push(r.ts.getTime());
			const ascending = [...seen].sort((a, b) => a - b);
			assert.deepStrictEqual(seen, ascending, 'reused query scanned in reverse from a leaked descending flag');
		});
	});
});
