const assert = require('node:assert');
const { existsSync } = require('node:fs');
const { PassThrough } = require('node:stream');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
const { table } = require('#src/resources/databases');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const {
	createBlob,
	deleteBlobAndWait,
	getFileId,
	getFilePathForBlob,
	setDeletionDelay,
} = require('#src/resources/blob');
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

	for (const keyed of [false, true]) {
		for (const operation of ['mul', 'invalid add']) {
			it(`rejects ${operation} in a ${keyed ? 'keyed' : 'direct'} patch without consuming the pending replacement`, async () => {
				const key = id();
				await TestTable.put({ id: key, n: 0, obsolete: true });
				const record = await TestTable.getResource({ id: key }, {});
				await record.update({ n: 1, name: 'kept' }, true);
				const changes = { n: operation === 'mul' ? { __op__: 'mul', value: 2 } : { __op__: 'add', value: '2' } };
				await assert.rejects(
					async () => (keyed ? record.update(key, changes) : record.update(changes)),
					(error) => error.statusCode === 400
				);
				assert.strictEqual(record.getProperty('n'), 1);
				assert.strictEqual(record.getProperty('name'), 'kept');
				record.set('n', 3);
				await record.save();
				const result = await TestTable.get(key);
				assert.strictEqual(result.n, 3);
				assert.strictEqual(result.name, 'kept');
				assert.strictEqual(result.obsolete, undefined);
				assert.strictEqual(
					[...TestTable.auditStore.getRange({ start: 1 })].filter((entry) => entry.recordId === key).length,
					2
				);
			});
		}
	}

	for (const { initial, preceding, deltas, expected, label } of [
		{ initial: 0, preceding: 0n, deltas: [9007199254740993n, 1n], expected: 9007199254740994n, label: 'large BigInt' },
		{ initial: 0n, preceding: 0, deltas: [1n, 0.5], expected: 1.5, label: 'Number fraction' },
		{ initial: 0n, preceding: undefined, deltas: [1, 2], expected: 3, label: 'missing Number' },
		{ initial: 0, preceding: undefined, deltas: [1n, 2n], expected: 3n, label: 'missing BigInt' },
	])
		for (const scoped of [false, true])
			it(`preserves ${label} additions after a staged base change (${scoped ? 'explicit' : 'immediate'})`, async () => {
				const key = id();
				await TestTable.put({ id: key, n: initial });
				const context = {};
				const run = async () => {
					const earlierView = await TestTable.getResource({ id: key }, context);
					const precedingWriter = await TestTable.getResource({ id: key }, context);
					await precedingWriter.update({ n: preceding });
					for (const value of deltas) await earlierView.update({ n: { __op__: 'add', value } });
					if (!scoped) await precedingWriter.save();
					await earlierView.save();
				};
				if (scoped) await transaction(context, run);
				else await run();
				assert.strictEqual((await TestTable.get(key)).n, expected);
			});

	it('folds Number fractions as operands before applying their integer sum to BigInt', async () => {
		const key = id();
		await TestTable.put({ id: key, n: 0 });
		const context = {};
		await transaction(context, async () => {
			const earlierView = await TestTable.getResource({ id: key }, context);
			const precedingWriter = await TestTable.getResource({ id: key }, context);
			await precedingWriter.update({ n: 0n });
			await earlierView.update({ n: { __op__: 'add', value: 0.5 } });
			await earlierView.update({ n: { __op__: 'add', value: 0.5 } });
		});
		assert.strictEqual((await TestTable.get(key)).n, 1n);
	});

	for (const mode of ['update', 'addTo']) {
		for (const sample of [
			{ label: 'Number fraction', base: 10, deltas: [1n, 0.5], expected: 11.5 },
			{ label: 'BigInt mixed integers', base: 0n, deltas: [1, 9007199254740992n], expected: 9007199254740993n },
			{ label: 'missing', base: undefined, deltas: [1, 2n], expected: 3n },
			{ label: 'null', base: null, deltas: [1, 2n], expected: 3n },
			{ label: 'NaN', base: NaN, deltas: [1, 2n], expected: 3n },
			{ label: 'non-numeric string', base: 'not numeric', deltas: [1, 2n], expected: 3n },
			{
				label: 'BigInt overflow',
				base: 0n,
				deltas: [Number.MAX_VALUE, Number.MAX_VALUE],
				expected: 2n * BigInt(Number.MAX_VALUE),
			},
			{ label: 'Number overflow', base: 0, deltas: [Number.MAX_VALUE, Number.MAX_VALUE], expected: Infinity },
			{
				label: 'negative BigInt overflow',
				base: 0n,
				deltas: [-Number.MAX_VALUE, -Number.MAX_VALUE],
				expected: -2n * BigInt(Number.MAX_VALUE),
			},
			{
				label: 'negative Number overflow',
				base: 0,
				deltas: [-Number.MAX_VALUE, -Number.MAX_VALUE],
				expected: -Infinity,
			},
			{
				label: 'missing overflow',
				base: undefined,
				deltas: [Number.MAX_VALUE, Number.MAX_VALUE],
				expected: 2n * BigInt(Number.MAX_VALUE),
			},
			{
				label: 'finite Number rounding on BigInt',
				base: 0n,
				deltas: [Number.MAX_SAFE_INTEGER, 2],
				expected: 9007199254740992n,
			},
		]) {
			it(`uses operand folding for ${sample.label} through ${mode}`, async () => {
				const Numeric = table({
					database: 'deferred_write_lifecycle',
					table: 'OperandFold',
					audit: true,
					attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
				});
				const key = id();
				await Numeric.put(key, { n: sample.base });
				const record = await Numeric.getResource({ id: key }, {});
				for (const value of sample.deltas) {
					if (mode === 'update') await record.update({ n: { __op__: 'add', value } });
					else record.addTo('n', value);
				}
				await record.save();
				await record.save();
				assert.strictEqual((await Numeric.get(key)).n, sample.expected);
				const patches = [...Numeric.auditStore.getRange({ start: 1 })].filter(
					(entry) => entry.tableId === Numeric.tableId && entry.recordId === key && entry.type === 'patch'
				);
				assert.strictEqual(patches.length, 1);
			});
		}
	}

	it('documents overflow cancellation against an opposite-sign Number base', async () => {
		const Numeric = table({
			database: 'deferred_write_lifecycle',
			table: 'MagnitudeFold',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
		});
		const initial = -1.7e308;
		for (const merged of [false, true]) {
			const key = id();
			await Numeric.put(key, { n: initial });
			const record = await Numeric.getResource({ id: key }, {});
			for (const value of [1e308, 1e308]) {
				await record.update({ n: { __op__: 'add', value } });
				if (!merged) await record.save();
			}
			if (merged) await record.save();
			const expected = merged ? Infinity : initial + 1e308 + 1e308;
			assert.strictEqual((await Numeric.get(key)).n, expected);
			assert.strictEqual(Number.isFinite(expected), !merged);
		}
	});

	for (const base of [0, 0n]) {
		it(`documents an out-of-range BigInt and fractional delta on a ${typeof base} base`, async () => {
			const Numeric = table({
				database: 'deferred_write_lifecycle',
				table: 'MagnitudeFold',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
			});
			const huge = 10n ** 400n;
			const orderedKey = id();
			await Numeric.put(orderedKey, { n: base });
			const ordered = async () => {
				for (const value of [huge, 0.5]) {
					const row = await Numeric.getResource({ id: orderedKey }, {});
					await row.update({ n: { __op__: 'add', value } });
					await row.save();
				}
			};
			if (typeof base === 'bigint') await assert.rejects(ordered, /BigInt|integer/i);
			else await ordered();
			assert.strictEqual((await Numeric.get(orderedKey)).n, typeof base === 'bigint' ? huge : Infinity);
			const key = id();
			await Numeric.put(key, { n: base });
			const record = await Numeric.getResource({ id: key }, {});
			await record.update({ n: { __op__: 'add', value: huge } });
			await record.update({ n: { __op__: 'add', value: 0.5 } });
			await assert.rejects(
				async () => record.save(),
				(error) => error.name === 'ValidationError' && /Infinity/.test(error.message)
			);
			assert.strictEqual((await Numeric.get(key)).n, base);
		});
	}

	it('documents declared Number overflow admission for update and addTo', async () => {
		const Numeric = table({
			database: 'deferred_write_lifecycle',
			table: 'DeclaredNumberOverflow',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'n', type: 'Number' },
			],
		});
		for (const mode of ['ordered', 'update', 'addTo']) {
			const key = id();
			await Numeric.put(key, { n: 0 });
			const apply = async () =>
				transaction(async (txn) => {
					const record = await Numeric.getResource({ id: key }, { transaction: txn });
					for (const value of [Number.MAX_VALUE, Number.MAX_VALUE]) {
						if (mode === 'addTo') record.addTo('n', value);
						else await record.update({ n: { __op__: 'add', value } });
						if (mode === 'ordered') await record.save();
					}
				});
			if (mode === 'addTo') await assert.rejects(apply, /can not be converted to one exactly/);
			else await apply();
			assert.strictEqual((await Numeric.get(key)).n, mode === 'addTo' ? 0 : Infinity);
		}
	});

	for (const value of [Infinity, -Infinity, NaN]) {
		it(`names the invalid ${String(value)} operand in validation errors`, async () => {
			const key = id();
			await TestTable.put(key, { n: 0 });
			const record = await TestTable.getResource({ id: key }, {});
			await record.update({ n: { __op__: 'add', value } });
			await assert.rejects(
				async () => record.save(),
				(error) => error.message.includes(`Value ${String(value)} for operation add`)
			);
			assert.strictEqual((await TestTable.get(key)).n, 0);
		});
	}

	it('keeps a null-prototype operand failure as a validation error', async () => {
		const key = id();
		await TestTable.put(key, { n: 0 });
		const record = await TestTable.getResource({ id: key }, {});
		await record.update({ n: { __op__: 'add', value: Object.create(null) } });
		await assert.rejects(
			async () => record.save(),
			(error) => error.name === 'ValidationError' && /Value {} for operation add/.test(error.message)
		);
		assert.strictEqual((await TestTable.get(key)).n, 0);
	});

	it('normalizes declared BigInt addTo operands before folding', async () => {
		const Big = table({
			database: 'deferred_write_lifecycle',
			table: 'DeclaredFold',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'n', type: 'BigInt' },
			],
		});
		const key = id();
		await Big.put(key, { n: 0n });
		const record = await Big.getResource({ id: key }, {});
		record.addTo('n', 9007199254740992);
		assert.strictEqual(record.getChanges().n.value, 9007199254740992n);
		record.addTo('n', 1);
		await record.save();
		assert.strictEqual((await Big.get(key)).n, 9007199254740993n);
	});

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

	for (const { type, nullable } of [
		{},
		{ type: 'Int' },
		{ type: 'Int', nullable: false },
		{ type: 'BigInt', nullable: false },
	]) {
		it(`applies an add to an omitted ${nullable === false ? 'required ' : ''}${type ?? 'untyped'} replacement field`, async () => {
			const T = table({
				database: 'deferred_write_lifecycle',
				table: `FullAdds${type ?? 'Untyped'}${nullable === false ? 'Required' : ''}`,
				audit: true,
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n', type, nullable }, { name: 'name' }],
			});
			const replacements =
				nullable === false
					? [{ name: 'kept' }, { name: 'kept', n: undefined }, { name: 'kept', n: null }]
					: [{ name: 'kept' }];
			for (const replacement of replacements) {
				const key = id();
				await T.put({ id: key, n: type === 'BigInt' ? 5n : 5, name: 'old' });
				const record = await T.getResource({ id: key }, {});
				await record.update(replacement, true);
				await record.update({ n: { __op__: 'add', value: type === 'BigInt' ? 2n : 2 } });
				await record.save();
				const result = await T.get(key);
				assert.strictEqual(result.n, type === 'BigInt' ? 2n : 2);
				assert.strictEqual(result.name, 'kept');
				assert.strictEqual(
					[...T.auditStore.getRange({ start: 1 })].filter((entry) => entry.recordId === key).length,
					2
				);
			}
		});
	}

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
	it('does not re-admit a skipped keyed write after its owner clears it', async function () {
		if (!isLMDB) return this.skip();
		const T = table({
			database: 'deferred_write_lifecycle',
			table: 'SkippedWrite',
			audit: false,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
		});
		const key = id();
		await T.put({ id: key, n: 0 });
		const version = T.primaryStore.getEntry(key).version;
		await T.put(key, { n: 7 }, { timestamp: version + 2 });
		const context = { timestamp: version + 1 };
		const record = new T('other-record', context);
		let write;
		await transaction(context, async () => {
			await record.update(key, { n: 1 });
			let owner = context.transaction;
			while (owner && !owner.writes.some((operation) => operation?.key === key)) owner = owner.next;
			write = owner.writes.find((operation) => operation?.key === key);
		});
		assert.ok(write.skipped && write.instanceClosed && !write.saved);
		assert.strictEqual(write.writeGeneration, undefined, 'an off-key receiver has no saved-generation shortcut');
		assert.strictEqual(write.stagedIn, undefined);
		assert.strictEqual((await T.get(key)).n, 7);
		const entry = T.primaryStore.getEntry(key);
		delete context.timestamp;
		await record.save();
		assert.strictEqual((await T.get(key)).n, 7);
		assert.strictEqual(T.primaryStore.getEntry(key).version, entry.version);
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

	for (const verb of ['direct', 'keyed', 'put']) {
		it(`serializes a concurrent ${verb} update into the same pending intent`, async function () {
			const Embedded = table({
				database: 'deferred_write_lifecycle',
				table: `ConcurrentEmbedded${verb}`,
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
			const first = record.update({ name: 'first' });
			const second =
				verb === 'put'
					? record.put(key, { name: 'second' })
					: verb === 'keyed'
						? record.update(key, { name: 'second' })
						: record.update({ name: 'second' });
			await Promise.all([first, second]);
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
	}

	for (const full of [false, true]) {
		it(`fences a hook-delayed ${full ? 'replacement' : 'update'} when a checkpoint has sealed its generation`, async function () {
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
						assert.ok(original.instanceClosed, 'validated, waiting on the real blob stream');
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

	for (const mode of ['patch', 'keyed patch', 'replacement', 'restricted replacement']) {
		for (const scoped of [false, true]) {
			it(`requires successful preparation after a first failed ${mode} (${scoped ? 'explicit' : 'immediate'})`, async () => {
				const tableName = `FirstFailure${mode.replaceAll(' ', '')}${scoped}`;
				const T = table({
					database: 'deferred_write_lifecycle',
					table: tableName,
					audit: true,
					attributes: [
						{ name: 'id', isPrimaryKey: true },
						{ name: 'n' },
						{ name: 'name' },
						{ name: 'obsolete' },
						{ name: 'note' },
						{ name: 'embedding', type: 'Array', embed: { source: 'name', model: 'default' } },
					],
				});
				let calls = 0;
				T.setEmbedAttribute('embedding', async (record) => {
					calls++;
					if (record.name.startsWith('bad')) throw new Error(record.name);
					return [record.name.length];
				});
				const key = id();
				await T.put({ id: key, n: 0, name: 'base', obsolete: true });
				calls = 0;
				const version = T.primaryStore.getEntry(key).version;
				const auditCount = () =>
					[...T.auditStore.getRange({ start: 1 })].filter((entry) => entry.recordId === key).length;
				const context = {};
				const run = async () => {
					const record = await T.getResource({ id: key }, context);
					if (mode === 'restricted replacement') {
						const user = {
							role: {
								permission: {
									deferred_write_lifecycle: {
										tables: {
											[tableName]: {
												update: true,
												attribute_permissions: ['n', 'name', 'note'].map((attribute_name) => ({
													attribute_name,
													update: true,
												})),
											},
										},
									},
								},
							},
						};
						assert.strictEqual(record.allowUpdate(user, { n: 99 }, context), true);
					}
					const update = (changes, full = false) =>
						mode === 'keyed patch' ? record.update(key, changes) : record.update(changes, full);
					let failure;
					await assert.rejects(update({ n: 99, name: 'bad-one' }, mode.includes('replacement')), (error) => {
						failure = error;
						return /Failed to compute embedding/.test(error.message);
					});
					for (let retry = 0; retry < 2; retry++)
						await assert.rejects(
							async () => record.save(),
							(error) => error === failure
						);
					assert.strictEqual(calls, 1, 'bare save does not retry a failed external model call');
					assert.strictEqual((await T.get(key)).n, 0);
					assert.strictEqual(T.primaryStore.getEntry(key).version, version);
					assert.strictEqual(auditCount(), 1);
					await assert.rejects(update({ name: 'bad-two', note: 'rejected correction' }), (error) => {
						assert.notStrictEqual(error, failure);
						failure = error;
						return /Failed to compute embedding/.test(error.message);
					});
					await assert.rejects(
						async () => record.save(),
						(error) => error === failure
					);
					await update({ name: 'valid' });
					await record.save();
				};
				if (scoped) await transaction(context, run);
				else await run();
				const result = await T.get(key);
				assert.strictEqual(result.n, 99, 'correction retains the original draft');
				assert.strictEqual(result.name, 'valid');
				assert.strictEqual(result.note, undefined, 'a rejected correction restores the preceding draft');
				assert.deepStrictEqual([...result.embedding], [5]);
				assert.strictEqual(result.obsolete, mode === 'replacement' ? undefined : true);
				assert.strictEqual(calls, 3);
				assert.strictEqual(auditCount(), 2, 'only the successfully prepared intent is committed');
				if (!isLMDB) {
					const locked = await T.lock(key, { timeout: 100, lease: 5000 }, {});
					await locked.unlock();
				}
			});
		}
	}

	it('prepares queued direct and keyed successors after the first model hook fails', async () => {
		for (const keyed of [false, true]) {
			const T = table({
				database: 'deferred_write_lifecycle',
				table: `FirstQueuedFailure${keyed}`,
				audit: true,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'n' },
					{ name: 'name' },
					{ name: 'embedding', type: 'Array', embed: { source: 'name', model: 'default' } },
				],
			});
			let release;
			const gate = new Promise((resolve) => {
				release = resolve;
			});
			T.setEmbedAttribute('embedding', async (record) => {
				if (record.name === 'bad') {
					await gate;
					throw new Error('first hook failed');
				}
				return [record.name.length];
			});
			const key = id();
			const record = await T.getResource({ id: key }, {});
			const update = (changes) => (keyed ? record.update(key, changes) : record.update(changes));
			const rejected = assert.rejects(update({ n: 99, name: 'bad' }), /Failed to compute embedding/);
			const queued = update({ name: 'valid' });
			release();
			await rejected;
			await queued;
			await record.save();
			const result = await T.get(key);
			assert.strictEqual(result.n, 99, `${keyed ? 'keyed' : 'direct'} successor retains the first draft`);
			assert.deepStrictEqual([...result.embedding], [5]);
			assert.strictEqual([...T.auditStore.getRange({ start: 1 })].filter((entry) => entry.recordId === key).length, 1);
		}
	});

	it('retains a hookless first admission error until a new update succeeds', async () => {
		const key = id();
		await TestTable.put({ id: key, n: 0 });
		const version = TestTable.primaryStore.getEntry(key).version;
		const context = { signal: AbortSignal.abort() };
		const record = await TestTable.getResource({ id: key }, context);
		let failure;
		await assert.rejects(
			async () => record.update({ n: 99 }),
			(error) => {
				failure = error;
				return error.statusCode === 499;
			}
		);
		await assert.rejects(
			async () => record.save(),
			(error) => error === failure
		);
		assert.strictEqual((await TestTable.get(key)).n, 0);
		assert.strictEqual(TestTable.primaryStore.getEntry(key).version, version);
		assert.strictEqual(changesFor(key).length, 0);
		delete context.signal;
		await transaction(context, async () => {
			await record.update({ n: 1 });
			await record.save();
		});
		assert.strictEqual((await TestTable.get(key)).n, 1);
		assert.strictEqual(changesFor(key).length, 1);
	});

	it('rebuilds failed staging against the next transaction after another writer commits', async () => {
		const T = table({
			database: 'deferred_write_lifecycle',
			table: 'FirstFailureFreshBasis',
			audit: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'n' },
				{ name: 'name' },
				{ name: 'outside' },
				{ name: 'embedding', type: 'Array', embed: { source: 'name', model: 'default' } },
			],
		});
		T.setEmbedAttribute('embedding', async (record) => {
			if (record.name === 'bad') throw new Error('failed first transaction');
			return [record.name.length];
		});
		const key = id();
		await T.put({ id: key, n: 0, name: 'base', outside: 'old' });
		const context = {};
		let record;
		await transaction(context, async () => {
			record = await T.getResource({ id: key }, context);
			await assert.rejects(record.update({ n: 99, name: 'bad' }), /Failed to compute embedding/);
		});
		assert.strictEqual((await T.get(key)).n, 0, 'catching without save never admits the candidate');
		await T.patch(key, { outside: 'new' });
		await transaction(context, async () => {
			await record.update({ name: 'valid' });
			await record.save();
		});
		const result = await T.get(key);
		assert.strictEqual(result.n, 99);
		assert.strictEqual(result.name, 'valid');
		assert.strictEqual(result.outside, 'new', 'the new transaction uses the current committed basis');
		assert.deepStrictEqual([...result.embedding], [5]);
		assert.strictEqual([...T.auditStore.getRange({ start: 1 })].filter((entry) => entry.recordId === key).length, 3);
	});

	it('requires explicit update to recover a held write after failed preparation', async function () {
		if (isLMDB) return this.skip();
		const T = table({
			database: 'deferred_write_lifecycle',
			table: 'HeldFirstFailure',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name' },
				{ name: 'embedding', type: 'Array', embed: { source: 'name', model: 'default' } },
			],
		});
		let calls = 0;
		T.setEmbedAttribute('embedding', async (record) => {
			calls++;
			if (record.name === 'bad') throw new Error('failed preparation');
			return [record.name.length];
		});
		const key = id();
		await T.put({ id: key, name: 'base' });
		calls = 0;
		const record = await T.lock(key, { hold: true, lease: 30000 }, {});
		try {
			record.set('name', 'bad');
			let failure;
			await assert.rejects(
				async () => record.save(),
				(error) => {
					failure = error;
					return /Failed to compute embedding/.test(error.message);
				}
			);
			record.set('name', 'corrected');
			await assert.rejects(
				async () => record.save(),
				(error) => error === failure
			);
			assert.strictEqual((await T.get(key)).name, 'base');
			assert.strictEqual(calls, 1);
			await record.update({ name: 'corrected' });
			await record.save();
			assert.strictEqual((await T.get(key)).name, 'corrected');
			assert.deepStrictEqual([...(await T.get(key)).embedding], [9]);
			assert.strictEqual(calls, 2);
		} finally {
			await record.unlock();
		}
	});

	it('retains a synchronous model-builder rejection until a valid update clears it', async () => {
		const T = table({
			database: 'deferred_write_lifecycle',
			table: 'FirstDecideFailure',
			audit: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'n' },
				{ name: 'body', type: 'String' },
				{
					name: 'route',
					type: 'String',
					decide: { source: 'body', model: 'default', decision: 'routeDecision', schema: { enum: ['a', 'b'] } },
				},
				{ name: 'routeDecision', type: 'String' },
			],
		});
		const key = id();
		await T.put({ id: key, n: 0 });
		const version = T.primaryStore.getEntry(key).version;
		const record = await T.getResource({ id: key }, {});
		let failure;
		await assert.rejects(
			async () => record.update({ routeDecision: 'forged' }),
			(error) => {
				failure = error;
				return error.statusCode === 400;
			}
		);
		await assert.rejects(
			async () => record.save(),
			(error) => error === failure
		);
		assert.strictEqual((await T.get(key)).routeDecision, undefined);
		assert.strictEqual(T.primaryStore.getEntry(key).version, version);
		assert.strictEqual([...T.auditStore.getRange({ start: 1 })].filter((entry) => entry.recordId === key).length, 1);
		await record.update({ body: null, n: 1 });
		await record.save();
		assert.strictEqual((await T.get(key)).n, 1);
		assert.strictEqual((await T.get(key)).routeDecision, null);
	});

	it('retains a post-hook admission failure until a new update is admitted', async () => {
		let release, started;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		const entered = new Promise((resolve) => {
			started = resolve;
		});
		const T = table({
			database: 'deferred_write_lifecycle',
			table: 'FirstAdmissionFailure',
			audit: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name' },
				{ name: 'embedding', type: 'Array', embed: { source: 'name', model: 'default' } },
			],
		});
		T.setEmbedAttribute('embedding', async (record) => {
			if (record.name === 'waiting') {
				started();
				await gate;
			}
			return [record.name.length];
		});
		const key = id();
		await T.put({ id: key, name: 'base' });
		const version = T.primaryStore.getEntry(key).version;
		const controller = new AbortController();
		const context = { signal: controller.signal };
		const record = await T.getResource({ id: key }, context);
		const updating = record.update({ name: 'waiting' });
		await entered;
		controller.abort();
		let failure;
		try {
			release();
			await assert.rejects(updating, (error) => {
				failure = error;
				return error.statusCode === 499;
			});
		} finally {
			release();
		}
		await assert.rejects(
			async () => record.save(),
			(error) => error === failure
		);
		assert.strictEqual((await T.get(key)).name, 'base');
		assert.strictEqual(T.primaryStore.getEntry(key).version, version);
		assert.strictEqual([...T.auditStore.getRange({ start: 1 })].filter((entry) => entry.recordId === key).length, 1);
		delete context.signal;
		await transaction(context, async () => {
			await record.update({ name: 'valid' });
			await record.save();
		});
		assert.deepStrictEqual([...(await T.get(key)).embedding], [5]);
	});

	it('drops an array PUT element that has no instance to retry after overlap refusal', async function () {
		if (isLMDB) return this.skip();
		class Bulk extends TestTable {
			static loadAsInstance = false;
		}
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
			const collection = await Bulk.getResource(new RequestTarget('/'), context, { isCollection: true });
			await assert.rejects(collection.put(new RequestTarget('/'), [{ id: key, n: 2 }]), isOverlapRefusal);
			assert.ok(
				context.transaction.writes.every((write) => write?.key !== key || write.saved),
				'no ownerless pending element'
			);
			stream.end('payload');
			await first;
			await holder.unlock();
			const next = await TestTable.lock(key, { timeout: 100, lease: 5000 }, context);
			await next.unlock();
			assert.strictEqual((await TestTable.get(key)).n, 1);
			assert.strictEqual(changesFor(key).length, 1);
		} finally {
			stream.end();
			await first;
			await holder.unlock();
		}
	});

	for (const asynchronous of [false, true]) {
		it(`stores an array PUT element on an instance that holds a pending update (${asynchronous ? 'async' : 'sync'} model hook)`, async function () {
			const Embedded = table({
				database: 'deferred_write_lifecycle',
				table: asynchronous ? 'ArrayMergedAsyncEmbedded' : 'ArrayMergedSyncEmbedded',
				audit: true,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'n' },
					{ name: 'name' },
					{ name: 'embedding', type: 'Array', embed: { source: 'name', model: 'default' } },
				],
			});
			Embedded.setEmbedAttribute('embedding', (record) =>
				asynchronous ? Promise.resolve().then(() => [record.name.length]) : [record.name.length]
			);
			const key = id();
			await Embedded.put({ id: key, n: 0, name: 'base' });
			const record = await Embedded.getResource({ id: key }, {});
			await record.update({ n: 1 });
			await record.put(new RequestTarget('/'), [{ id: key, n: 2, name: 'array' }]);
			const result = await Embedded.get(key);
			assert.strictEqual(result.n, 2, 'the array element is saved, not left deferred behind the pending patch');
			assert.strictEqual(result.name, 'array');
			assert.deepStrictEqual([...result.embedding], [5]);
		});
	}

	it('keeps a pending update savable after an array PUT element is refused before staging', async function () {
		const key = id();
		await TestTable.put({ id: key, n: 0 });
		const record = await TestTable.getResource({ id: key }, {});
		await record.update({ n: 1 });
		await assert.rejects(
			async () => record.put(new RequestTarget('/'), [{ id: null, n: 2 }]),
			(error) => error.statusCode === 400
		);
		await record.save();
		assert.strictEqual((await TestTable.get(key)).n, 1, 'the accepted update is still saved');
	});

	for (const mode of ['denied keyed update', 'async denied keyed update', 'invalid restricted replacement']) {
		it(`releases a lazy predecessor capture after ${mode}`, async function () {
			if (isLMDB) return this.skip();
			const key = id();
			await TestTable.put({ id: key, n: 0 });
			const user = {
				role: {
					permission: {
						deferred_write_lifecycle: {
							tables: {
								Records: {
									update: mode === 'invalid restricted replacement',
									attribute_permissions: [{ attribute_name: 'name', update: true }],
								},
							},
						},
					},
				},
			};
			const context = { user };
			await transaction(context, async () => {
				class AsyncPermission extends TestTable {
					allowUpdate(user, changes, context) {
						return Promise.resolve(super.allowUpdate(user, changes, context));
					}
				}
				const T = mode === 'async denied keyed update' ? AsyncPermission : TestTable;
				const record = await T.lock(key, { lease: 30000 }, context);
				if (mode.includes('denied keyed update')) {
					const target = new RequestTarget(key);
					target.checkPermission = true;
					await assert.rejects(
						async () => record.update(target, { n: 1 }),
						(error) => error.statusCode === 403
					);
				} else {
					assert.strictEqual(record.allowUpdate(user, { name: 'allowed' }, context), true);
					await assert.rejects(
						async () => record.update([], true),
						(error) => error.statusCode === 400
					);
				}
				record.set('name', 'kept');
			});
			assert.strictEqual((await TestTable.get(key)).name, 'kept');
			assert.strictEqual((await TestTable.get(key)).n, 0);
		});
	}

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

	for (const previousFull of [false, true])
		for (const method of ['update', 'put'])
			it(`restricted ${method} retains a pending protected field (${previousFull ? 'full' : 'patch'})`, async function () {
				const key = id();
				await TestTable.put({ id: key, n: 0, obsolete: true, stale: true });
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
				await record.update({ n: 1, obsolete: false }, previousFull);
				assert.strictEqual(record.allowUpdate(user, { name: 'replacement' }, context), true);
				if (method === 'update') await record.update({ name: 'replacement' }, true);
				else await record.put(key, { name: 'replacement' });
				await record.save();
				const result = await TestTable.get(key);
				assert.strictEqual(result.name, 'replacement');
				assert.strictEqual(result.n, undefined);
				assert.strictEqual(result.obsolete, false);
				assert.strictEqual(result.stale, previousFull ? undefined : true);
				assert.strictEqual(
					[...TestTable.auditStore.getRange({ start: 1 })].filter((entry) => entry.recordId === key).length,
					2
				);
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

	it('keeps a blob another write is saving when a draft that tracked it is superseded', async () => {
		const key = id();
		const otherKey = id();
		const sentinelKey = id();
		const stream = new PassThrough();
		const shared = createBlob(stream);
		setDeletionDelay(0);
		try {
			const record = await TestTable.getResource({ id: key }, {});
			await record.update({ blob: shared, n: 1 }, true);
			const other = TestTable.put(otherKey, { blob: shared });
			try {
				await waitFor(() => getFileId(shared) != null);
				await record.update({ n: 2 }, true);
			} finally {
				stream.end(Buffer.alloc(20000, 7));
			}
			await other;
			await record.save();
			// reclamation runs in queue order, so one the superseded draft queued has run once this one has
			await TestTable.put(sentinelKey, { blob: createBlob(Buffer.alloc(20000, 1)) });
			await deleteBlobAndWait((await TestTable.get(sentinelKey)).blob);
			assert.strictEqual((await TestTable.get(key)).blob, undefined);
			assert.ok(existsSync(getFilePathForBlob(shared)), 'superseding the draft deleted a file another write committed');
			assert.strictEqual((await (await TestTable.get(otherKey)).blob.bytes()).length, 20000);
		} finally {
			setDeletionDelay(undefined);
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
