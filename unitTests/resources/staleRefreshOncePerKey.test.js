'use strict';

require('../testUtils');
const assert = require('node:assert');
const { Worker } = require('node:worker_threads');
const { setTimeout: delay } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor.js');
const { table, getDatabases } = require('#src/resources/databases');
const { setSourceFillLockTimeoutForTesting } = require('#src/resources/Table');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { logger } = require('#src/utility/logging/logger');

function ask(worker, message) {
	return new Promise((resolve, reject) => {
		worker.once('message', resolve);
		worker.once('error', reject);
		worker.postMessage(message);
	});
}

describe('Stale-while-revalidate refreshes', function () {
	this.timeout(10_000);
	let StaleTable;
	let StaleAllowed;
	let StaleQueryTable;
	let sourceCalls;
	let pendingCalls;
	let touched;
	let warnings;
	let originalWarn;
	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		const heldSource = {
			get() {
				sourceCalls++;
				return new Promise((resolve, reject) => pendingCalls.push({ resolve, reject }));
			},
		};
		StaleTable = table({
			table: 'StaleRefreshOncePerKey',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		StaleQueryTable = table({
			table: 'StaleRefreshOncePerKeyQueried',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
			],
		});
		getDatabases();
		StaleTable.sourcedFrom(heldSource);
		StaleQueryTable.sourcedFrom(heldSource);
		StaleQueryTable.prototype.allowStaleWhileRevalidate = () => true;
		StaleAllowed = class extends StaleTable {
			allowStaleWhileRevalidate() {
				return true;
			}
		};
	});
	beforeEach(function () {
		sourceCalls = 0;
		pendingCalls = [];
		touched = [];
		warnings = [];
		originalWarn = logger.warn;
		logger.warn = (...args) => warnings.push(args.map((arg) => arg?.message ?? String(arg)).join(' '));
	});
	afterEach(async function () {
		logger.warn = originalWarn;
		for (const call of pendingCalls ?? []) call.resolve(undefined);
		await waitFor(() => (touched ?? []).every(([Table, id]) => !Table.primaryStore.hasLock(id)), {
			message: 'a background refresh did not finish',
		});
	});
	const expire = (id, name = 'stale ' + id) => {
		touched.push([StaleTable, id]);
		return StaleTable.put(id, { id, name }, { expiresAt: 1 });
	};
	const refreshFailure = () => Object.assign(new Error('refresh failed'), { statusCode: 503 });
	const refreshWarnings = () => warnings.filter((warning) => warning.startsWith('refresh failed'));

	it('starts one refresh for concurrent stale reads and does not repeat it per read when it fails', async function () {
		await expire('failing');
		const hits = await Promise.all(Array.from({ length: 20 }, () => StaleAllowed.get('failing')));
		assert.deepEqual(
			hits.map((record) => record.name),
			Array(20).fill('stale failing')
		);
		assert.equal(sourceCalls, 1);

		pendingCalls[0].reject(refreshFailure());
		await waitFor(() => refreshWarnings().length > 0, { message: 'the failed refresh was not reported' });
		await delay(50);
		assert.equal(sourceCalls, 1, 'no read queued a refresh of its own');
		assert.equal(refreshWarnings().length, 1);

		assert.equal((await StaleAllowed.get('failing')).name, 'stale failing');
		assert.equal(sourceCalls, 2, 'a read after the failure refreshes again');
	});

	it('replaces the stale record when the one refresh succeeds', async function () {
		await expire('refreshed');
		const hits = await Promise.all(Array.from({ length: 5 }, () => StaleAllowed.get('refreshed')));
		assert.deepEqual(
			hits.map((record) => record.name),
			Array(5).fill('stale refreshed')
		);
		pendingCalls[0].resolve({ id: 'refreshed', name: 'fresh' });
		await waitFor(() => StaleTable.primaryStore.getEntry('refreshed')?.value?.name === 'fresh');
		assert.equal((await StaleAllowed.get('refreshed')).name, 'fresh');
		assert.equal(sourceCalls, 1);
	});

	it('still makes a read that may not be served stale wait for the refresh', async function () {
		await expire('mixed');
		assert.equal((await StaleAllowed.get('mixed')).name, 'stale mixed');
		const strict = StaleTable.get('mixed');
		await delay(20);
		assert.equal(sourceCalls, 1);
		pendingCalls[0].resolve({ id: 'mixed', name: 'fresh mixed' });
		assert.equal((await strict).name, 'fresh mixed');
		assert.equal(sourceCalls, 1);
	});

	it('starts one refresh for the stale rows that concurrent queries read', async function () {
		touched.push([StaleQueryTable, 'queried']);
		await StaleQueryTable.put('queried', { id: 'queried', name: 'stale-query' }, { expiresAt: 1 });
		const searches = Array.from({ length: 5 }, async () => {
			const names = [];
			for await (const record of StaleQueryTable.search({ conditions: [{ attribute: 'name', value: 'stale-query' }] }))
				names.push(record.name);
			return names;
		});
		assert.deepEqual(await Promise.all(searches), Array(5).fill(['stale-query']));
		assert.equal(sourceCalls, 1);
		pendingCalls[0].reject(refreshFailure());
		await waitFor(() => refreshWarnings().length > 0);
		await delay(50);
		assert.equal(sourceCalls, 1);
	});

	it('serves stale and reports it when the lock cannot be tried', async function () {
		await expire('untryable');
		const { primaryStore } = StaleTable;
		const tryLock = primaryStore.tryLock;
		primaryStore.tryLock = function (key, onUnlocked) {
			if (key === 'untryable') throw new Error('lock table unavailable');
			return tryLock.call(this, key, onUnlocked);
		};
		try {
			assert.equal((await StaleAllowed.get('untryable')).name, 'stale untryable');
			assert.equal(sourceCalls, 0);
			assert.ok(warnings.some((warning) => warning.startsWith('lock table unavailable')));
		} finally {
			primaryStore.tryLock = tryLock;
		}
	});

	it('releases the lock it took when its refresh throws before calling the source', async function () {
		await expire('setup-throws');
		const { primaryStore } = StaleTable;
		const tryLock = primaryStore.tryLock;
		let admitted = false;
		primaryStore.tryLock = function (key, onUnlocked) {
			const acquired = tryLock.call(this, key, onUnlocked);
			if (key === 'setup-throws' && acquired) admitted = true;
			return acquired;
		};
		let timestamp;
		const context = {
			get timestamp() {
				if (admitted) throw new Error('context timestamp unreadable');
				return timestamp;
			},
			set timestamp(value) {
				timestamp = value;
			},
		};
		try {
			assert.equal((await StaleAllowed.get('setup-throws', context)).name, 'stale setup-throws');
		} finally {
			primaryStore.tryLock = tryLock;
		}
		await waitFor(() => warnings.some((warning) => warning.startsWith('context timestamp unreadable')), {
			message: 'the failed refresh was not reported',
		});
		assert.equal(sourceCalls, 0);
		assert.equal((await StaleAllowed.get('setup-throws')).name, 'stale setup-throws');
		assert.equal(sourceCalls, 1, 'the lock was released, so the next stale read refreshes');
	});

	it('refreshes again once a refresh whose source never settles reaches its hold limit', async function () {
		setSourceFillLockTimeoutForTesting(300);
		try {
			await expire('hung');
			assert.equal((await StaleAllowed.get('hung')).name, 'stale hung');
			assert.equal((await StaleAllowed.get('hung')).name, 'stale hung');
			assert.equal(sourceCalls, 1, 'the running refresh keeps the record busy');
			await waitFor(() => !StaleTable.primaryStore.hasLock('hung'), {
				message: 'the unsettled refresh never let go of the record',
			});
			assert.equal((await StaleAllowed.get('hung')).name, 'stale hung');
			assert.equal(sourceCalls, 2, 'a read after the hold limit refreshes again');
		} finally {
			setSourceFillLockTimeoutForTesting(undefined);
		}
	});

	it('starts no refresh while another thread holds the record lock', async function () {
		this.timeout(30_000);
		await expire('foreign');
		const otherThread = new Worker(__dirname + '/staleRefreshOncePerKey-thread.js', {
			workerData: { holdsRecordLocks: true },
		});
		try {
			assert.equal((await ask(otherThread, { type: 'lock', id: 'foreign' })).acquired, true);
			assert.equal((await StaleAllowed.get('foreign')).name, 'stale foreign');
			assert.equal((await ask(otherThread, { type: 'unlock', id: 'foreign' })).released, true);
			await delay(50);
			assert.equal(sourceCalls, 0, 'the skipped read queued no refresh');
			assert.equal((await StaleAllowed.get('foreign')).name, 'stale foreign');
			assert.equal(sourceCalls, 1, 'a read after the other thread released refreshes');
		} finally {
			await otherThread.terminate();
		}
	});
});
