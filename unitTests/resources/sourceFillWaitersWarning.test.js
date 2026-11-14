'use strict';

require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor.js');
const { table, getDatabases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { logger } = require('#src/utility/logging/logger');
const { setSourceFillLockTimeoutForTesting } = require('#src/resources/Table');

describe('Requests waiting on one source fill', function () {
	this.timeout(10_000);
	let tableIndex = 0;
	let warnings;
	let originalWarn;
	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});
	beforeEach(function () {
		warnings = [];
		originalWarn = logger.warn;
		logger.warn = (...args) => warnings.push(args.join(' '));
	});
	afterEach(function () {
		logger.warn = originalWarn;
	});

	function setUpTable() {
		const fixture = { name: `SourceFillWaiters${tableIndex++}`, sourceCalls: 0, pending: [], parked: 0 };
		fixture.WaitTable = table({
			table: fixture.name,
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		getDatabases();
		fixture.WaitTable.sourcedFrom({
			get() {
				fixture.sourceCalls++;
				return new Promise((resolve, reject) => fixture.pending.push({ resolve, reject }));
			},
		});
		const { primaryStore } = fixture.WaitTable;
		const tryLock = primaryStore.tryLock;
		primaryStore.tryLock = function (key, onUnlocked) {
			const acquired = tryLock.call(this, key, onUnlocked);
			if (!acquired) fixture.parked++;
			return acquired;
		};
		return fixture;
	}
	const reads = (fixture, id, count) =>
		Array.from({ length: count }, () => fixture.WaitTable.get(id).catch((error) => error));
	const warningsFor = (fixture) => warnings.filter((warning) => warning.includes(fixture.name));

	const failedFillWarning = (key, failure) =>
		new RegExp(
			`^A fetch of record '${key}' of SourceFillWaiters\\d+ from its source failed with ${failure} while \\d+ requests on this thread waited on it; they now fetch it again in turn$`
		);
	const settle = async (fixture, waiting) => {
		while (true) {
			const unsettled = fixture.pending.splice(0);
			for (const call of unsettled) call.resolve(undefined);
			const done = await Promise.race([Promise.all(waiting).then(() => true), new Promise((r) => setTimeout(r, 20))]);
			if (done) return;
		}
	};

	it('stays quiet while many requests wait on a fill that succeeds', async function () {
		const fixture = setUpTable();
		const hot = reads(fixture, 'refilled', 60);
		await waitFor(() => fixture.parked >= 59);
		fixture.pending[0].resolve({ name: 'refilled' });
		const results = await Promise.all(hot);
		assert.ok(results.every((result) => result?.name === 'refilled'));
		assert.equal(fixture.sourceCalls, 1);
		assert.deepEqual(warningsFor(fixture), []);
	});

	it('names the table, key, failure and waiter count once when a fill fails with many waiting', async function () {
		const fixture = setUpTable();
		const hot = reads(fixture, 'failing', 60);
		await waitFor(() => fixture.parked >= 59);
		fixture.pending.shift().reject(Object.assign(new Error('origin unavailable'), { statusCode: 503 }));
		await waitFor(() => fixture.sourceCalls === 2);
		assert.equal(warningsFor(fixture).length, 1);
		assert.match(warningsFor(fixture)[0], failedFillWarning('failing', 503));
		assert.match(warningsFor(fixture)[0], / while 59 requests /);

		fixture.pending.shift().reject(Object.assign(new Error('origin unavailable'), { statusCode: 503 }));
		await waitFor(() => fixture.sourceCalls === 3);
		assert.equal(warningsFor(fixture).length, 1, 'one warning per table per interval');
		await settle(fixture, hot);
	});

	it('stays quiet when a fill fails with few waiting', async function () {
		const fixture = setUpTable();
		const few = reads(fixture, 'few', 10);
		await waitFor(() => fixture.parked >= 9);
		fixture.pending.shift().reject(Object.assign(new Error('origin unavailable'), { statusCode: 503 }));
		await waitFor(() => fixture.sourceCalls === 2);
		assert.deepEqual(warningsFor(fixture), []);
		await settle(fixture, few);
	});

	it('warns when caching the source answer fails with many waiting', async function () {
		const fixture = setUpTable();
		const getResidency = fixture.WaitTable.getResidency;
		fixture.WaitTable.getResidency = () => {
			throw new Error('cache write refused');
		};
		try {
			const hot = reads(fixture, 'unwritable', 60);
			await waitFor(() => fixture.parked >= 59);
			fixture.pending.shift().resolve({ name: 'unwritable' });
			await waitFor(() => warningsFor(fixture).length > 0);
			assert.match(warningsFor(fixture)[0], failedFillWarning('unwritable', "'cache write refused'"));
			fixture.WaitTable.getResidency = getResidency;
			await settle(fixture, hot);
		} finally {
			fixture.WaitTable.getResidency = getResidency;
		}
	});

	it('settles every request when the warning itself throws', async function () {
		const fixture = setUpTable();
		logger.warn = () => {
			throw new Error('log sink failed');
		};
		const hot = reads(fixture, 'loud', 60);
		await waitFor(() => fixture.parked >= 59);
		fixture.pending.shift().reject(Object.assign(new Error('origin unavailable'), { statusCode: 503 }));
		await waitFor(() => fixture.sourceCalls === 2);
		fixture.pending.shift().resolve({ name: 'loud' });
		const results = await Promise.all(hot);
		assert.equal(results.filter((result) => result?.statusCode === 503).length, 1);
		assert.ok(results.filter((result) => result?.statusCode !== 503).every((result) => result?.name === 'loud'));
	});

	it('releases the record when the warning throws after a failed cache write', async function () {
		const fixture = setUpTable();
		const getResidency = fixture.WaitTable.getResidency;
		fixture.WaitTable.getResidency = () => {
			throw new Error('cache write refused');
		};
		logger.warn = () => {
			throw new Error('log sink failed');
		};
		try {
			const hot = reads(fixture, 'loud-write', 60);
			await waitFor(() => fixture.parked >= 59);
			fixture.pending.shift().resolve({ name: 'loud-write' });
			// the next waiter can fetch only once the failed write let go of the record
			await waitFor(() => fixture.sourceCalls === 2, { timeout: 2_000 });
			fixture.WaitTable.getResidency = getResidency;
			await settle(fixture, hot);
		} finally {
			fixture.WaitTable.getResidency = getResidency;
		}
	});

	it('names a timeout by its error name and an empty error by its record context', async function () {
		const timeout = AbortSignal.timeout(0);
		await waitFor(() => timeout.aborted);
		for (const [key, reason, expected] of [
			['timed-out', timeout.reason, " failed with 'TimeoutError' while "],
			['unnamed', new Error(), " failed with ' while resolving record unnamed for SourceFillWaiters"],
		]) {
			const fixture = setUpTable();
			const hot = reads(fixture, key, 60);
			await waitFor(() => fixture.parked >= 59);
			fixture.pending.shift().reject(reason);
			await waitFor(() => warningsFor(fixture).length > 0);
			assert.ok(warningsFor(fixture)[0].includes(expected), warningsFor(fixture)[0]);
			await settle(fixture, hot);
		}
	});

	it('does not report waiters that moved on to a later fill', async function () {
		setSourceFillLockTimeoutForTesting(200);
		try {
			const fixture = setUpTable();
			const hot = reads(fixture, 'handed-over', 60);
			await waitFor(() => fixture.parked >= 59);
			// the first fill outlives its hold, so the waiters move on to a second one
			await waitFor(() => fixture.sourceCalls === 2);
			fixture.pending.shift().reject(Object.assign(new Error('origin unavailable'), { statusCode: 503 }));
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.deepEqual(warningsFor(fixture), []);
			fixture.pending.shift().resolve({ name: 'handed-over' });
			await settle(fixture, hot);
		} finally {
			setSourceFillLockTimeoutForTesting(undefined);
		}
	});

	it('bounds a long key in the warning', async function () {
		const fixture = setUpTable();
		const longKey = 'k'.repeat(1_500);
		const waiting = reads(fixture, longKey, 60);
		await waitFor(() => fixture.parked >= 59);
		fixture.pending.shift().reject(Object.assign(new Error('origin unavailable'), { statusCode: 503 }));
		await waitFor(() => warningsFor(fixture).length > 0);
		const [warning] = warningsFor(fixture);
		assert.ok(warning.length < 400, `the warning is ${warning.length} characters long`);
		assert.ok(!warning.includes(longKey));
		await settle(fixture, waiting);
	});
});
