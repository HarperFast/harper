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

const tooShort = (error) =>
	error.statusCode === 400 && /Search target has 2 components, but this index stores 3/.test(error.message);

// A target of another length ranked by a meaningless distance instead of failing (harper#4482).
describe('An HNSW search with a target of the wrong length', () => {
	let Points;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		Points = table({
			table: 'VectorTargetLength',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
				{ name: 'v', type: 'Array', indexed: { type: 'HNSW', distance: 'cosine' } },
			],
		});
		for (let id = 1; id <= 4; id++) await Points.put(id, { tag: id % 2 ? 'odd' : 'even', v: [id, 0, 1] });
	});

	it('is refused when the sort leads the search', async () => {
		await assert.rejects(
			async () => fromAsync(Points.search({ sort: { attribute: 'v', target: [1, 0] }, select: ['id'], limit: 2 })),
			tooShort
		);
	});

	it('is refused when another condition leads and the sort orders what it finds', async () => {
		await assert.rejects(
			async () =>
				fromAsync(
					Points.search({ conditions: [{ attribute: 'tag', value: 'odd' }], sort: { attribute: 'v', target: [1, 0] } })
				),
			tooShort
		);
	});

	it('is refused for a threshold condition, leading or filtering', async () => {
		const threshold = { attribute: 'v', comparator: 'lt', value: 5, target: [1, 0] };
		for (const conditions of [[threshold], [{ attribute: 'tag', value: 'odd' }, threshold]])
			await assert.rejects(async () => fromAsync(Points.search({ conditions, select: ['id'] })), tooShort);
	});

	it("is accepted at the index's own length", async () => {
		const rows = await fromAsync(
			Points.search({ sort: { attribute: 'v', target: [4, 0, 1] }, select: ['id'], limit: 1 })
		);
		assert.deepEqual(rows, [{ id: 4 }]);
	});

	it('is accepted by an empty index, which has no length yet', async () => {
		const Empty = table({
			table: 'VectorTargetLengthEmpty',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'v', type: 'Array', indexed: { type: 'HNSW' } },
			],
		});
		assert.deepEqual(await fromAsync(Empty.search({ sort: { attribute: 'v', target: [1, 0] } })), []);
	});
});
