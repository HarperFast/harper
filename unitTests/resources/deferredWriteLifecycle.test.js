const assert = require('node:assert');
const { PassThrough } = require('node:stream');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { createBlob, getFileId, getFilePathForBlob } = require('#src/resources/blob');
const { writeKeyId, TRANSACTION_STATE, suspendDatabaseCommits } = require('#src/resources/DatabaseTransaction');
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

	it('does not revive a refused deferred write discarded by an explicit abort', async function () {
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
			const discarded = context.transaction.writes.find((write) => write?.key === key && !write.saved);
			context.transaction.abort();
			assert.ok(discarded?.dropped, 'the explicit abort discarded the pending operation');
			await pending.save();
			assert.strictEqual((await TestTable.get(key)).n, 1, 'an aborted pending write stays discarded');
			assert.strictEqual(changesFor(key).length, 1);
		} finally {
			stream.end();
			await first;
			await holder.unlock();
		}
	});

	it('does not revive a refused deferred write discarded by its closed explicit owner', async function () {
		if (isLMDB) return this.skip();
		const key = id();
		await TestTable.put({ id: key, n: 0 });
		const context = {};
		let holder;
		await transaction(async (txn) => {
			context.transaction = txn;
			holder = await TestTable.lock(key, { hold: true, lease: 30000 }, context);
		});
		assert.strictEqual(context.transaction.open, TRANSACTION_STATE.CLOSED);
		const stream = new PassThrough();
		holder.set('n', 1);
		holder.set('blob', createBlob(stream));
		const first = holder.save();
		try {
			await waitFor(() => context.transaction.writes.some((write) => write?.key === key && write.saved));
			const pending = await TestTable.getResource({ id: key }, context);
			await pending.update({ n: 2 });
			await assert.rejects(pending.save(), isOverlapRefusal);
			const discarded = context.transaction.writes.find((write) => write?.key === key && !write.saved);
			context.transaction.abort();
			assert.ok(discarded?.dropped, 'the explicit abort discarded the pending operation');
			stream.end('payload');
			await first;
			await pending.save();
			assert.strictEqual((await TestTable.get(key)).n, 1, 'an aborted pending write stays discarded');
			assert.strictEqual(changesFor(key).length, 1);
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
	for (const keyed of [false, true]) {
		for (const scalarFirst of [false, true]) {
			it(`composes ${scalarFirst ? 'set then add' : 'two adds'} in a repeated ${keyed ? 'keyed' : 'direct'} update`, async () => {
				const key = id();
				await TestTable.put({ id: key, n: 0 });
				const context = {};
				const record = await TestTable.getResource({ id: key }, context);
				const first = { n: scalarFirst ? 1 : { __op__: 'add', value: 1 } };
				const second = { n: { __op__: 'add', value: 1 } };
				await (keyed ? record.update(key, first) : record.update(first));
				await (keyed ? record.update(key, second) : record.update(second));
				await record.save();
				assert.strictEqual((await TestTable.get(key)).n, 2);
				assert.strictEqual(changesFor(key).length, 1);
			});
		}
	}

	for (const keyed of [false, true]) {
		it(`validates an unsupported operation after a pending ${keyed ? 'keyed' : 'direct'} change`, async () => {
			const key = id();
			await TestTable.put({ id: key, n: 0 });
			const context = {};
			await assert.rejects(
				transaction(context, async () => {
					const record = await TestTable.getResource({ id: key }, context);
					await record.update({ n: 1 });
					const changes = { n: { __op__: 'mul', value: 2 } };
					await (keyed ? record.update(key, changes) : record.update(changes));
				}),
				(error) => error.statusCode === 400 && /not supported/.test(error.message)
			);
			assert.strictEqual((await TestTable.get(key)).n, 0);
		});
	}

	for (const operand of ['2', Infinity, NaN]) {
		for (const scalarFirst of [false, true]) {
			it(`validates delta ${String(operand)} after ${scalarFirst ? 'a scalar' : 'an add'}`, async () => {
				const key = id();
				await TestTable.put({ id: key, n: 0 });
				const context = {};
				await assert.rejects(
					transaction(context, async () => {
						const record = await TestTable.getResource({ id: key }, context);
						await record.update({ n: scalarFirst ? 1 : { __op__: 'add', value: 1 } });
						await record.update({ n: { __op__: 'add', value: operand } });
					}),
					(error) => error.statusCode === 400 && /numeric/.test(error.message)
				);
				assert.strictEqual((await TestTable.get(key)).n, 0);
			});
		}
	}

	for (const state of ['loaded', 'unloaded', 'new']) {
		it(`preserves bigint precision when composing updates on a ${state} instance`, async () => {
			const Big = table({
				database: 'deferred_write_lifecycle',
				table: 'BigAdds',
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'n', type: 'BigInt' },
				],
			});
			const key = id();
			if (state !== 'new') await Big.put({ id: key, n: 10n });
			const context = {};
			const record = state === 'loaded' ? await Big.getResource({ id: key }, context) : new Big(key, context);
			await record.update({ n: { __op__: 'add', value: 1 } });
			await record.update({ n: { __op__: 'add', value: 9007199254740993n } });
			await record.save();
			assert.strictEqual((await Big.get(key)).n, (state === 'new' ? 0n : 10n) + 9007199254740994n);
		});
	}

	for (const scalarFirst of [false, true]) {
		it(`coerces BigInt strings before composing ${scalarFirst ? 'a scalar and an add' : 'two adds'}`, async () => {
			const Big = table({
				database: 'deferred_write_lifecycle',
				table: 'StringBigAdds',
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'n', type: 'BigInt' },
				],
			});
			const key = id();
			const record = new Big(key, {});
			await record.update({ n: scalarFirst ? '9007199254740993' : { __op__: 'add', value: '9007199254740993' } });
			await record.update({ n: { __op__: 'add', value: '1' } });
			await record.save();
			assert.strictEqual((await Big.get(key)).n, 9007199254740994n);
		});
	}

	it('coerces a pending numeric assignment before adding a large BigInt delta', async () => {
		const Big = table({
			database: 'deferred_write_lifecycle',
			table: 'ScalarBigAdds',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'n', type: 'BigInt' },
			],
		});
		const key = id();
		await Big.put({ id: key, n: 0n });
		const record = await Big.getResource({ id: key }, {});
		await record.update({ n: 1 });
		await record.update({ n: { __op__: 'add', value: 9007199254740993n } });
		await record.save();
		assert.strictEqual((await Big.get(key)).n, 9007199254740994n);
	});

	it('coerces a replacement field without validating absent required fields early', async () => {
		const Big = table({
			database: 'deferred_write_lifecycle',
			table: 'RequiredBigAdds',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'n', type: 'BigInt' },
				{ name: 'name', type: 'String', required: true },
			],
		});
		const key = id();
		const record = new Big(key, {});
		await record.update({ n: '9007199254740993', name: 'kept' }, true);
		await record.update({ n: { __op__: 'add', value: '1' } });
		await record.save();
		const result = await Big.get(key);
		assert.strictEqual(result.n, 9007199254740994n);
		assert.strictEqual(result.name, 'kept');
	});

	for (const mode of ['patch', 'keyed patch', 'replacement']) {
		it(`restores the accepted update after ${mode} fails preflight admission`, async () => {
			const key = id();
			await TestTable.put({ id: key, n: 0, name: 'stored' });
			const record = await TestTable.getResource({ id: key }, {});
			await record.update({ name: 'kept' });
			const suspension = suspendDatabaseCommits([TestTable.primaryStore.rootStore]);
			try {
				await assert.rejects(
					async () => {
						if (mode === 'keyed patch') await record.update(key, { name: 'lost' });
						else await record.update({ name: 'lost' }, mode === 'replacement');
					},
					(error) => error.code === 'DATABASE_CLOSING'
				);
				assert.strictEqual(record.getProperty('name'), 'kept');
				assert.strictEqual(record.getProperty('n'), 0);
			} finally {
				suspension.release();
			}
			record.set('n', 3);
			await record.save();
			assert.strictEqual((await TestTable.get(key)).name, 'kept');
			assert.strictEqual((await TestTable.get(key)).n, 3, 'a valid setter still edits the accepted write');
		});
	}

	for (const keyed of [false, true]) {
		for (const [name, root] of [
			['array', [1]],
			['bytes', Buffer.from('bad')],
			['null', null],
			['string', 'bad'],
		]) {
			it(`keeps an invalid ${name} root visible to validation after a ${keyed ? 'keyed' : 'direct'} update`, async () => {
				const key = id();
				await TestTable.put({ id: key, n: 0 });
				const record = await TestTable.getResource({ id: key }, {});
				await record.update({ n: 1 });
				await assert.rejects(
					async () => {
						await (keyed ? record.update(key, root) : record.update(root, false));
						await record.save();
					},
					(error) => error.statusCode === 400 && /A record must be an object/.test(error.message)
				);
				assert.strictEqual((await TestTable.get(key)).n, 0);
				await TestTable.put({ id: key, n: 2 });
				assert.strictEqual((await TestTable.get(key)).n, 2);
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
		let holder, pending, second;
		const stream = new PassThrough();
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
			holder.set('n', 3);
			holder.set('blob', createBlob(stream));
			second = holder.save();
			await waitFor(() => context.transaction.writes.some((write) => write?.key === key && write.saved));
			await pending.update({ name: 'retry' });
			const refused = assert.rejects(pending.save(), isOverlapRefusal);
			stream.end('payload');
			await second;
			await refused;
			await pending.save();
			const result = await TestTable.get(key);
			assert.strictEqual(result.n, 2);
			assert.strictEqual(result.name, 'retry');
			assert.strictEqual(changesFor(key).length, 3);
		} finally {
			stream.end();
			if (second) await second;
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

	for (const full of [false, true]) {
		it(`fences a hook-delayed ${full ? 'replacement' : 'update'} when a checkpoint has sealed its generation`, async function () {
			if (!isLMDB) return this.skip();
			const Embedded = table({
				database: 'deferred_write_lifecycle',
				table: full ? 'ValidatedFullEmbedded' : 'ValidatedEmbedded',
				audit: true,
				sealed: true,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'n', type: 'Int' },
					{ name: 'name' },
					{ name: 'blob', type: 'Blob' },
					{ name: 'embedding', type: 'Array', embed: { source: 'name', model: 'default' } },
				],
			});
			let release;
			const gate = new Promise((resolve) => {
				release = resolve;
			});
			Embedded.setEmbedAttribute('embedding', async (record) => {
				if (record.name === 'pending') await gate;
				return [record.name.length];
			});
			const key = id();
			const stream = new PassThrough();
			const context = {};
			try {
				await transaction(context, async () => {
					const record = await Embedded.getResource({ id: key }, context);
					await record.update({ n: { __op__: 'add', value: 1 }, name: 'accepted', blob: createBlob(stream) });
					let owner = context.transaction;
					while (owner && !owner.writes.some((write) => write?.key === key)) owner = owner.next;
					assert.ok(owner, 'the table write has an owner');
					const original = owner.writes.find((write) => write?.key === key);
					const rejectedBlob = createBlob('abandoned');
					const updating = full
						? record.put(key, { name: 'pending', blob: rejectedBlob })
						: record.update({ name: 'pending', forbidden: true });
					const refused = assert.rejects(
						updating,
						(error) => error.statusCode === 409 && /after it has been saved/.test(error.message)
					);
					const committing = context.transaction.commit();
					committing.catch(() => {});
					try {
						assert.ok(original.instanceClosed && !original.saved, 'validated, waiting on the real blob stream');
						release();
						await refused;
						assert.strictEqual(getFileId(rejectedBlob), null, 'a refused continuation never starts saving its blob');
					} finally {
						release();
						stream.end('payload');
					}
					await committing;
					await record.update({ name: 'retried' });
					await record.save();
				});
				const result = await Embedded.get(key);
				assert.strictEqual(result.n, 1, 'the accepted increment is never replayed by the delayed update');
				assert.strictEqual(result.name, 'retried');
				assert.strictEqual(result.forbidden, undefined);
				assert.strictEqual(
					[...Embedded.auditStore.getRange({ start: 1 })].filter(
						(entry) => entry.recordId === key && entry.type === 'patch'
					).length,
					2
				);
			} finally {
				release();
				stream.end();
			}
		});
	}
	it('save waits for pending model hooks before admitting or merging their write', async function () {
		const Embedded = table({
			database: 'deferred_write_lifecycle',
			table: 'SaveDuringEmbedded',
			audit: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name' },
				{ name: 'embedding', type: 'Array', embed: { source: 'name', model: 'default' } },
			],
		});
		let release;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		Embedded.setEmbedAttribute('embedding', async (record) => {
			if (record.name === 'pending') await gate;
			return [record.name.length];
		});
		const key = id();
		const context = {};
		const record = await Embedded.getResource({ id: key }, context);
		await record.update({ name: 'accepted' });
		const updating = record.update({ name: 'pending' });
		const saving = record.save();
		const prematurelySaved = context.transaction.writes.some((write) => write?.saved);
		release();
		await updating;
		assert.ok(
			context.transaction.writes.every((write) => !write || write.priorWrite !== write),
			'no self-linked write'
		);
		assert.ok(!prematurelySaved, 'save must wait for the hooks before admitting the replacement');
		await saving;
		const result = await Embedded.get(key);
		assert.strictEqual(result.name, 'pending');
		assert.deepStrictEqual(result.embedding, [7]);
		assert.strictEqual(
			[...Embedded.auditStore.getRange({ start: 1 })].filter((entry) => entry.recordId === key).length,
			1
		);
		if (!isLMDB) {
			const locked = await Embedded.lock(key, { timeout: 100, lease: 5000 }, context);
			await locked.unlock();
		}
	});

	it('a queued update stages independently after the preceding model hook rejects', async function () {
		const Embedded = table({
			database: 'deferred_write_lifecycle',
			table: 'QueuedEmbedded',
			audit: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name' },
				{ name: 'embedding', type: 'Array', embed: { source: 'name', model: 'default' } },
			],
		});
		let rejectHook;
		const gate = new Promise((resolve, reject) => {
			rejectHook = reject;
		});
		Embedded.setEmbedAttribute('embedding', async (record) => {
			if (record.name === 'rejected') await gate;
			return [record.name.length];
		});
		const key = id();
		const context = {};
		const record = await Embedded.getResource({ id: key }, context);
		await record.update({ name: 'accepted' });
		const rejected = record.update({ name: 'rejected' });
		const observedRejection = assert.rejects(rejected, /Failed to compute embedding/);
		const queued = record.update({ name: 'last' });
		rejectHook(new Error('intentional model failure'));
		await observedRejection;
		await queued;
		await record.save();
		const result = await Embedded.get(key);
		assert.strictEqual(result.name, 'last');
		assert.deepStrictEqual(result.embedding, [4]);
		assert.strictEqual(
			[...Embedded.auditStore.getRange({ start: 1 })].filter((entry) => entry.recordId === key).length,
			1
		);
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
