'use strict';

// A read that may be served stale starts a background refresh only when no fill holds its key, on
// this thread or another; it never queues behind one, so a failed refresh is not repeated per read.

require('../testUtils');
const assert = require('node:assert');
const { setTimeout: delay } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor.js');
const { table, getDatabases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { logger } = require('#src/utility/logging/logger');
const { RocksDatabase } = require('@harperfast/rocksdb-js');

describe('Stale-while-revalidate refreshes', function () {
	const isLmdb = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
	this.timeout(10_000);
	let StaleTable;
	let StaleAllowed;
	let StaleQueryTable;
	let sourceCalls;
	let pendingCalls;
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
		// a query consults the table's own stale policy, so this one allows stale on its prototype
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
		warnings = [];
		originalWarn = logger.warn;
		logger.warn = (...args) => warnings.push(args.map((arg) => arg?.message ?? String(arg)).join(' '));
	});
	afterEach(function () {
		logger.warn = originalWarn;
		for (const call of pendingCalls) call.resolve(undefined);
	});
	const expire = (id, name = 'stale ' + id) => StaleTable.put(id, { id, name }, { expiresAt: 1 });
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

	it('starts no refresh while another thread is filling the key', async function () {
		if (isLmdb) this.skip();
		await expire('foreign');
		const otherThread = new RocksDatabase(StaleTable.primaryStore.rootStore.path).open();
		try {
			assert.equal(otherThread.tryLock('foreign'), true);
			assert.equal((await StaleAllowed.get('foreign')).name, 'stale foreign');
			otherThread.unlock('foreign');
			await delay(50);
			assert.equal(sourceCalls, 0);
		} finally {
			otherThread.close();
		}
	});
});
