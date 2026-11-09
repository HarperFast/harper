const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');

describe('string pattern operands on typed attributes', () => {
	let Item;
	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		Item = table({
			database: 'test',
			table: 'StringPatternCoercion',
			attributes: [
				{ name: 'id', type: 'Int', isPrimaryKey: true },
				{ name: 'n', type: 'Int', indexed: true },
				{ name: 'flag', type: 'Boolean', indexed: true },
				{ name: 'extra', type: 'Any', indexed: true },
			],
		});
		for (const [i, n] of [0, 5, 50, 105, 150, null, undefined].entries())
			await Item.put({ id: i + 1, n, flag: false, extra: String(n) });
	});
	after(() => Item.dropTable());

	async function ids(query) {
		const found = [];
		for await (const row of Item.search(query)) found.push(row.id);
		return found.sort((a, b) => a - b);
	}
	const matching = (comparator, value, attribute = 'n') => ids({ conditions: [{ attribute, comparator, value }] });

	for (const comparator of ['contains', 'ct', 'ends_with', 'ew', 'endsWith']) {
		it(`${comparator} preserves leading zeros and empty text`, async () => {
			assert.deepStrictEqual(await matching(comparator, '05'), [4]);
			assert.deepStrictEqual(await matching(comparator, ''), [1, 2, 3, 4, 5]);
			assert.deepStrictEqual(await matching(comparator, 'abc'), []);
		});
	}
	for (const comparator of ['starts_with', 'sw', 'startsWith']) {
		it(`${comparator} keeps text without converting it to an Int`, async () => {
			assert.deepStrictEqual(await matching(comparator, 'abc'), []);
			assert.deepStrictEqual(await matching(comparator, '1'), []);
			await assert.rejects(matching(comparator, undefined), (error) => error.statusCode === 400);
		});
	}
	it('preserves text on Boolean and Any attributes', async () => {
		assert.deepStrictEqual(await matching('contains', 'alse', 'flag'), [1, 2, 3, 4, 5, 6, 7]);
		assert.deepStrictEqual(await matching('ends_with', 'lse', 'flag'), [1, 2, 3, 4, 5, 6, 7]);
		assert.deepStrictEqual(await matching('contains', '05', 'extra'), [4]);
	});
	it('preserves REST and negated pattern operands', async () => {
		assert.deepStrictEqual(await ids(new RequestTarget('?n=ct=05')), [4]);
		assert.deepStrictEqual(await ids(new RequestTarget('?n=not_contains=05')), [1, 2, 3, 5, 6, 7]);
		assert.deepStrictEqual(await ids(new RequestTarget('?n=not_starts_with=abc')), [1, 2, 3, 4, 5, 6, 7]);
	});
	it('continues converting equality and range operands', async () => {
		assert.deepStrictEqual(await matching('equals', '05'), [2]);
		assert.deepStrictEqual(await matching('ge', '105'), [4, 5]);
	});
});
