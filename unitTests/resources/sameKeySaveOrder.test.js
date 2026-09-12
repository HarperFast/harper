const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('same-key explicit save ordering', () => {
	let SaveOrder;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		SaveOrder = table({
			table: 'SaveOrder',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'status', indexed: true },
				{ name: 'metadata' },
				{ name: 'count', type: 'Int' },
				{ name: 'dates', type: 'array', elements: { type: 'Date' } },
			],
		});
	});

	it('preserves a create followed by an explicitly saved patch', async () => {
		const context = {};
		await transaction(context, async () => {
			await SaveOrder.create({ id: 'create-patch', status: 'queued' }, context);
			await SaveOrder.patch('create-patch', { metadata: 'required' }, context);
			if (!isLMDB) {
				const staged = await SaveOrder.get('create-patch', context);
				assert.equal(staged.id, 'create-patch');
				assert.equal(staged.status, 'queued');
				assert.equal(staged.metadata, 'required');
			}
		});
		const committed = await SaveOrder.get('create-patch');
		assert.equal(committed.id, 'create-patch');
		assert.equal(committed.status, 'queued');
		assert.equal(committed.metadata, 'required');
	});

	it('preserves repeated explicitly saved patches and their index changes', async () => {
		const context = {};
		await transaction(context, async () => {
			await SaveOrder.create({ id: 'repeated', status: 'queued' }, context);
			await SaveOrder.patch('repeated', { status: 'running' }, context);
			await SaveOrder.patch('repeated', { metadata: 'complete' }, context);
			if (!isLMDB) {
				const staged = await SaveOrder.get('repeated', context);
				assert.equal(staged.status, 'running');
				assert.equal(staged.metadata, 'complete');
			}
		});
		const committed = await SaveOrder.get('repeated');
		assert.equal(committed.status, 'running');
		assert.equal(committed.metadata, 'complete');
		const oldIndex = [];
		for await (const record of SaveOrder.search([{ attribute: 'status', value: 'queued' }])) oldIndex.push(record);
		assert.equal(
			oldIndex.some((record) => record.id === 'repeated'),
			false
		);
		const newIndex = [];
		for await (const record of SaveOrder.search([{ attribute: 'status', value: 'running' }])) newIndex.push(record);
		assert.equal(
			newIndex.some((record) => record.id === 'repeated'),
			true
		);
	});

	it('drains multiple unsaved predecessors oldest-first', async () => {
		await SaveOrder.put('long-chain', { status: 'queued', count: 0 });
		const context = {};
		await transaction(context, async () => {
			await SaveOrder.update('long-chain', { status: 'running' }, context);
			await SaveOrder.update('long-chain', { metadata: 'middle' }, context);
			const last = await SaveOrder.update('long-chain', { count: 2 }, context);
			await last.save();
		});
		const committed = await SaveOrder.get('long-chain');
		assert.equal(committed.status, 'running');
		assert.equal(committed.metadata, 'middle');
		assert.equal(committed.count, 2);
	});

	it('rolls back predecessors staged by an explicit save', async () => {
		const context = {};
		await assert.rejects(
			transaction(context, async () => {
				await SaveOrder.create({ id: 'rollback', status: 'queued' }, context);
				await SaveOrder.patch('rollback', { metadata: 'must-not-land' }, context);
				throw new Error('forced rollback');
			}),
			/forced rollback/
		);
		assert.equal(await SaveOrder.get('rollback'), undefined);
	});

	it('closes an ordinary update instance when it is saved', async () => {
		await SaveOrder.put('closed', { status: 'queued', details: { nested: 'before' }, items: [1, 2], count: 0 });
		const context = {};
		await transaction(context, async () => {
			const update = await SaveOrder.update('closed', {}, context);
			const details = update.details;
			const items = update.items;
			update.status = 'running';
			await update.save();
			assert.throws(
				() => (update.status = 'late'),
				(error) => error.statusCode === 409 && /after it has been saved/.test(error.message)
			);
			assert.throws(() => (details.nested = 'late'), /after it has been saved/);
			assert.throws(() => (items[0] = 9), /after it has been saved/);
			assert.throws(() => delete items[0], /after it has been saved/);
			assert.throws(() => Object.defineProperty(items, '0', { value: 9 }), /after it has been saved/);
			assert.throws(() => items.pop(), /after it has been saved/);
			assert.throws(() => update.addTo('count', 1), /after it has been saved/);
			await update.save();

			update.update();
			assert.throws(() => (details.nested = 'stale'), /after it has been saved/);
			assert.throws(() => items.pop(), /after it has been saved/);
			update.metadata = 'fresh update';
			update.items.pop();
			update.addTo('count', 1);
			await update.save();
			update.update();
			update.metadata = 'third update';
			await update.save();
		});
		const committed = await SaveOrder.get('closed');
		assert.equal(committed.status, 'running');
		assert.equal(committed.metadata, 'third update');
		assert.equal(committed.details.nested, 'before');
		assert.deepStrictEqual(committed.items, [1]);
		assert.strictEqual(Object.getPrototypeOf(committed.items), Array.prototype);
		assert.equal(committed.count, 1);
	});

	it('does not rebind an explicitly saved empty generation to its successor', async () => {
		await SaveOrder.put('empty-generation', { count: 0 });
		const context = {};
		await transaction(context, async () => {
			const update = await SaveOrder.update('empty-generation', undefined, context);
			await update.save();
			update.update();
			update.addTo('count', 1);
			await update.save();
		});
		assert.equal((await SaveOrder.get('empty-generation')).count, 1);
	});

	it('keeps an untouched update of a missing record as a no-op', async () => {
		const context = {};
		await transaction(context, async () => {
			const update = await SaveOrder.update('missing-empty-generation', undefined, context);
			await update.save();
		});
		assert.equal(await SaveOrder.get('missing-empty-generation'), undefined);
	});

	it('closes a receiver for an equivalent numeric key spelling', async () => {
		await SaveOrder.put(1, { status: 'queued' });
		const context = {};
		await transaction(context, async () => {
			const receiver = await SaveOrder.update(1, {}, context);
			await receiver.put(1n, { status: 'running' });
			assert.throws(() => (receiver.status = 'late'), /after it has been saved/);
		});
		assert.equal((await SaveOrder.get(1)).status, 'running');
	});

	it('allows validation coercion before closing the instance', async () => {
		await SaveOrder.put('coercion', { dates: [] });
		const context = {};
		await transaction(context, async () => {
			const update = await SaveOrder.update('coercion', {}, context);
			update.dates.push('2026-09-09T00:00:00.000Z');
			await update.save();
			assert.throws(() => update.dates.push('2026-09-10T00:00:00.000Z'), /after it has been saved/);
		});
		assert((await SaveOrder.get('coercion')).dates[0] instanceof Date);
	});

	it('can correct and retry a write after validation fails', async function () {
		if (isLMDB) this.skip();
		await SaveOrder.put('retry-validation', { dates: [] });
		const context = {};
		await transaction(context, async () => {
			const update = await SaveOrder.update('retry-validation', {}, context);
			update.dates.push({ invalid: true });
			assert.throws(() => update.save(), /must be a Date/);
			update.dates[0] = '2026-09-09T00:00:00.000Z';
			await update.save();
		});
		assert((await SaveOrder.get('retry-validation')).dates[0] instanceof Date);
	});

	it('retries a failed predecessor before saving its successor', async function () {
		if (isLMDB) this.skip();
		await SaveOrder.put('retry-predecessor', { dates: [] });
		const context = {};
		await transaction(context, async () => {
			const predecessor = await SaveOrder.update('retry-predecessor', {}, context);
			predecessor.dates.push({ invalid: true });
			const successor = await SaveOrder.update('retry-predecessor', { status: 'complete' }, context);
			assert.throws(() => successor.save(), /must be a Date/);
			predecessor.dates[0] = '2026-09-09T00:00:00.000Z';
			await successor.save();
		});
		const committed = await SaveOrder.get('retry-predecessor');
		assert(committed.dates[0] instanceof Date);
		assert.equal(committed.status, 'complete');
	});

	it('keeps a collection receiver open across a bulk put', async function () {
		if (isLMDB) this.skip();
		await SaveOrder.put([
			{ id: 'bulk-a', status: 'queued' },
			{ id: 'bulk-b', status: 'running' },
		]);
		assert.equal((await SaveOrder.get('bulk-a')).status, 'queued');
		assert.equal((await SaveOrder.get('bulk-b')).status, 'running');
	});

	it('keeps method-based writes to other keys usable after save', async () => {
		await SaveOrder.put('receiver-a', { status: 'queued' });
		const context = {};
		await transaction(context, async () => {
			const receiver = await SaveOrder.update('receiver-a', { status: 'complete' }, context);
			await receiver.save();
			await receiver.put('receiver-b', { status: 'running' });
			await assert.rejects(async () => receiver.put('receiver-a', { status: 'late' }), /after it has been saved/);
		});
		assert.equal((await SaveOrder.get('receiver-a')).status, 'complete');
		assert.equal((await SaveOrder.get('receiver-b')).status, 'running');
	});

	it('commits an off-key write through a closed receiver without an explicit scope', async () => {
		await SaveOrder.put('standalone-a', { status: 'queued' });
		const receiver = await SaveOrder.update('standalone-a', { status: 'complete' });
		await receiver.save();
		await receiver.put('standalone-b', { status: 'running' });
		assert.equal((await SaveOrder.get('standalone-a')).status, 'complete');
		assert.equal((await SaveOrder.get('standalone-b')).status, 'running');
	});

	it('rejects same-key writes from a closed instance before acquiring a lock', async function () {
		if (isLMDB) this.skip();
		await SaveOrder.put('closed-methods', { status: 'queued' });
		const context = {};
		await transaction(context, async () => {
			const receiver = await SaveOrder.update('closed-methods', { status: 'complete' }, context);
			await receiver.save();
			await assert.rejects(async () => receiver.delete(), /after it has been saved/);
			await assert.rejects(receiver.lock(), /after it has been saved/);
			assert.equal(context.transaction.recordLockFor(SaveOrder.primaryStore, 'closed-methods'), undefined);
		});
	});

	it('closes an earlier update when a later same-key save consumes it', async () => {
		await SaveOrder.put('indirect-close', { status: 'queued' });
		const context = {};
		await transaction(context, async () => {
			const earlier = await SaveOrder.update('indirect-close', { status: 'running' }, context);
			await SaveOrder.patch('indirect-close', { metadata: 'saved later' }, context);
			assert.throws(() => (earlier.status = 'late'), /after it has been saved/);
			await earlier.save();
		});
		const committed = await SaveOrder.get('indirect-close');
		assert.equal(committed.status, 'running');
		assert.equal(committed.metadata, 'saved later');
	});

	it('closes an update when its transaction commits it', async () => {
		await SaveOrder.put('commit-close', { status: 'queued' });
		let update;
		await transaction(async (context) => {
			update = await SaveOrder.update('commit-close', { status: 'complete' }, context);
		});
		assert.throws(() => (update.status = 'late'), /after it has been saved/);
		assert.equal((await SaveOrder.get('commit-close')).status, 'complete');
	});
});
