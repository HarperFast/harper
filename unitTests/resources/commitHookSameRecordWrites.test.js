const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table, resetDatabases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { setTimeout: delay } = require('node:timers/promises');
require('#src/server/serverHelpers/serverUtilities');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

const isSyncWindowRefusal = (error) =>
	error?.statusCode === 409 && /refused before the hook's first await/.test(error.message);
const isLockedChangeRefusal = (error) =>
	error?.statusCode === 409 && /can not be changed by the pre-commit hook of its own write/.test(error.message);
const isOwnHookRefusal = (error) =>
	error?.statusCode === 409 && /from its own commit's pre-commit hook is refused/.test(error.message);

describe('pre-commit hook writes to the record their own write is committing', function () {
	this.timeout(10000);
	let Hooked;
	let HookedOther;
	let nextId = 1;
	const id = () => `hook-same-${nextId++}`;
	const cleanups = [];

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		Hooked = table({
			table: 'CommitHookSameRecord',
			database: 'commit_hook_same_record',
			audit: true,
			replicate: false,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }, { name: 'b' }],
		});
		HookedOther = table({
			table: 'CommitHookSameRecordOther',
			database: 'commit_hook_same_record_other',
			audit: true,
			replicate: false,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }, { name: 'b' }],
		});
	});

	afterEach(async function () {
		delete Hooked.source;
		delete HookedOther.source;
		while (cleanups.length) await cleanups.pop()();
	});

	after(async function () {
		await resetDatabases();
	});

	function hookOnce(hook) {
		const once = (...args) => {
			delete Hooked.source;
			return hook(...args);
		};
		Hooked.source = { put: once, patch: once, delete: once, publish: once };
	}

	const outerWrites = {
		put: (recordId, context) => Hooked.put({ id: recordId, n: 2 }, context),
		patch: (recordId, context) => Hooked.patch(recordId, { n: 2 }, context),
		delete: (recordId, context) => Hooked.delete(recordId, context),
	};
	const outerOnly = { put: { n: 2 }, patch: { n: 2 }, delete: null };
	const hookWrites = {
		put: (recordId, context) => Hooked.put({ id: recordId, n: 1, b: 9 }, context),
		patch: (recordId, context) => Hooked.patch(recordId, { b: 9 }, context),
		delete: (recordId, context) => Hooked.delete(recordId, context),
	};
	const stored = (recordId) => {
		const value = Hooked.primaryStore.getEntry(recordId)?.value;
		if (value == null) return null;
		const { id: _id, ...rest } = value;
		return rest;
	};
	const scopes = {
		'inside transaction()': (write) => transaction({}, (txn) => write(txn)),
		'as a static verb on its own': (write) => write({}),
	};

	for (const [scopeName, runScope] of Object.entries(scopes))
		for (const outer of Object.keys(outerWrites))
			for (const inner of Object.keys(hookWrites)) {
				it(`a ${inner} the hook of a ${outer} makes synchronously is refused with 409 and never lands (${scopeName})`, async function () {
					const recordId = id();
					await Hooked.put({ id: recordId, n: 1 });
					let hookWrite;
					hookOnce((_id, _record, context) => {
						hookWrite = Promise.resolve(hookWrites[inner](recordId, context)).then(
							() => ({ landed: true }),
							(error) => ({ error })
						);
						return hookWrite;
					});
					await runScope((context) => outerWrites[outer](recordId, context));
					const outcome = await hookWrite;
					if (isLMDB) {
						// LMDB applies every staged write at commit, in staging order, so the hook's write follows the outer one
						assert.ifError(outcome.error);
						if (inner === 'delete') assert.strictEqual(stored(recordId), null);
						else assert.strictEqual(stored(recordId)?.b, 9);
						return;
					}
					assert.ok(isSyncWindowRefusal(outcome.error), outcome.error?.message ?? 'the hook write was not refused');
					assert.deepStrictEqual(stored(recordId), outerOnly[outer]);
				});
			}

	for (const [scopeName, runScope] of Object.entries(scopes))
		it(`a same-record write the hook makes after an await follows the outer write (${scopeName})`, async function () {
			const recordId = id();
			await Hooked.put({ id: recordId, n: 1 });
			hookOnce(async (_id, _record, context) => {
				await delay(1);
				await Hooked.patch(recordId, { b: 9 }, context);
			});
			await runScope((context) => outerWrites.patch(recordId, context));
			assert.deepStrictEqual(stored(recordId), { n: 2, b: 9 });
		});

	it("a write the hook stages synchronously but saves after an await chains on the outer write's result", async function () {
		const recordId = id();
		await Hooked.put({ id: recordId, n: 1 });
		await transaction({}, async (txn) => {
			hookOnce((_id, _record, context) => {
				const staged = new Hooked(recordId, context);
				staged.update({ b: 9 });
				return delay(1).then(() => staged.save());
			});
			await Hooked.patch(recordId, { n: 2 }, txn);
		});
		assert.deepStrictEqual(stored(recordId), { n: 2, b: 9 });
	});

	it("a nested hook's synchronous write to the outermost write's record is refused, and the middle write lands", async function () {
		if (isLMDB) return this.skip();
		const outerId = id();
		const middleId = id();
		await Hooked.put({ id: outerId, n: 1 });
		await Hooked.put({ id: middleId, n: 1 });
		let refusal;
		Hooked.source = {
			patch: (patchedId, _record, context) => {
				if (patchedId === outerId) return Hooked.patch(middleId, { n: 5 }, context);
				delete Hooked.source;
				return Promise.resolve(Hooked.patch(outerId, { b: 9 }, context)).catch((error) => {
					refusal = error;
				});
			},
		};
		await transaction({}, (txn) => Hooked.patch(outerId, { n: 2 }, txn));
		assert.ok(isSyncWindowRefusal(refusal), refusal?.message);
		assert.deepStrictEqual(stored(outerId), { n: 2 });
		assert.deepStrictEqual(stored(middleId), { n: 5 });
	});

	it("a chained database's hook is refused a synchronous write to its own write's record", async function () {
		if (isLMDB) return this.skip();
		const recordId = id();
		await HookedOther.put({ id: recordId, n: 1 });
		let refusal;
		HookedOther.source = {
			patch: (_id, _record, context) => {
				delete HookedOther.source;
				return Promise.resolve(HookedOther.patch(recordId, { b: 9 }, context)).catch((error) => {
					refusal = error;
				});
			},
		};
		await transaction({}, async (txn) => {
			await Hooked.put({ id: id(), n: 1 }, txn);
			const other = await HookedOther.update(recordId, {}, txn);
			other.set('n', 2);
		});
		assert.ok(isSyncWindowRefusal(refusal), refusal?.message);
		const { id: _id, ...stored } = HookedOther.primaryStore.getEntry(recordId).value;
		assert.deepStrictEqual(stored, { n: 2 });
	});

	// a static verb on this context runs in a transaction of its own; an instance write joins the committing one
	const hookSaves = {
		'a static verb': (recordId, context) => Hooked.put({ id: recordId, n: 1, b: 9 }, context),
		'an instance write': (recordId, context) => {
			const sameRecord = new Hooked(recordId, context);
			sameRecord.update({ b: 9 });
			return sameRecord.save();
		},
	};
	for (const [how, hookSave] of Object.entries(hookSaves))
		it(`an unlocked instance write outside transaction() refuses a same-record write from its hook (${how})`, async function () {
			if (isLMDB) return this.skip();
			const recordId = id();
			await Hooked.put({ id: recordId, n: 1 });
			const context = {};
			let refusal;
			hookOnce((_id, _record, hookContext) =>
				Promise.resolve(hookSave(recordId, hookContext)).catch((error) => {
					refusal = error;
				})
			);
			const record = new Hooked(recordId, context);
			record.update({ n: 2 });
			await record.save();
			assert.ok(isSyncWindowRefusal(refusal), refusal?.message);
			assert.deepStrictEqual(stored(recordId), { n: 2 });
		});

	describe('through a record lock', function () {
		before(function () {
			if (isLMDB) this.skip();
		});

		async function holdRecord() {
			const recordId = id();
			await Hooked.put({ id: recordId, n: 1 });
			const context = {};
			const holder = await Hooked.lock(recordId, { hold: true, lease: 5000 }, context);
			cleanups.push(() => holder.unlock());
			return { recordId, context, holder };
		}

		const changes = {
			'set()': (holder) => holder.set('n', 9),
			'update()': (holder) => holder.update({ n: 9 }),
			'patch()': (holder) => holder.patch({ n: 9 }),
			'addTo()': (holder) => holder.addTo('n', 7),
			'deleteProperty()': (holder) => holder.deleteProperty('n'),
			'an assignment': (holder) => {
				holder.n = 9;
			},
		};
		for (const [change, makeChange] of Object.entries(changes))
			for (const inTransaction of [false, true])
				it(`the hook can not change the instance whose save is committing through ${change}, and the hold stays writable (in transaction(): ${inTransaction})`, async function () {
					const { recordId, context, holder } = await holdRecord();
					let refusal;
					hookOnce(() => {
						try {
							Promise.resolve(makeChange(holder)).catch((error) => {
								refusal = error;
							});
						} catch (error) {
							refusal = error;
						}
					});
					holder.set('n', 2);
					if (inTransaction) await transaction(context, () => holder.save());
					else await holder.save();
					assert.ok(isLockedChangeRefusal(refusal), refusal?.message);
					assert.deepStrictEqual(stored(recordId), { n: 2 });
					holder.set('n', 3);
					await holder.save();
					assert.deepStrictEqual(stored(recordId), { n: 3 });
				});

		// the first two store the holder's changes object; put(id, record) clears it as it commits
		const fullWrites = {
			'put(record)': (holder, recordId) => holder.put({ id: recordId, n: 2 }),
			'update(record, true)': (holder, recordId) => {
				holder.update({ id: recordId, n: 2 }, true);
				return holder.save();
			},
			'put(id, record)': (holder, recordId) => holder.put(recordId, { id: recordId, n: 2 }),
		};
		for (const [write, makeWrite] of Object.entries(fullWrites))
			for (const [change, makeChange] of Object.entries(changes))
				for (const inTransaction of [false, true])
					it(`the hook of a full ${write} can not change the holder through ${change}, and the hold stays writable (in transaction(): ${inTransaction})`, async function () {
						const { recordId, context, holder } = await holdRecord();
						let hookRan = false;
						let refusal;
						hookOnce(() => {
							hookRan = true;
							try {
								Promise.resolve(makeChange(holder)).catch((error) => {
									refusal = error;
								});
							} catch (error) {
								refusal = error;
							}
						});
						if (inTransaction) await transaction(context, () => makeWrite(holder, recordId));
						else await makeWrite(holder, recordId);
						assert.ok(hookRan, 'premise: the full write ran its hook');
						assert.ok(isLockedChangeRefusal(refusal), refusal?.message);
						assert.deepStrictEqual(stored(recordId), { n: 2 });
						holder.set('n', 3);
						await holder.save();
						assert.deepStrictEqual(stored(recordId), { n: 3 });
					});

		for (const [write, makeWrite] of Object.entries({
			'a partial update': (holder) => {
				holder.set('n', 2);
				return holder.save();
			},
			'a full put(record)': (holder, recordId) => holder.put({ id: recordId, n: 2 }),
		}))
			it(`after an await the hook of ${write} changes the instance, its save is refused, and the change stays pending`, async function () {
				const { recordId, holder } = await holdRecord();
				let refusal;
				hookOnce(async () => {
					await delay(1);
					holder.set('n', 9);
					await Promise.resolve(holder.save()).catch((error) => {
						refusal = error;
					});
				});
				await makeWrite(holder, recordId);
				assert.ok(isOwnHookRefusal(refusal), refusal?.message);
				assert.deepStrictEqual(stored(recordId), { n: 2 });
				assert.strictEqual(holder.n, 9);
				await holder.save();
				assert.deepStrictEqual(stored(recordId), { n: 9 });
			});

		it("a hook's deferred update through its own commit's lock is refused outside transaction() and leaves nothing staged", async function () {
			const recordId = id();
			await Hooked.put({ id: recordId, n: 1 });
			const context = {};
			const holder = await Hooked.lock(recordId, { hold: true, lease: 200 }, context);
			let refusal;
			hookOnce(() => {
				try {
					holder.update(recordId, { n: 9 });
				} catch (error) {
					refusal = error;
				}
			});
			await holder.publish({ n: 7 });
			assert.ok(isOwnHookRefusal(refusal), refusal?.message);
			assert.strictEqual(context.transaction.hasPendingWriteTo(Hooked.primaryStore, recordId), false);
			await delay(300); // past the lease
			const relocked = await Hooked.lock(recordId, { timeout: 500 }, context);
			await relocked.unlock();
			assert.deepStrictEqual(stored(recordId), { n: 1 });
		});

		it('a refusal the hook catches leaves no unhandled rejection', async function () {
			const { holder } = await holdRecord();
			const unhandled = [];
			const onUnhandled = (error) => unhandled.push(error);
			process.on('unhandledRejection', onUnhandled);
			cleanups.push(() => process.off('unhandledRejection', onUnhandled));
			hookOnce(() => {
				holder.set('n', 9);
				return Promise.resolve(holder.save()).catch(() => {});
			});
			await holder.publish({ n: 7 });
			await delay(20);
			assert.deepStrictEqual(unhandled, []);
		});
	});
});
