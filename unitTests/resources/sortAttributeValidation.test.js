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

describe('A sort level after the first', () => {
	let Sealed, Open;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		const Owners = table({
			table: 'SortAttributeOwner',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', type: 'String' },
			],
		});
		await Owners.put('o1', { name: 'first' });
		const attributes = () => [
			{ name: 'id', isPrimaryKey: true },
			{ name: 'tag', indexed: true },
			{ name: 'rank', type: 'Int' },
			{ name: 'details' },
			{ name: 'v', type: 'Array', indexed: { type: 'HNSW' } },
			{ name: 'ownerId', indexed: true },
			{ name: 'owner', relationship: { from: 'ownerId' }, definition: { tableClass: Owners } },
		];
		Sealed = table({ table: 'SortAttributeSealed', database: 'test', sealed: true, attributes: attributes() });
		Open = table({ table: 'SortAttributeOpen', database: 'test', attributes: attributes() });
		for (let id = 1; id <= 4; id++) {
			const record = {
				tag: id % 2 ? 'odd' : 'even',
				rank: 10 - id,
				details: { score: id },
				v: [id, 0, 1],
				ownerId: 'o1',
			};
			await Sealed.put(id, record);
			await Open.put(id, { ...record, undeclared: id });
		}
	});

	it('on a sealed table, is refused with a 404 when its root is an attribute the table does not define', async () => {
		for (const attribute of ['rnak', ['rnak', 'x']]) {
			await assert.rejects(
				async () => fromAsync(Sealed.search({ sort: { attribute: 'tag', next: { attribute } } })),
				(error) => error.statusCode === 404 && /rnak(\.x)? is not a defined attribute/.test(error.message)
			);
		}
	});

	it('is refused when it names no attribute', async () => {
		for (const Table of [Sealed, Open]) {
			for (const next of [{ descending: true }, { attribute: [] }, { attribute: '' }]) {
				await assert.rejects(
					async () => fromAsync(Table.search({ sort: { attribute: 'tag', next } })),
					/Sort requires an attribute/
				);
			}
		}
	});

	it('on a sealed table, orders by $distance after a threshold condition drives the search', async () => {
		const rows = await fromAsync(
			Sealed.search({
				conditions: [{ attribute: 'v', comparator: 'lt', value: 2, target: [1, 0, 1] }],
				sort: { attribute: 'tag', next: { attribute: '$distance' } },
				select: ['id'],
			})
		);
		assert.equal(rows.length, 4);
	});

	it('on a sealed table, orders by a defined attribute, record metadata, or a path from a defined root', async () => {
		for (const next of [
			{ attribute: 'rank' },
			{ attribute: '$updatedtime' },
			{ attribute: ['details', 'score'] },
			{ attribute: ['owner', 'name'] },
		]) {
			const rows = await fromAsync(Sealed.search({ sort: { attribute: 'tag', next }, select: ['id'] }));
			assert.equal(rows.length, 4, JSON.stringify(next));
		}
		const ranked = await fromAsync(
			Sealed.search({ sort: { attribute: 'tag', next: { attribute: 'rank' } }, select: ['id'] })
		);
		assert.deepEqual(
			ranked.map((row) => row.id),
			[4, 2, 3, 1]
		);
	});

	it('on an open table, orders by an attribute its records store without declaring it', async () => {
		const rows = await fromAsync(
			Open.search({ sort: { attribute: 'tag', next: { attribute: 'undeclared', descending: true } }, select: ['id'] })
		);
		assert.deepEqual(
			rows.map((row) => row.id),
			[4, 2, 3, 1]
		);
	});
});
