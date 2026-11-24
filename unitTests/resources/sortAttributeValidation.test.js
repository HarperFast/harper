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
	let Items, Owners;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		Owners = table({
			table: 'SortAttributeOwner',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name', type: 'String' }, { name: 'profile' }],
		});
		await Owners.put('o1', { name: 'first', profile: { level: 1 } });
		Items = table({
			table: 'SortAttributeValidation',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
				{ name: 'rank', type: 'Int' },
				{ name: 'details' },
				{ name: 'v', type: 'Array', indexed: { type: 'HNSW' } },
				{ name: 'ownerId', indexed: true },
				{ name: 'owner', relationship: { from: 'ownerId' }, definition: { tableClass: Owners } },
			],
		});
		for (let id = 1; id <= 4; id++)
			await Items.put(id, {
				tag: id % 2 ? 'odd' : 'even',
				rank: 10 - id,
				details: { score: id },
				v: [id, 0, 1],
				ownerId: 'o1',
			});
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

	it('is refused when a relationship path names a leaf the related table does not define', async () => {
		await assert.rejects(
			async () => fromAsync(Items.search({ sort: { attribute: 'tag', next: { attribute: ['owner', 'nmae'] } } })),
			(error) => error.statusCode === 404 && /owner\.nmae is not a defined attribute/.test(error.message)
		);
		// record metadata resolves only on the searched table: through a relationship it read a missing entry
		await assert.rejects(
			async () =>
				fromAsync(Items.search({ sort: { attribute: 'tag', next: { attribute: ['owner', '$updatedtime'] } } })),
			(error) => error.statusCode === 404
		);
	});

	it('is refused when a path continues past a declared scalar', async () => {
		for (const attribute of [
			['rank', 'x'],
			['owner', 'name', 'x'],
		]) {
			await assert.rejects(
				async () => fromAsync(Items.search({ sort: { attribute: 'tag', next: { attribute } } })),
				(error) => error.statusCode === 404 && error.message.includes(`${attribute.join('.')} is not a defined`)
			);
		}
	});

	it('orders by $distance after a threshold condition drives the search', async () => {
		const rows = await fromAsync(
			Items.search({
				conditions: [{ attribute: 'v', comparator: 'lt', value: 2, target: [1, 0, 1] }],
				sort: { attribute: 'tag', next: { attribute: '$distance' } },
				select: ['id'],
			})
		);
		assert.equal(rows.length, 4);
	});

	it('orders by a defined attribute, record metadata, or a path into an untyped field, here or on a related table', async () => {
		for (const next of [
			{ attribute: 'rank' },
			{ attribute: '$updatedtime' },
			{ attribute: ['details', 'score'] },
			{ attribute: ['owner', 'name'] },
			{ attribute: ['owner', 'profile', 'level'] },
		]) {
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
