const assert = require('node:assert');
const { PassThrough } = require('node:stream');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { createBlob, getFilePathForBlob } = require('#src/resources/blob');
const { writeKeyId, TRANSACTION_STATE } = require('#src/resources/DatabaseTransaction');
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
					assert.strictEqual(context.transaction.open, TRANSACTION_STATE.CLOSED);
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
					assert.ok(original.at(-1).priorWrite === original.at(-2), 'refusal keeps the same-key chain');
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

	it('keeps one pending generation ahead of an intervening same-key replacement', async () => {
		const key = id();
		await TestTable.put({ id: key, n: 0 });
		const context = {};
		await transaction(context, async () => {
			const first = await TestTable.getResource({ id: key }, context);
			const second = await TestTable.getResource({ id: key }, context);
			await first.update({ n: 1, obsolete: true });
			await second.update({ n: 7, name: 'later' }, true);
			await first.update({ name: 'last' });
		});
		const result = await TestTable.get(key);
		assert.strictEqual(result.n, 7);
		assert.strictEqual(result.name, 'later');
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
	it('merges repeated updates around an intervening pending write without stranding the earlier intent', async function () {
		if (isLMDB) return this.skip();
		const key = id();
		await TestTable.put({ id: key, n: 0 });
		const context = {};
		const first = await TestTable.getResource({ id: key }, context);
		const later = await TestTable.getResource({ id: key }, context);
		await first.update({ n: 1 });
		await later.update({ name: 'later' });
		await first.update({ n: 2 });
		await first.save();
		await later.save();
		const result = await TestTable.get(key);
		assert.strictEqual(result.n, 2);
		assert.strictEqual(result.name, 'later');
		assert.strictEqual(changesFor(key).length, 2);
		const next = await TestTable.lock(key, { timeout: 100, lease: 5000 }, context);
		await next.unlock();
	});

	for (const edit of ['set', 'update']) {
		it(`edits one pending generation in its original position with ${edit}`, async () => {
			const key = id();
			await TestTable.put({ id: key, n: 0 });
			const context = {};
			await transaction(context, async () => {
				const first = await TestTable.getResource({ id: key }, context);
				const later = await TestTable.getResource({ id: key }, context);
				await first.update({ n: 1 });
				await later.update({ n: 5 });
				if (edit === 'set') first.set('n', 2);
				else await first.update({ n: 2 });
			});
			assert.strictEqual((await TestTable.get(key)).n, 5);
			assert.strictEqual(changesFor(key).length, 2);
		});
	}

	it('merges another update after the refusing explicit owner has released its writes', async function () {
		if (isLMDB) return this.skip();
		const key = id();
		await TestTable.put({ id: key, n: 0 });
		const context = {};
		let holder, pending;
		let observe, rejectObservation;
		const observed = new Promise((resolve, reject) => {
			observe = resolve;
			rejectObservation = reject;
		});
		const committing = transaction(context, async () => {
			holder = await TestTable.lock(key, { hold: true, lease: 30000 }, context);
			holder.set('n', 1);
			await holder.save();
			queueMicrotask(() =>
				queueMicrotask(() => {
					try {
						const owner = context.transaction;
						const handle = owner.recordLocks.get(TestTable.primaryStore).get(writeKeyId(key));
						assert.strictEqual(owner.open, TRANSACTION_STATE.CLOSED);
						assert.ok(handle.hasCommitHold(), 'the native scope commit is still in flight');
						pending = new TestTable(key, context);
						pending.update({ n: 2 });
						assert.rejects(pending.save(), isOverlapRefusal).then(observe, rejectObservation);
					} catch (error) {
						rejectObservation(error);
					}
				})
			);
		});
		try {
			await observed;
			await committing;
			await pending.update({ name: 'retry' });
			await pending.save();
			const result = await TestTable.get(key);
			assert.strictEqual(result.n, 2);
			assert.strictEqual(result.name, 'retry');
			assert.strictEqual(changesFor(key).length, 2);
		} finally {
			await committing;
			await holder?.unlock();
		}
	});

	it('serializes concurrent update staging into the same pending intent', async function () {
		const Embedded = table({
			database: 'deferred_write_lifecycle',
			table: 'ConcurrentEmbedded',
			audit: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name' },
				{ name: 'embedding', type: 'Array', embed: { source: 'name', model: 'default' } },
			],
		});
		Embedded.setEmbedAttribute('embedding', async (record) => {
			await Promise.resolve();
			return [record.name.length];
		});
		const key = id();
		const context = {};
		const record = await Embedded.getResource({ id: key }, context);
		await Promise.all([record.update({ name: 'first' }), record.update({ name: 'second' })]);
		await record.save();
		assert.strictEqual((await Embedded.get(key)).name, 'second');
		assert.deepStrictEqual([...(await Embedded.get(key)).embedding], [6]);
		assert.strictEqual(
			[...Embedded.auditStore.getRange({ start: 1 })].filter((entry) => entry.recordId === key).length,
			1
		);
		if (!isLMDB) {
			const locked = await Embedded.lock(key, { timeout: 100 }, context);
			await locked.unlock();
		}
	});

	it('a full put replaces a pending patch without leaving an orphan', async function () {
		const key = id();
		await TestTable.put({ id: key, n: 0 });
		const context = {};
		const record = await TestTable.getResource({ id: key }, context);
		await record.update({ obsolete: true });
		await record.put(key, { n: 4, name: 'replacement' });
		const result = await TestTable.get(key);
		assert.strictEqual(result.n, 4);
		assert.strictEqual(result.obsolete, undefined);
		assert.strictEqual(changesFor(key).length, 0);
		if (!isLMDB) {
			const locked = await TestTable.lock(key, { timeout: 100 }, context);
			await locked.unlock();
		}
	});

	it('a restricted replacement supersedes a pending patch and retains protected fields', async function () {
		const key = id();
		await TestTable.put({ id: key, n: 0, obsolete: true });
		const user = {
			role: {
				permission: {
					deferred_write_lifecycle: {
						tables: {
							Records: {
								read: true,
								insert: true,
								update: true,
								attribute_permissions: [
									{ attribute_name: 'n', read: true, insert: true, update: true },
									{ attribute_name: 'name', read: true, insert: true, update: true },
								],
							},
						},
					},
				},
			},
		};
		const context = { user };
		const record = await TestTable.getResource({ id: key }, context);
		assert.strictEqual(record.allowUpdate(user, { n: 1 }, context), true);
		await record.update({ n: 1 });
		await record.update({ name: 'replacement' }, true);
		await record.save();
		const result = await TestTable.get(key);
		assert.strictEqual(result.name, 'replacement');
		assert.strictEqual(result.n, undefined);
		assert.strictEqual(result.obsolete, true);
		assert.strictEqual(changesFor(key).length, 1);
		if (!isLMDB) {
			const locked = await TestTable.lock(key, { timeout: 100 }, context);
			await locked.unlock();
		}
	});

	it('retains the expired lease binding through another update on an ordinary instance', async function () {
		if (isLMDB) return this.skip();
		const key = id();
		await TestTable.put({ id: key, n: 0 });
		const context = {};
		const holder = await TestTable.lock(key, { hold: true, lease: 30000 }, context);
		try {
			const record = await TestTable.getResource({ id: key }, context);
			await record.update({ n: 1 });
			const handle = context.transaction.recordLocks.get(TestTable.primaryStore).get(writeKeyId(key));
			handle.revokeLease();
			await record.update({ n: 2 });
			await assert.rejects(
				async () => record.save(),
				(error) => error.statusCode === 409 && /expir/i.test(error.message)
			);
			assert.strictEqual((await TestTable.get(key)).n, 0);
		} finally {
			await holder.unlock();
		}
	});

	it('does not save a superseded full-update blob or wait on its unused stream', async () => {
		const key = id();
		const stream = new PassThrough();
		const discarded = createBlob(stream);
		const context = {};
		try {
			const record = await TestTable.getResource({ id: key }, context);
			await record.update({ blob: discarded, n: 1 }, true);
			await record.update({ n: 2 }, true);
			await record.save();
			assert.strictEqual((await TestTable.get(key)).n, 2);
			assert.strictEqual((await TestTable.get(key)).blob, undefined);
			assert.strictEqual(getFilePathForBlob(discarded), null);
		} finally {
			stream.end();
		}
	});
});
