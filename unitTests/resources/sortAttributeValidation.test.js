'use strict';

const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');

async function fromAsync(iterable) {
	const out = [];
	for await (const item of await iterable) out.push(item);
	return out;
}

// A later sort level on an undefined attribute ordered by nothing, with no error.
describe('A sort level after the first', () => {
	let Items;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		Items = table({
			table: 'SortAttributeValidation',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
				{ name: 'rank', type: 'Int' },
				{ name: 'details' },
			],
		});
		for (let id = 1; id <= 4; id++)
			await Items.put(id, { tag: id % 2 ? 'odd' : 'even', rank: 10 - id, details: { score: id } });
	});

	it('is refused with a 404 when it names an attribute the table does not define', async () => {
		await assert.rejects(
			async () => fromAsync(Items.search({ sort: { attribute: 'tag', next: { attribute: 'rnak' } } })),
			(error) => error.statusCode === 404 && /rnak is not a defined attribute/.test(error.message)
		);
	});

	it('is refused when it names no attribute', async () => {
		await assert.rejects(
			async () => fromAsync(Items.search({ sort: { attribute: 'tag', next: { descending: true } } })),
			/Sort requires an attribute/
		);
	});

	it('orders by a defined attribute, record metadata, or a path into a plain object', async () => {
		for (const next of [{ attribute: 'rank' }, { attribute: '$updatedtime' }, { attribute: ['details', 'score'] }]) {
			const rows = await fromAsync(Items.search({ sort: { attribute: 'tag', next }, select: ['id'] }));
			assert.equal(rows.length, 4, JSON.stringify(next));
		}
		const ranked = await fromAsync(
			Items.search({ sort: { attribute: 'tag', next: { attribute: 'rank' } }, select: ['id'] })
		);
		assert.deepEqual(
			ranked.map((row) => row.id),
			[4, 2, 3, 1]
		);
	});
});
