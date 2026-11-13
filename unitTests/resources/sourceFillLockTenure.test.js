'use strict';

require('../testUtils');
const assert = require('node:assert');
const { setTimeout: delay } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor.js');
const { table, getDatabases } = require('#src/resources/databases');
const { setSourceFillLockTimeoutForTesting } = require('#src/resources/Table');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { RocksDatabase } = require('@harperfast/rocksdb-js');

describe('Source fill lock tenure', function () {
	const isLmdb = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
	const TENURE = 500;
	this.timeout(20 * TENURE);
	let TenureTable;
	let sourceCalls;
	let pendingCalls;
	let reads;
	const read = (id) => {
		const reading = TenureTable.get(id);
		reads.push([id, reading]);
		return reading;
	};
	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		TenureTable = table({
			table: 'SourceFillLockTenure',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		getDatabases();
		TenureTable.sourcedFrom({
			get() {
				sourceCalls++;
				return new Promise((resolve, reject) => pendingCalls.push({ resolve, reject }));
			},
		});
		setSourceFillLockTimeoutForTesting(TENURE);
	});
	after(function () {
		setSourceFillLockTimeoutForTesting(undefined);
	});
	beforeEach(function () {
		sourceCalls = 0;
		pendingCalls = [];
		reads = [];
	});
	afterEach(async function () {
		for (const call of pendingCalls ?? []) call.resolve(undefined);
		await Promise.allSettled((reads ?? []).map(([, reading]) => reading));
		const { primaryStore } = TenureTable;
		await waitFor(() => !(reads ?? []).some(([id]) => primaryStore.hasLock(id)), {
			message: 'a fill did not finish',
		});
		await primaryStore.committed;
	});

	it("does not let a fill that outlived its tenure release the next fill's lock", async function () {
		const first = read('late').catch((error) => error);
		await waitFor(() => sourceCalls === 1);
		const second = read('late');
		await waitFor(() => sourceCalls === 2, { timeout: 4 * TENURE, message: 'no second fill after the tenure' });

		pendingCalls[0].reject(Object.assign(new Error('the first fill failed late'), { statusCode: 500 }));
		assert.match((await first).message, /^the first fill failed late/);
		await delay(50);
		assert.equal(TenureTable.primaryStore.hasLock('late'), true, 'the second fill still holds the lock');
		const third = read('late');
		await delay(50);
		assert.equal(sourceCalls, 2, 'a third read waits for the second fill');

		pendingCalls[1].resolve({ id: 'late', name: 'second fill' });
		assert.equal((await second).name, 'second fill');
		assert.equal((await third).name, 'second fill');
		assert.equal(sourceCalls, 2);
	});

	it("does not let a waiter's timeout release a lock another thread holds", async function () {
		if (isLmdb) this.skip();
		const otherThread = new RocksDatabase(TenureTable.primaryStore.rootStore.path).open();
		const { primaryStore } = TenureTable;
		const tryLock = primaryStore.tryLock;
		let lockAttempts = 0;
		primaryStore.tryLock = function (key, onUnlocked) {
			lockAttempts++;
			return tryLock.call(this, key, onUnlocked);
		};
		try {
			assert.equal(otherThread.tryLock('foreign'), true);
			const waiter = read('foreign');
			await delay(3.5 * TENURE);
			assert.equal(sourceCalls, 0, 'the waiter has not called the source');
			assert.equal(otherThread.hasLock('foreign'), true, 'the other thread still holds its lock');
			assert.equal(lockAttempts, 1, 'the waiter kept its one place in the queue across its timeouts');

			otherThread.unlock('foreign');
			await waitFor(() => sourceCalls === 1, { timeout: 2 * TENURE, message: 'the unlock did not wake the waiter' });
			pendingCalls[0].resolve({ id: 'foreign', name: 'after the unlock' });
			assert.equal((await waiter).name, 'after the unlock');
		} finally {
			primaryStore.tryLock = tryLock;
			otherThread.close();
		}
	});

	it("does not let a fill that settled early release a later fill's lock when its tenure would have ended", async function () {
		const first = read('early');
		await waitFor(() => sourceCalls === 1);
		await delay(0.6 * TENURE);
		pendingCalls[0].resolve(undefined);
		assert.equal(await first, undefined);
		await waitFor(() => !TenureTable.primaryStore.hasLock('early'));
		const second = read('early');
		await waitFor(() => sourceCalls === 2);
		// past the end of the first fill's tenure, inside the second's
		await delay(0.6 * TENURE);
		assert.equal(TenureTable.primaryStore.hasLock('early'), true, 'the second fill still holds the lock');
		pendingCalls[1].resolve({ id: 'early', name: 'second fill' });
		assert.equal((await second).name, 'second fill');
	});

	it("keeps the second fill's record when the first fill commits after it", async function () {
		const first = read('raced');
		await waitFor(() => sourceCalls === 1);
		const second = read('raced');
		await waitFor(() => sourceCalls === 2, { timeout: 4 * TENURE, message: 'no second fill after the tenure' });
		pendingCalls[1].resolve({ id: 'raced', name: 'second fill' });
		assert.equal((await second).name, 'second fill');
		await waitFor(() => TenureTable.primaryStore.getEntry('raced')?.value?.name === 'second fill');
		pendingCalls[0].resolve({ id: 'raced', name: 'first fill' });
		await first;
		await delay(50);
		assert.equal(TenureTable.primaryStore.getEntry('raced').value.name, 'second fill');
		assert.equal((await read('raced')).name, 'second fill');
	});

	it('lets a later read fill a key whose source call never settles once the tenure ends', async function () {
		read('stuck').catch(() => {});
		await waitFor(() => sourceCalls === 1);
		const later = read('stuck');
		await waitFor(() => sourceCalls === 2, { timeout: 4 * TENURE, message: 'the stuck fill kept the lock' });
		pendingCalls[1].resolve({ id: 'stuck', name: 'second fill' });
		assert.equal((await later).name, 'second fill');
	});
});
