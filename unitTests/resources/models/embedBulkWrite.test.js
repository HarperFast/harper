'use strict';

const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { setupTestDBPath } = require('../../testUtils');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

// A loadAsInstance:false table reaches Table.put's array branch directly. With @embed the
// embed hook is async, so the parallel writes must not share the single #savingOperation
// slot: if element A's embed resolves first and save() reads the slot, it must save A's op
// (whose vector is written), NOT a later element's op whose embed is still pending.
describe('@embed bulk array write — staggered embed timing (loadAsInstance:false)', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;
	let T;
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		T = table({
			table: 'EmbedBulkRace',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'content', type: 'String' },
				{ name: 'embedding', type: 'Array', embed: { source: 'content', model: 'default' }, indexed: { type: 'HNSW' } },
			],
		});
		T.loadAsInstance = false;
		// Stagger: the first element's embed resolves immediately; the second's resolves later.
		// This forces the "A done, B still pending" interleaving that exposes a shared save slot.
		T.setEmbedAttribute('embedding', async (record) => {
			const n = String(record.content ?? '').length;
			if (String(record.content).startsWith('slow')) await delay(40);
			return [n, n, n];
		});
	});

	it('commits each element with its own vector regardless of embed completion order', async () => {
		await transaction((context) =>
			T.put(
				[
					{ id: 'fast', content: 'ab' }, // embed resolves immediately -> [2,2,2]
					{ id: 'slow', content: 'slow-content' }, // embed resolves after a delay -> [12,12,12]
				],
				context
			)
		);

		const fast = await T.get('fast');
		const slow = await T.get('slow');
		assert.equal(fast?.content, 'ab');
		assert.deepEqual([...(fast?.embedding ?? [])], [2, 2, 2], 'fast element vector');
		assert.equal(slow?.content, 'slow-content');
		assert.deepEqual(
			[...(slow?.embedding ?? [])],
			[12, 12, 12],
			'slow element vector must be written before its op is saved'
		);
	});
});
