const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
const { table, resetDatabases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { TRANSACTION_STATE } = require('#src/resources/DatabaseTransaction');
const { setTimeout: delay } = require('node:timers/promises');
require('#src/server/serverHelpers/serverUtilities');

const SKIP_ON_LMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('Record locks (QA-5082): static table verbs on locked keys must resolve transaction recordLocks for floor adoption and 409 guards', function () {
	this.timeout(10000);
	let Audited;
	let Unaudited;
	let nextId = 1;
	const id = () => `qa5082-${nextId++}`;
	const cleanups = [];

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		Audited = table({
			table: 'QA5082Audited',
			database: 'qa5082_static_lock_floor',
			audit: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'n' },
				{ name: 'updatedAt', type: 'Date', assignUpdatedTime: true },
			],
		});
		Unaudited = table({
			table: 'QA5082Unaudited',
			database: 'qa5082_static_lock_floor',
			audit: false,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'n' },
				{ name: 'updatedAt', type: 'Date', assignUpdatedTime: true },
			],
		});
	});

	afterEach(async function () {
		while (cleanups.length) await cleanups.pop()();
	});

	after(async function () {
		await resetDatabases();
	});

	describe('Keyed publishes', function () {
		for (const action of ['upgrade', 'unlock']) {
			it(`an instance publish survives a scoped lock ${action} before commit`, async function () {
				if (SKIP_ON_LMDB) return this.skip();
				const recordId = id();
				await Audited.put({ id: recordId, n: 1 });
				await transaction({}, async () => {
					const locked = await Audited.lock(recordId);
					locked.set('n', 2);
					locked.publish({ n: 7 });
					if (action === 'upgrade') {
						const holder = await Audited.lock(recordId, { hold: true, lease: 5000 });
						cleanups.push(() => holder.unlock());
					} else await locked.unlock();
				});
				assert.ok(
					[...Audited.auditStore.getRange({ start: 1 })].some(
						(entry) => entry.recordId === recordId && entry.type === 'message'
					),
					'lock cleanup must preserve the explicit publish'
				);
				assert.strictEqual((await Audited.get(recordId)).n, 1);
			});
		}

		for (const audit of [true, false]) {
			it(`an immediate holder publish advances the floor for its next save (audit: ${audit})`, async function () {
				if (SKIP_ON_LMDB) return this.skip();
				const TestTable = audit ? Audited : Unaudited;
				const recordId = id();
				await TestTable.put({ id: recordId, n: 1 });
				const context = {};
				const holder = await TestTable.lock(recordId, { hold: true, lease: 5000 }, context);
				cleanups.push(() => holder.unlock());
				const published = await holder.publish({ n: 7 });
				assert.strictEqual(published, undefined);
				const publishedVersion = TestTable.primaryStore.getEntry(recordId).version;
				holder.set('n', 2);
				await holder.save();
				assert.strictEqual((await TestTable.get(recordId)).n, 2);
				assert.ok(TestTable.primaryStore.getEntry(recordId).version > publishedVersion);
			});
		}

		for (const closeFirst of [false, true]) {
			const prefix = closeFirst ? 'save -> ' : '';
			it(`an immediate holder ${prefix}publish -> save on audit: false commits the second write`, async function () {
				if (SKIP_ON_LMDB) return this.skip();
				const recordId = id();
				await Unaudited.put({ id: recordId, n: 1 });
				const context = {};
				const holder = await Unaudited.lock(recordId, { hold: true, lease: 5000 }, context);
				cleanups.push(() => holder.unlock());
				if (closeFirst) {
					holder.set('n', 2);
					assert.strictEqual(await holder.save(), undefined);
					assert.strictEqual(context.transaction.open, TRANSACTION_STATE.CLOSED);
				}
				const beforePublishVersion = Unaudited.primaryStore.getEntry(recordId).version;
				assert.strictEqual(await holder.publish({ n: 7 }), undefined);
				const publishedVersion = Unaudited.primaryStore.getEntry(recordId).version;
				assert.ok(publishedVersion > beforePublishVersion, 'expected publish version to advance');
				const handle = context.transaction.recordLocks.get(Unaudited.primaryStore).get(recordId);
				assert.ok(handle.holderVersionFloor() > publishedVersion, 'expected publish to advance holderVersionFloor');
				holder.set('n', 3);
				const saveResult = await holder.save();
				assert.strictEqual((await Unaudited.get(recordId)).n, 3);
				assert.strictEqual(saveResult, undefined);
				assert.ok(
					Unaudited.primaryStore.getEntry(recordId).version > publishedVersion,
					'expected save version to advance past publish version'
				);
			});

			it(`an immediate holder ${prefix}invalidate -> put on audit: false commits the second write`, async function () {
				if (SKIP_ON_LMDB) return this.skip();
				const recordId = id();
				await Unaudited.put({ id: recordId, n: 1 });
				const context = {};
				const holder = await Unaudited.lock(recordId, { hold: true, lease: 5000 }, context);
				cleanups.push(() => holder.unlock());
				if (closeFirst) {
					holder.set('n', 2);
					assert.strictEqual(await holder.save(), undefined);
					assert.strictEqual(context.transaction.open, TRANSACTION_STATE.CLOSED);
				}
				assert.strictEqual(await holder.invalidate(), undefined);
				const invalidatedEntry = Unaudited.primaryStore.getEntry(recordId);
				assert.strictEqual(invalidatedEntry.value, null);
				assert.strictEqual(await new Unaudited(recordId, context).put(recordId, { id: recordId, n: 4 }), undefined);
				assert.strictEqual(Unaudited.primaryStore.getEntry(recordId).value?.n, 4);
				assert.strictEqual((await Unaudited.get(recordId)).n, 4);
				assert.ok(
					Unaudited.primaryStore.getEntry(recordId).version > invalidatedEntry.version,
					'expected put version to advance past invalidate version'
				);
			});

			it(`an immediate holder ${prefix}delete -> put on audit: false commits the second write`, async function () {
				if (SKIP_ON_LMDB) return this.skip();
				const recordId = id();
				await Unaudited.put({ id: recordId, n: 1 });
				const context = {};
				const holder = await Unaudited.lock(recordId, { hold: true, lease: 5000 }, context);
				cleanups.push(() => holder.unlock());
				if (closeFirst) {
					holder.set('n', 2);
					assert.strictEqual(await holder.save(), undefined);
					assert.strictEqual(context.transaction.open, TRANSACTION_STATE.CLOSED);
				}
				const handle = context.transaction.recordLocks.get(Unaudited.primaryStore).get(recordId);
				const deleteFloor = handle.holderVersionFloor();
				assert.strictEqual(await holder.delete(), true);
				assert.strictEqual(Unaudited.primaryStore.getEntry(recordId), undefined);
				assert.ok(handle.holderVersionFloor() > deleteFloor, 'expected delete to advance holderVersionFloor');
				assert.strictEqual(await new Unaudited(recordId, context).put(recordId, { id: recordId, n: 5 }), undefined);
				assert.strictEqual(Unaudited.primaryStore.getEntry(recordId)?.value?.n, 5);
				assert.strictEqual((await Unaudited.get(recordId)).n, 5);
				assert.ok(
					Unaudited.primaryStore.getEntry(recordId).version > deleteFloor,
					'expected put version to advance past delete version'
				);
			});

			it(`an immediate holder ${prefix}relocate -> put on audit: false commits the second write`, async function () {
				if (SKIP_ON_LMDB) return this.skip();
				const recordId = id();
				await Unaudited.put({ id: recordId, n: 1 });
				const context = {};
				const holder = await Unaudited.lock(recordId, { hold: true, lease: 5000 }, context);
				cleanups.push(() => holder.unlock());
				if (closeFirst) {
					holder.set('n', 2);
					assert.strictEqual(await holder.save(), undefined);
					assert.strictEqual(context.transaction.open, TRANSACTION_STATE.CLOSED);
				}
				const beforeRelocateVersion = Unaudited.primaryStore.getEntry(recordId).version;
				assert.strictEqual(await holder._writeRelocate(recordId, {}), undefined);
				const relocatedVersion = Unaudited.primaryStore.getEntry(recordId).version;
				assert.ok(relocatedVersion > beforeRelocateVersion, 'expected relocate version to advance');
				assert.strictEqual(await new Unaudited(recordId, context).put(recordId, { id: recordId, n: 6 }), undefined);
				assert.strictEqual(Unaudited.primaryStore.getEntry(recordId)?.value?.n, 6);
				assert.strictEqual((await Unaudited.get(recordId)).n, 6);
				assert.ok(
					Unaudited.primaryStore.getEntry(recordId).version > relocatedVersion,
					'expected put version to advance past relocate version'
				);
			});
		}

		it('awaits a second immediate holder write that enters save() while isCommitting is true', async function () {
			if (SKIP_ON_LMDB) return this.skip();
			const firstId = id();
			const secondId = id();
			await Unaudited.put({ id: firstId, n: 1 });
			await Unaudited.put({ id: secondId, n: 10 });
			const context = {};
			const holder1 = await Unaudited.lock(firstId, { hold: true, lease: 5000 }, context);
			cleanups.push(() => holder1.unlock());
			const holder2 = await Unaudited.lock(secondId, { hold: true, lease: 5000 }, context);
			cleanups.push(() => holder2.unlock());
			holder1.set('n', 2);
			await holder1.save();
			assert.strictEqual(context.transaction.open, TRANSACTION_STATE.CLOSED);
			const { Transaction } = require('../rocksdbBindings.mts').rocksdbBindings();
			const originalCommit = Transaction.prototype.commit;
			const targetDb = Unaudited.primaryStore.store.db;
			let releaseFirst;
			const firstGate = new Promise((resolve) => {
				releaseFirst = resolve;
			});
			let commitCalls = 0;
			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db !== targetDb) return originalCommit.apply(this, args);
				commitCalls++;
				if (commitCalls === 1) await firstGate;
				else await delay(15);
				return originalCommit.apply(this, args);
			};
			cleanups.push(() => {
				Transaction.prototype.commit = originalCommit;
				releaseFirst?.();
			});
			const firstCommit = holder1.publish({ n: 7 });
			assert.strictEqual(context.transaction.isCommitting, true);
			const holder2FloorBefore = context.transaction.recordLocks
				.get(Unaudited.primaryStore)
				.get(secondId)
				.holderVersionFloor();
			assert.strictEqual(await holder2.publish({ n: 8 }), undefined);
			assert.ok(
				context.transaction.recordLocks.get(Unaudited.primaryStore).get(secondId).holderVersionFloor() >
					holder2FloorBefore,
				'expected forwarded publish to settle only after advancing holderVersionFloor'
			);
			assert.strictEqual(context.transaction.isCommitting, true);
			holder2.set('n', 20);
			assert.strictEqual(await holder2.save(), undefined);
			assert.strictEqual(Unaudited.primaryStore.getEntry(secondId).value.n, 20);
			releaseFirst();
			Transaction.prototype.commit = originalCommit;
			await firstCommit;
			assert.strictEqual((await Unaudited.get(secondId)).n, 20);
		});

		it('awaits a second immediate holder write that joins an OPEN link parked in completions', async function () {
			if (SKIP_ON_LMDB) return this.skip();
			const firstId = id();
			const secondId = id();
			await Unaudited.put({ id: firstId, n: 1 });
			await Unaudited.put({ id: secondId, n: 10 });
			const context = {};
			const holder1 = await Unaudited.lock(firstId, { hold: true, lease: 5000 }, context);
			cleanups.push(() => holder1.unlock());
			const holder2 = await Unaudited.lock(secondId, { hold: true, lease: 5000 }, context);
			cleanups.push(() => holder2.unlock());
			let releaseHook;
			const hookGate = new Promise((resolve) => {
				releaseHook = resolve;
			});
			Unaudited.source = { publish: () => hookGate };
			cleanups.push(() => {
				delete Unaudited.source;
				releaseHook?.();
			});
			const firstCommit = holder1.publish({ n: 7 });
			delete Unaudited.source;
			assert.strictEqual(context.transaction.open, TRANSACTION_STATE.OPEN);
			assert.strictEqual(context.transaction.isCommitting, true);
			let secondSettled = false;
			const secondCommit = Promise.resolve(holder2.publish({ n: 8 })).then((res) => {
				secondSettled = true;
				return res;
			});
			await delay(10);
			assert.strictEqual(secondSettled, false, 'forwarded write on OPEN link must wait for shared commit');
			releaseHook();
			const [, secondRes] = await Promise.all([firstCommit, secondCommit]);
			assert.strictEqual(secondRes, undefined);
			holder2.set('n', 20);
			assert.strictEqual(await holder2.save(), undefined);
			assert.strictEqual((await Unaudited.get(secondId)).n, 20);
		});

		it('clears isCommitting when an innerCommit on a closed ImmediateTransaction rejects', async function () {
			if (SKIP_ON_LMDB) return this.skip();
			const firstId = id();
			const secondId = id();
			await Unaudited.put({ id: firstId, n: 1 });
			await Unaudited.put({ id: secondId, n: 10 });
			const context = {};
			const holder1 = await Unaudited.lock(firstId, { hold: true, lease: 5000 }, context);
			cleanups.push(() => holder1.unlock());
			const holder2 = await Unaudited.lock(secondId, { hold: true, lease: 5000 }, context);
			cleanups.push(() => holder2.unlock());
			holder1.set('n', 2);
			await holder1.save();
			assert.strictEqual(context.transaction.open, TRANSACTION_STATE.CLOSED);
			const unhandled = [];
			const onUnhandled = (err) => unhandled.push(err);
			process.on('unhandledRejection', onUnhandled);
			const { setAbortMarkersForTests } = require('#src/resources/transactionLogAbortMarkers');
			const priorAbortMarkers = setAbortMarkersForTests(false);
			const { Transaction } = require('../rocksdbBindings.mts').rocksdbBindings();
			const originalCommit = Transaction.prototype.commit;
			const targetDb = Unaudited.primaryStore.store.db;
			let failNext = true;
			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db === targetDb && failNext) {
					failNext = false;
					throw Object.assign(new Error('forced conflict'), { code: 'ERR_BUSY' });
				}
				return originalCommit.apply(this, args);
			};
			context.transaction.commitStartedAt = performance.now() - 3600000;
			try {
				await assert.rejects(
					() => holder1.invalidate(),
					(err) => err.statusCode === 503 && /in conflict with ongoing writes/.test(err.message)
				);
			} finally {
				Transaction.prototype.commit = originalCommit;
				setAbortMarkersForTests(priorAbortMarkers ?? true);
				context.transaction.commitStartedAt = undefined;
				await delay(20);
				process.removeListener('unhandledRejection', onUnhandled);
			}
			assert.deepStrictEqual(unhandled, []);
			assert.strictEqual(context.transaction.isCommitting, false);
			holder2.set('n', 20);
			await holder2.save();
			assert.strictEqual((await Unaudited.get(secondId)).n, 20);
		});

		for (const route of ['static', 'holder']) {
			it(`${route} publish under a held lock binds the handle and delivers its message`, async function () {
				if (SKIP_ON_LMDB) return this.skip();
				const recordId = id();
				await Audited.put({ id: recordId, n: 1 });
				const events = [];
				const subscription = await Audited.subscribe({ id: recordId, listener: (event) => events.push(event) });
				cleanups.push(() => subscription.end());
				const context = {};
				await transaction(context, async () => {
					const holder = await Audited.lock(recordId, { hold: true, lease: 5000 });
					cleanups.push(() => holder.unlock());
					const handle = context.transaction.recordLockFor(Audited.primaryStore, recordId);
					if (route === 'static') await Audited.publish(recordId, { n: 7 });
					else holder.publish({ n: 7 });
					const write = context.transaction.writes.filter((write) => write?.key === recordId).at(-1);
					assert.ok(write.lockHandle === handle, 'keyed publish must bind the held lock handle');
					assert.strictEqual(context.transaction.hasUnlockedWrite(), false);
				});
				await waitFor(() => events.some((event) => event.value?.n === 7));
				assert.strictEqual((await Audited.get(recordId)).n, 1);
			});

			it(`${route} publish staged before lease revocation is rejected at commit`, async function () {
				if (SKIP_ON_LMDB) return this.skip();
				const recordId = id();
				await Audited.put({ id: recordId, n: 1 });
				const context = {};
				await assert.rejects(
					() =>
						transaction(context, async () => {
							const holder = await Audited.lock(recordId, { hold: true, lease: 5000 });
							cleanups.push(() => holder.unlock());
							if (route === 'static') await Audited.publish(recordId, { n: 7 });
							else holder.publish({ n: 7 });
							context.transaction.recordLockFor(Audited.primaryStore, recordId).revokeLease();
						}),
					{ statusCode: 409 }
				);
				assert.ok(
					![...Audited.auditStore.getRange({ start: 1 })].some(
						(entry) => entry.recordId === recordId && entry.type === 'message'
					)
				);
			});
		}

		it('rejects a stale holder before staging a publish', async function () {
			if (SKIP_ON_LMDB) return this.skip();
			const recordId = id();
			await Audited.put({ id: recordId, n: 1 });
			const context = {};
			await transaction(context, async () => {
				const holder = await Audited.lock(recordId, { hold: true, lease: 5000 });
				cleanups.push(() => holder.unlock());
				context.transaction.recordLockFor(Audited.primaryStore, recordId).revokeLease();
				const before = context.transaction.writes.length;
				assert.throws(() => holder.publish({ n: 7 }), { statusCode: 409 });
				assert.strictEqual(context.transaction.writes.length, before);
			});
		});

		it('a scoped keyed publish allows a later lock to adopt its record floor', async function () {
			if (SKIP_ON_LMDB) return this.skip();
			const firstId = id();
			const secondId = id();
			const futureStamp = Date.now() + 2500;
			await Audited.put({ id: firstId, n: 1 });
			await transaction({ timestamp: futureStamp }, () => Audited.put({ id: secondId, n: 2 }));
			await transaction({}, async () => {
				await Audited.lock(firstId);
				await Audited.publish(firstId, { n: 7 });
				const second = await Audited.lock(secondId);
				second.set('n', 3);
				await second.save();
			});
			assert.strictEqual((await Audited.get(secondId)).n, 3);
			assert.ok(Audited.primaryStore.getEntry(secondId).version > futureStamp);
		});

		for (const rootId of [null, undefined]) {
			it(`a root-topic publish with ${rootId} id stays unbound while a record lock is held`, async function () {
				if (SKIP_ON_LMDB) return this.skip();
				const context = {};
				await transaction(context, async () => {
					const holder = await Audited.lock(id(), { hold: true, lease: 5000 });
					cleanups.push(() => holder.unlock());
					await Audited.publish(rootId, { n: 7 });
					const write = context.transaction.writes.filter(Boolean).at(-1);
					assert.strictEqual(write.key, null);
					assert.strictEqual(write.lockHandle, undefined);
					assert.strictEqual(context.transaction.hasUnlockedWrite(), true);
				});
			});
		}

		it('an unlocked saved update instance can still publish', async function () {
			const recordId = id();
			await Audited.put({ id: recordId, n: 1 });
			const context = {};
			await transaction(context, async () => {
				const updated = await Audited.update(recordId, { n: 2 });
				await updated.save();
				updated.publish({ n: 7 });
			});
			assert.ok(
				[...Audited.auditStore.getRange({ start: 1 })].some(
					(entry) => entry.recordId === recordId && entry.type === 'message'
				)
			);
			assert.strictEqual((await Audited.get(recordId)).n, 2);
		});
	});

	describe('Positive Controls', function () {
		it('Positive Control 1: LMDB 501 lock contract and RocksDB multi-lock floor adoption before save()', async function () {
			if (SKIP_ON_LMDB) {
				const context = {};
				await assert.rejects(
					() => transaction(context, () => Audited.lock(id())),
					(err) =>
						Boolean(
							err &&
							err.statusCode === 501 &&
							/Record locks (are not supported on LMDB|require the rocksdb storage engine)/i.test(err.message)
						),
					'LMDB must reject Table.lock() with HTTP 501'
				);
				return;
			}

			const idA = id();
			const idB = id();
			const futureStamp = Date.now() + 2500;
			await Audited.put({ id: idA, n: 1 });
			await transaction({ timestamp: futureStamp }, () => Audited.put({ id: idB, n: 2 }));

			const context = {};
			await transaction(context, async () => {
				const a = await Audited.lock(idA);
				const b = await Audited.lock(idB);
				assert.ok(
					context.transaction.timestamp >= futureStamp,
					`Expected transaction clock (${context.transaction.timestamp}) >= futureStamp (${futureStamp})`
				);
				a.set('n', 10);
				await a.save();
				b.set('n', 20);
				await b.save();
			});

			const afterA = await Audited.get(idA);
			const afterB = await Audited.get(idB);
			assert.strictEqual(afterA.n, 10);
			assert.strictEqual(afterB.n, 20);
			assert.ok(
				Audited.primaryStore.getEntry(idB).version > futureStamp,
				'Expected committed version to advance above futureStamp'
			);
			assert.ok(afterB.updatedAt.getTime() >= futureStamp, 'Expected updatedAt to be at or above futureStamp');
		});

		it('Positive Control 2: { hold: true } instance save() after fixed clock rejects with 409, and genuinely unlocked write sets hasUnlockedWrite()=true (record-locks.md §10 1b)', async function () {
			if (SKIP_ON_LMDB) return this.skip();

			const idA = id();
			const idB = id();
			const unlockedId = id();
			const futureStamp = Date.now() + 2500;
			await Audited.put({ id: idA, n: 1 });
			await Audited.put({ id: unlockedId, n: 1 });
			await transaction({ timestamp: futureStamp }, () => Audited.put({ id: idB, n: 2 }));

			const context = {};
			await assert.rejects(
				() =>
					transaction(context, async () => {
						const a = await Audited.lock(idA);
						a.set('n', 10);
						await a.save();
						const b = await Audited.lock(idB, { hold: true, lease: 5000 });
						cleanups.push(() => b.unlock());
						b.set('n', 20);
						await b.save();
					}),
				(err) =>
					Boolean(
						err &&
						err.statusCode === 409 &&
						/cannot advance past its earlier holder version in a transaction whose clock is already fixed/i.test(
							err.message
						)
					),
				'Expected { hold: true } instance save after fixed clock to reject with 409 Conflict'
			);
			assert.strictEqual((await Audited.get(idB)).n, 2);

			const unlockedCtx = {};
			await transaction(unlockedCtx, async () => {
				await Audited.update(unlockedId, { n: 5 });
				assert.strictEqual(unlockedCtx.transaction.hasUnlockedWrite(), true);
			});
		});
	});

	describe('Arm 1: static Table.update / Table.patch on a locked key must not set hasUnlockedWrite()=true and poison subsequent Table.lock(idB) floor adoption', function () {
		it('Arm 1a (audit: true): Table.lock(idA) -> static Table.update(idA) -> Table.lock(idB) -> b.save() and b.delete() must adopt idB floor and persist', async function () {
			if (SKIP_ON_LMDB) return this.skip();

			const idA1 = id();
			const idB1 = id();
			const idA2 = id();
			const idB2 = id();
			const futureStamp = Date.now() + 2500;
			await Audited.put({ id: idA1, n: 1 });
			await Audited.put({ id: idA2, n: 1 });
			await transaction({ timestamp: futureStamp }, async () => {
				await Audited.put({ id: idB1, n: 2 });
				await Audited.put({ id: idB2, n: 2 });
			});

			const saveCtx = {};
			let hasUnlockedAfterSaveUpdate;
			await transaction(saveCtx, async () => {
				await Audited.lock(idA1);
				await Audited.update(idA1, { n: 10 });
				hasUnlockedAfterSaveUpdate = saveCtx.transaction.hasUnlockedWrite();
				const b = await Audited.lock(idB1);
				b.set('n', 20);
				await b.save();
			});

			const deleteCtx = {};
			let hasUnlockedAfterPatch;
			await transaction(deleteCtx, async () => {
				await Audited.lock(idA2);
				await Audited.patch(idA2, { n: 11 });
				hasUnlockedAfterPatch = deleteCtx.transaction.hasUnlockedWrite();
				const b = await Audited.lock(idB2);
				await b.delete();
			});

			const afterA1 = await Audited.get(idA1);
			const afterB1 = await Audited.get(idB1);
			const afterA2 = await Audited.get(idA2);
			const afterB2 = await Audited.get(idB2);

			assert.strictEqual(afterA1.n, 10);
			assert.strictEqual(afterA2.n, 11);
			assert.strictEqual(
				afterB1.n,
				20,
				`Second lock b.save() was silently lost on audit:true table because static Audited.update(idA1) set hasUnlockedWrite()=${hasUnlockedAfterSaveUpdate} (idB1.n=${afterB1.n}, updatedAt=${afterB1.updatedAt?.getTime()}, futureStamp=${futureStamp})`
			);
			assert.strictEqual(
				afterB2 ?? undefined,
				undefined,
				`Second lock b.delete() was silently lost on audit:true table because static Audited.patch(idA2) set hasUnlockedWrite()=${hasUnlockedAfterPatch}`
			);
			assert.strictEqual(
				hasUnlockedAfterSaveUpdate,
				false,
				'Static Audited.update(idA1) on an already-locked key must not be classified as an unlocked write'
			);
			assert.strictEqual(
				hasUnlockedAfterPatch,
				false,
				'Static Audited.patch(idA2) on an already-locked key must not be classified as an unlocked write'
			);
		});

		it('Arm 1b (audit: false): Table.lock(idA) -> static Table.update(idA) -> Table.lock(idB) -> b.save() on audit:false table must adopt idB floor and persist', async function () {
			if (SKIP_ON_LMDB) return this.skip();

			const idA = id();
			const idB = id();
			const futureStamp = Date.now() + 2500;
			await Unaudited.put({ id: idA, n: 1 });
			await transaction({ timestamp: futureStamp }, () => Unaudited.put({ id: idB, n: 2 }));

			const context = {};
			let hasUnlockedAfterStaticUpdate;
			await transaction(context, async () => {
				await Unaudited.lock(idA);
				await Unaudited.update(idA, { n: 10 });
				hasUnlockedAfterStaticUpdate = context.transaction.hasUnlockedWrite();
				const b = await Unaudited.lock(idB);
				b.set('n', 20);
				await b.save();
			});

			const afterA = await Unaudited.get(idA);
			const afterB = await Unaudited.get(idB);
			assert.strictEqual(afterA.n, 10);
			assert.strictEqual(
				afterB.n,
				20,
				`Second lock b.save() was silently lost on audit:false table because static Unaudited.update(idA) set hasUnlockedWrite()=${hasUnlockedAfterStaticUpdate} (idB.n=${afterB.n}, updatedAt=${afterB.updatedAt?.getTime()}, futureStamp=${futureStamp})`
			);
			assert.strictEqual(
				hasUnlockedAfterStaticUpdate,
				false,
				'Static Unaudited.update(idA) on an already-locked key must not be classified as an unlocked write'
			);
		});
	});

	describe('Arm 2: static Table.put / Table.delete / Table.update on a { hold: true } locked key after fixed clock must enforce the 409 Conflict guard', function () {
		it('Arm 2a: static Table.put(idB) and Table.delete(idB) on a { hold: true } locked key after fixed clock must reject with 409 Conflict, never silently drop', async function () {
			if (SKIP_ON_LMDB) return this.skip();

			const idA1 = id();
			const idB1 = id();
			const idA2 = id();
			const idB2 = id();
			const futureStamp = Date.now() + 2500;
			await Audited.put({ id: idA1, n: 1 });
			await Audited.put({ id: idA2, n: 1 });
			await transaction({ timestamp: futureStamp }, async () => {
				await Audited.put({ id: idB1, n: 2 });
				await Audited.put({ id: idB2, n: 2 });
			});

			let putError;
			try {
				await transaction({}, async () => {
					const a = await Audited.lock(idA1);
					a.set('n', 10);
					await a.save();
					const holderB1 = await Audited.lock(idB1, { hold: true, lease: 5000 });
					cleanups.push(() => holderB1.unlock());
					await Audited.put({ id: idB1, n: 20 });
				});
			} catch (err) {
				putError = err;
			}

			let deleteError;
			try {
				await transaction({}, async () => {
					const a = await Audited.lock(idA2);
					a.set('n', 10);
					await a.save();
					const holderB2 = await Audited.lock(idB2, { hold: true, lease: 5000 });
					cleanups.push(() => holderB2.unlock());
					await Audited.delete(idB2);
				});
			} catch (err) {
				deleteError = err;
			}

			assert.ok(
				putError &&
					putError.statusCode === 409 &&
					/cannot advance past its earlier holder version in a transaction whose clock is already fixed/i.test(
						putError.message
					),
				`Expected static Audited.put(idB1) on { hold: true } locked key after fixed clock to reject with 409 Conflict, but got error=${putError?.statusCode ?? 'none'} (stored idB1.n=${(await Audited.get(idB1))?.n})`
			);
			assert.ok(
				deleteError &&
					deleteError.statusCode === 409 &&
					/cannot advance past its earlier holder version in a transaction whose clock is already fixed/i.test(
						deleteError.message
					),
				`Expected static Audited.delete(idB2) on { hold: true } locked key after fixed clock to reject with 409 Conflict, but got error=${deleteError?.statusCode ?? 'none'} (stored idB2=${JSON.stringify(await Audited.get(idB2))})`
			);
		});

		it('Arm 2b: deferred static Table.update(idB) on a { hold: true } locked key swept at commit after fixed clock must reject with 409 Conflict', async function () {
			if (SKIP_ON_LMDB) return this.skip();

			const idA = id();
			const idB = id();
			const futureStamp = Date.now() + 2500;
			await Audited.put({ id: idA, n: 1 });
			await transaction({ timestamp: futureStamp }, () => Audited.put({ id: idB, n: 2 }));

			let updateError;
			try {
				await transaction({}, async () => {
					const a = await Audited.lock(idA);
					a.set('n', 10);
					await a.save();
					const holderB = await Audited.lock(idB, { hold: true, lease: 5000 });
					cleanups.push(() => holderB.unlock());
					await Audited.update(idB, { n: 20 });
				});
			} catch (err) {
				updateError = err;
			}

			assert.ok(
				updateError &&
					updateError.statusCode === 409 &&
					/cannot advance past its earlier holder version in a transaction whose clock is already fixed/i.test(
						updateError.message
					),
				`Expected deferred static Audited.update(idB) on { hold: true } locked key after fixed clock to reject with 409 Conflict at commit sweep, but got error=${updateError?.statusCode ?? 'none'} (stored idB.n=${(await Audited.get(idB))?.n})`
			);
		});
	});

	describe('Arm 3: static table verbs on { hold: true } locked keys must stamp from holderVersionCandidate() / holderVersionFloor() when the clock can advance', function () {
		it('Arm 3a: TableResource.put, TableResource.patch, and TableResource.delete on an ImmediateTransaction context holding { hold: true } lock must stamp above holderVersionCandidate()', async function () {
			if (SKIP_ON_LMDB) return this.skip();

			const idPut = id();
			const idDelete = id();
			const futureStamp = Date.now() + 2500;
			await Audited.put({ id: idPut, n: 1 });
			await Audited.put({ id: idDelete, n: 1 });

			const immPutCtx = { timestamp: futureStamp };
			const holderPut = await Audited.lock(idPut, { hold: true, lease: 5000 }, immPutCtx);
			cleanups.push(() => holderPut.unlock());
			delete immPutCtx.timestamp;
			holderPut.set('n', 10);
			await holderPut.save();
			await new Audited(idPut, immPutCtx).put(idPut, { id: idPut, n: 20 });
			await new Audited(idPut, immPutCtx).patch(idPut, { n: 21 });

			const immDelCtx = { timestamp: futureStamp };
			const holderDel = await Audited.lock(idDelete, { hold: true, lease: 5000 }, immDelCtx);
			cleanups.push(() => holderDel.unlock());
			delete immDelCtx.timestamp;
			holderDel.set('n', 10);
			await holderDel.save();
			await new Audited(idDelete, immDelCtx).delete(idDelete);

			const afterPut = await Audited.get(idPut);
			const afterDel = await Audited.get(idDelete);
			assert.strictEqual(
				afterPut.n,
				21,
				`TableResource.put / TableResource.patch on ImmediateTransaction { hold: true } context bypassed holderVersionCandidate() and was silently dropped (stored idPut.n=${afterPut.n}, updatedAt=${afterPut.updatedAt?.getTime()}, futureStamp=${futureStamp})`
			);
			assert.ok(
				Audited.primaryStore.getEntry(idPut).version > futureStamp,
				'Expected write under { hold: true } on ImmediateTransaction to commit above futureStamp'
			);
			assert.strictEqual(
				afterDel ?? undefined,
				undefined,
				`TableResource.delete on ImmediateTransaction { hold: true } context bypassed holderVersionCandidate() and was silently dropped (stored idDelete=${JSON.stringify(afterDel)})`
			);
		});

		it('Arm 3b: static Table.put, Table.patch, and Table.delete on { hold: true } locked keys in an open explicit transaction with an unfixed clock must adopt holderVersionFloor()', async function () {
			if (SKIP_ON_LMDB) return this.skip();

			const idB = id();
			const idDel = id();
			const futureStamp = Date.now() + 2500;
			await Audited.put({ id: idB, n: 1 });
			await Audited.put({ id: idDel, n: 1 });

			const context = {};
			await transaction(context, async (txn) => {
				const holderB = await Audited.lock(idB, { hold: true, lease: 5000 });
				const holderDel = await Audited.lock(idDel, { hold: true, lease: 5000 });
				cleanups.push(() => holderB.unlock());
				cleanups.push(() => holderDel.unlock());
				context.transaction.timestamp = futureStamp;
				holderB.set('n', 10);
				await holderB.save();
				holderDel.set('n', 10);
				await holderDel.save();
				await txn.commit();

				await Audited.put({ id: idB, n: 20 });
				await Audited.patch(idB, { n: 30 });
				await Audited.delete(idDel);
			});

			const afterB = await Audited.get(idB);
			const afterDel = await Audited.get(idDel);
			assert.strictEqual(
				afterB.n,
				30,
				`Static Audited.put / Audited.patch on { hold: true } locked key after mid-scope commit failed to adopt holderVersionFloor() and was silently dropped (idB.n=${afterB.n}, version=${Audited.primaryStore.getEntry(idB)?.version}, futureStamp=${futureStamp})`
			);
			assert.ok(
				Audited.primaryStore.getEntry(idB).version > futureStamp,
				'Expected batch-2 static Audited.put / Audited.patch to adopt holderVersionFloor() above futureStamp'
			);
			assert.strictEqual(
				afterDel ?? undefined,
				undefined,
				`Static Audited.delete on { hold: true } locked key after mid-scope commit failed to adopt holderVersionFloor() and was silently dropped (stored idDel=${JSON.stringify(afterDel)})`
			);
		});
	});

	describe('Joined-write lifecycle: a write on a locked key from another instance follows the lock until commit, unlock or upgrade', function () {
		it('a static update staged under a scoped lock survives a { hold: true } upgrade and lands at commit', async function () {
			if (SKIP_ON_LMDB) return this.skip();
			const recordId = id();
			await Audited.put({ id: recordId, n: 1 });
			let holder;
			await transaction({}, async () => {
				await Audited.lock(recordId);
				await Audited.update(recordId, { n: 2 });
				holder = await Audited.lock(recordId, { hold: true, lease: 5000 });
				cleanups.push(() => holder.unlock());
			});
			assert.strictEqual((await Audited.get(recordId)).n, 2);
		});

		it('a static update staged under a scoped lock that is unlocked before commit lands as an ordinary write', async function () {
			if (SKIP_ON_LMDB) return this.skip();
			const recordId = id();
			await Audited.put({ id: recordId, n: 1 });
			const context = {};
			await transaction(context, async () => {
				const locked = await Audited.lock(recordId);
				await Audited.update(recordId, { n: 2 });
				assert.strictEqual(context.transaction.hasUnlockedWrite(), false);
				await locked.unlock();
				assert.strictEqual(context.transaction.hasUnlockedWrite(), true);
			});
			assert.strictEqual((await Audited.get(recordId)).n, 2);
		});

		it('a deferred update staged before lock({ hold: true }) on the same key refuses the lock and stays an ordinary write', async function () {
			if (SKIP_ON_LMDB) return this.skip();
			const recordId = id();
			await Audited.put({ id: recordId, n: 1 });
			const context = {};
			await transaction(context, async () => {
				await Audited.update(recordId, { n: 2 });
				await assert.rejects(
					() => Audited.lock(recordId, { hold: true, lease: 5000 }),
					(err) => err?.statusCode === 409
				);
				assert.strictEqual(context.transaction.hasUnlockedWrite(), true);
			});
			assert.strictEqual((await Audited.get(recordId)).n, 2);
		});

		it('a static update staged under a held lock whose lease lapses before commit is refused with 409', async function () {
			if (SKIP_ON_LMDB) return this.skip();
			const recordId = id();
			await Audited.put({ id: recordId, n: 1 });
			await assert.rejects(
				() =>
					transaction({}, async () => {
						// a hold stages nothing of its own, so only the static write can carry the lapsed lease
						await Audited.lock(recordId, { hold: true, lease: 1000 });
						await Audited.update(recordId, { n: 2 });
						await delay(1200);
					}),
				{ statusCode: 409 }
			);
			assert.strictEqual((await Audited.get(recordId)).n, 1);
		});

		it("a static put staged after a held lock's lease lapsed is refused with 409", async function () {
			if (SKIP_ON_LMDB) return this.skip();
			const recordId = id();
			await Audited.put({ id: recordId, n: 1 });
			await assert.rejects(
				() =>
					transaction({}, async () => {
						await Audited.lock(recordId, { hold: true, lease: 1000 });
						await delay(1200);
						await Audited.put({ id: recordId, n: 2 });
					}),
				{ statusCode: 409 }
			);
			assert.strictEqual((await Audited.get(recordId)).n, 1);
		});

		describe('across a model hook', function () {
			let Embedded;
			let releaseEmbed;
			let embedEntered;
			let gate;
			const nextHook = () => {
				gate = new Promise((resolve) => (releaseEmbed = resolve));
				return new Promise((resolve) => (embedEntered = resolve));
			};

			before(function () {
				if (SKIP_ON_LMDB) return;
				Embedded = table({
					table: 'QA5082Embedded',
					database: 'qa5082_static_lock_floor',
					attributes: [
						{ name: 'id', isPrimaryKey: true },
						{ name: 'name' },
						{ name: 'vector', type: 'Array', embed: { source: 'name', model: 'unused' } },
					],
				});
				Embedded.setEmbedAttribute('vector', async () => {
					const wait = gate;
					gate = undefined;
					if (wait) {
						embedEntered();
						await wait;
					}
					return [1, 2, 3];
				});
			});

			it('a static update whose hook is still running when the key is locked takes the lock', async function () {
				if (SKIP_ON_LMDB) return this.skip();
				const idA = id();
				const idB = id();
				const futureStamp = Date.now() + 2500;
				await Embedded.put({ id: idA, name: 'a' });
				await transaction({ timestamp: futureStamp }, () => Embedded.put({ id: idB, name: 'b' }));
				let error;
				try {
					await transaction({}, async () => {
						const a = await Embedded.lock(idA);
						a.set('name', 'a2');
						await a.save();
						const hookEntered = nextHook();
						const pending = Embedded.update(idB, { name: 'b2' });
						await hookEntered;
						const holder = await Embedded.lock(idB, { hold: true, lease: 5000 });
						cleanups.push(() => holder.unlock());
						releaseEmbed();
						await pending;
					});
				} catch (err) {
					error = err;
				}
				assert.strictEqual(error?.statusCode, 409, `expected 409, got ${error?.statusCode ?? 'none'}`);
				assert.strictEqual((await Embedded.get(idB)).name, 'b');
			});

			it('a static update keeps a lease that lapsed and was pruned while its hook ran, and is refused', async function () {
				if (SKIP_ON_LMDB) return this.skip();
				const recordId = id();
				await Embedded.put({ id: recordId, name: 'a' });
				let other;
				let error;
				try {
					await transaction({}, async () => {
						await Embedded.lock(recordId, { hold: true, lease: 1000 });
						const hookEntered = nextHook();
						const pending = Embedded.update(recordId, { name: 'late' });
						await hookEntered;
						await delay(1200);
						other = await Embedded.lock(recordId, { hold: true, lease: 5000 }, {});
						// recordLockFor prunes the lapsed handle before this re-lock waits on the other holder
						await assert.rejects(() => Embedded.lock(recordId, { timeout: 50 }), { statusCode: 423 });
						releaseEmbed();
						await pending;
					});
				} catch (err) {
					error = err;
				} finally {
					await other?.unlock();
				}
				assert.strictEqual(error?.statusCode, 409, `expected 409, got ${error?.statusCode ?? 'none'}`);
				assert.strictEqual((await Embedded.get(recordId)).name, 'a');
			});

			it('a static update keeps a lease that lapsed while its hook ran even after the key is re-locked', async function () {
				if (SKIP_ON_LMDB) return this.skip();
				const recordId = id();
				await Embedded.put({ id: recordId, name: 'a' });
				let relocked;
				let error;
				try {
					await transaction({}, async () => {
						await Embedded.lock(recordId, { hold: true, lease: 1000 });
						const hookEntered = nextHook();
						const pending = Embedded.update(recordId, { name: 'late' });
						await hookEntered;
						await delay(1200);
						const other = await Embedded.lock(recordId, { hold: true, lease: 5000 }, {});
						other.set('name', 'other');
						await other.save();
						await other.unlock();
						relocked = await Embedded.lock(recordId, { hold: true, lease: 5000 });
						releaseEmbed();
						await pending;
					});
				} catch (err) {
					error = err;
				} finally {
					await relocked?.unlock();
				}
				assert.strictEqual(error?.statusCode, 409, `expected 409, got ${error?.statusCode ?? 'none'}`);
				assert.strictEqual((await Embedded.get(recordId)).name, 'other');
			});

			it('a static update whose hook is still running when its lock is unlocked past the deadline is refused', async function () {
				if (SKIP_ON_LMDB) return this.skip();
				const recordId = id();
				await Embedded.put({ id: recordId, name: 'a' });
				const context = {};
				let error;
				try {
					await transaction(context, async () => {
						const holder = await Embedded.lock(recordId, { hold: true, lease: 1000 });
						const hookEntered = nextHook();
						const pending = Embedded.update(recordId, { name: 'late' });
						await hookEntered;
						assert.strictEqual(context.transaction.recordLockFor(Embedded.primaryStore, recordId).expired, false);
						const stallUntil = Date.now() + 1200;
						while (Date.now() < stallUntil);
						await holder.unlock();
						releaseEmbed();
						await pending;
					});
				} catch (err) {
					error = err;
				}
				assert.strictEqual(error?.statusCode, 409, `expected 409, got ${error?.statusCode ?? 'none'}`);
				assert.strictEqual((await Embedded.get(recordId)).name, 'a');
			});

			it('a static update whose lock was unlocked while its hook ran lands as an ordinary write after the old deadline', async function () {
				if (SKIP_ON_LMDB) return this.skip();
				const recordId = id();
				await Embedded.put({ id: recordId, name: 'a' });
				await transaction({}, async () => {
					const locked = await Embedded.lock(recordId, { hold: true, lease: 1000 });
					const hookEntered = nextHook();
					const pending = Embedded.update(recordId, { name: 'b' });
					await hookEntered;
					await locked.unlock();
					await delay(1200);
					releaseEmbed();
					await pending;
				});
				assert.strictEqual((await Embedded.get(recordId)).name, 'b');
			});
		});

		it('a static update under a held lock unlocked after its deadline, before the lease timer ran, is refused', async function () {
			if (SKIP_ON_LMDB) return this.skip();
			const recordId = id();
			await Audited.put({ id: recordId, n: 1 });
			const context = {};
			await assert.rejects(
				() =>
					transaction(context, async () => {
						const holder = await Audited.lock(recordId, { hold: true, lease: 1000 });
						await Audited.update(recordId, { n: 2 });
						assert.strictEqual(context.transaction.recordLockFor(Audited.primaryStore, recordId).expired, false);
						// a stalled event loop: the deadline passes but the lease timer cannot run before unlock()
						const stallUntil = Date.now() + 1200;
						while (Date.now() < stallUntil);
						await holder.unlock();
					}),
				(error) => {
					assert.strictEqual(error.statusCode, 409, error.message);
					return true;
				}
			);
			assert.strictEqual((await Audited.get(recordId)).n, 1);
		});

		it('a write to the same id in another table is not covered by the lock', async function () {
			if (SKIP_ON_LMDB) return this.skip();
			const recordId = id();
			await Audited.put({ id: recordId, n: 1 });
			await Unaudited.put({ id: recordId, n: 1 });
			const context = {};
			await transaction(context, async () => {
				await Audited.lock(recordId);
				await Unaudited.update(recordId, { n: 2 });
				assert.strictEqual(context.transaction.hasUnlockedWrite(), true);
			});
			assert.strictEqual((await Unaudited.get(recordId)).n, 2);
		});
	});
});
