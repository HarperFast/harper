const assert = require('node:assert');
const { PassThrough } = require('node:stream');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { createBlob } = require('#src/resources/blob');
require('#src/server/serverHelpers/serverUtilities');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const isOverlapRefusal = (error) =>
	error.statusCode === 409 && /still committing; await it before writing again/.test(error.message);

describe('Deferred write lifecycle', function () {
	this.timeout(15000);
	let TestTable;
	let nextId = 0;
	const id = () => `deferred-${++nextId}`;
	const changesFor = (key) =>
		[...TestTable.auditStore.getRange({ start: 1 })].filter(
			(entry) => entry.recordId === key && entry.type === 'patch'
		);
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		TestTable = table({
			database: 'deferred_write_lifecycle',
			table: 'Records',
			audit: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'n', indexed: true },
				{ name: 'name' },
				{ name: 'obsolete' },
				{ name: 'blob', type: 'Blob' },
			],
		});
	});

	for (const { hold, closedScope } of [
		{ hold: false, closedScope: false },
		{ hold: true, closedScope: false },
		{ hold: true, closedScope: true },
	]) {
		{
			it(`keeps a refused deferred write pending in order (${closedScope ? 'closed scope' : hold ? 'held' : 'scoped'}, explicit retry)`, async function () {
				if (isLMDB) return this.skip();
				const key = id();
				await TestTable.put({ id: key, n: 0 });
				const context = {};
				let holder;
				if (closedScope) {
					await transaction(async (txn) => {
						context.transaction = txn;
						holder = await TestTable.lock(key, { hold, lease: 30000 }, context);
					});
					assert.ok(!context.transaction.saveCommits);
				} else holder = await TestTable.lock(key, { hold, lease: 30000 }, context);
				const stream = new PassThrough();
				holder.set('n', 1);
				holder.set('blob', createBlob(stream));
				const first = holder.save();
				try {
					await waitFor(() => context.transaction.writes.some((write) => write?.key === key && write.saved));
					const earlier = await TestTable.getResource({ id: key }, context);
					await earlier.update({ n: 2 });
					const later = await TestTable.getResource({ id: key }, context);
					await later.update({ n: 3 });
					const original = context.transaction.writes.filter((write) => write?.key === key);
					await assert.rejects(earlier.save(), isOverlapRefusal);
					const remaining = context.transaction.writes.filter((write) => write?.key === key);
					assert.ok(
						remaining.length === original.length && remaining.every((write, index) => write === original[index]),
						'refusal keeps queue positions'
					);
					assert.strictEqual(original.at(-1).priorWrite, original.at(-2), 'refusal keeps the same-key chain');
					earlier.set('name', 'retry');
					stream.end('payload');
					await first;
					assert.strictEqual((await TestTable.get(key)).n, 1);
					await earlier.save();
					await later.save();
					await earlier.save();
					await later.save();
					assert.strictEqual((await TestTable.get(key)).n, 3, 'later write wins in original staging order');
					assert.strictEqual(
						(await TestTable.get(key)).name,
						'retry',
						'later patch uses the refused write as its basis'
					);
					assert.deepStrictEqual(
						changesFor(key).map((entry) => entry.getValue(TestTable.primaryStore).n),
						[1, 2, 3]
					);
					await holder.unlock();
					const next = await TestTable.lock(key, { timeout: 100, lease: 5000 }, closedScope ? {} : context);
					await next.unlock();
				} finally {
					stream.end();
					await first;
					await holder.unlock();
				}
			});
		}
	}

	it('keeps an untouched deferred write when another holder commit clears its active writes', async function () {
		if (isLMDB) return this.skip();
		const key = id();
		await TestTable.put({ id: key, n: 0 });
		const context = {};
		const holder = await TestTable.lock(key, { hold: true, lease: 30000 }, context);
		const stream = new PassThrough();
		holder.set('n', 1);
		holder.set('blob', createBlob(stream));
		const first = holder.save();
		try {
			await waitFor(() => context.transaction.writes.some((write) => write?.key === key && write.saved));
			const pending = await TestTable.getResource({ id: key }, context);
			await pending.update({ n: 2 });
			stream.end('payload');
			await first;
			await pending.save();
			assert.strictEqual((await TestTable.get(key)).n, 2);
			await holder.unlock();
			const next = await TestTable.lock(key, { timeout: 100, lease: 5000 }, context);
			await next.unlock();
		} finally {
			stream.end();
			await first;
			await holder.unlock();
		}
	});

	it('retry save persists a refused deferred write before a later lock acquisition', async function () {
		if (isLMDB) return this.skip();
		const key = id();
		await TestTable.put({ id: key, n: 0 });
		const context = {};
		const holder = await TestTable.lock(key, { hold: true, lease: 30000 }, context);
		const stream = new PassThrough();
		holder.set('n', 1);
		holder.set('blob', createBlob(stream));
		const first = holder.save();
		try {
			await waitFor(() => context.transaction.writes.some((write) => write?.key === key && write.saved));
			const pending = await TestTable.getResource({ id: key }, context);
			await pending.update({ n: 2 });
			await assert.rejects(pending.save(), isOverlapRefusal);
			stream.end('payload');
			await first;
			await pending.save();
			assert.strictEqual((await TestTable.get(key)).n, 2, 'retry persists the refused update');
			await pending.save();
			assert.strictEqual(changesFor(key).length, 2);
			await holder.unlock();
			const next = await TestTable.lock(key, { timeout: 100, lease: 5000 }, context);
			await next.unlock();
		} finally {
			stream.end();
			await first;
			await holder.unlock();
		}
	});

	for (const keyed of [false, true]) {
		for (const full of [false, true]) {
			it(`merges repeated ${keyed ? 'keyed' : 'direct'} updates into one ${full ? 'replacement' : 'patch'}`, async () => {
				const key = id();
				await TestTable.put({ id: key, n: 0, name: 'old', obsolete: true });
				const context = {};
				await transaction(context, async () => {
					const record = await TestTable.getResource({ id: key }, context);
					if (full) await record.update({ n: 1 }, true);
					else if (keyed) await record.update(key, { n: 1 });
					else await record.update({ n: 1 });
					record.addTo('n', 1);
					if (keyed) await record.update(key, { name: 'merged' });
					else await record.update({ name: 'merged' });
					await record.save();
				});
				const record = await TestTable.get(key);
				assert.strictEqual(record.n, 2, 'the first update survives');
				assert.strictEqual(record.name, 'merged', 'the later update survives');
				assert.strictEqual(record.obsolete, full ? undefined : true, 'replacement semantics survive the patch');
				const entries = [...TestTable.auditStore.getRange({ start: 1 })].filter((entry) => entry.recordId === key);
				assert.strictEqual(entries.length, 2, 'one create and one merged write');
				assert.strictEqual(entries.at(-1).type, full ? 'put' : 'patch');
			});
		}
	}
	it('a later replacement discards an earlier patch on the same instance', async () => {
		const key = id();
		await TestTable.put({ id: key, n: 0, name: 'old' });
		const context = {};
		await transaction(context, async () => {
			const record = await TestTable.getResource({ id: key }, context);
			await record.update({ name: 'discard' });
			await record.update({ n: 4 }, true);
		});
		assert.strictEqual((await TestTable.get(key)).n, 4);
		assert.strictEqual((await TestTable.get(key)).name, undefined);
		assert.strictEqual(changesFor(key).length, 0);
	});

	it('keeps an intervening same-key replacement between updates from one instance', async () => {
		const key = id();
		await TestTable.put({ id: key, n: 0 });
		const context = {};
		await transaction(context, async () => {
			const first = await TestTable.getResource({ id: key }, context);
			const second = await TestTable.getResource({ id: key }, context);
			await first.update({ n: 1, obsolete: true });
			await second.update({ n: 7 }, true);
			await first.update({ name: 'last' });
		});
		const result = await TestTable.get(key);
		assert.strictEqual(result.n, 7);
		assert.strictEqual(result.name, 'last');
		assert.strictEqual(result.obsolete, undefined);
	});

	it('repeated updates on a self-committing instance leave no write blocking a later lock', async function () {
		if (isLMDB) return this.skip();
		const key = id();
		await TestTable.put({ id: key, n: 0 });
		const context = {};
		const record = await TestTable.getResource({ id: key }, context);
		await record.update(key, { n: 1 });
		await record.update(key, { name: 'merged' });
		await record.save();
		assert.strictEqual((await TestTable.get(key)).n, 1);
		assert.strictEqual(changesFor(key).length, 1);
		const next = await TestTable.lock(key, { timeout: 100, lease: 5000 }, context);
		await next.unlock();
	});
	it('keeps the previous update when a replacement embed hook rejects', async () => {
		const Embedded = table({
			database: 'deferred_write_lifecycle',
			table: 'Embedded',
			audit: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name' },
				{ name: 'embedding', type: 'Array', embed: { source: 'name', model: 'default' } },
			],
		});
		Embedded.setEmbedAttribute('embedding', async (record) => {
			if (record.name === 'refuse') throw new Error('refused embedding');
			return [record.name.length];
		});
		const key = id();
		const context = {};
		await transaction(context, async () => {
			const record = await Embedded.getResource({ id: key }, context);
			await record.update({ name: 'accepted' });
			await assert.rejects(record.update({ name: 'refuse' }), /Failed to compute embedding/);
			await record.save();
		});
		assert.strictEqual((await Embedded.get(key)).name, 'accepted');
		assert.deepStrictEqual([...(await Embedded.get(key)).embedding], [8]);
	});
});
