'use strict';

// Requests piling up on one key's source fill are named in a warning, at most once per table per
// interval, with the key rendered within a bound.

require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor.js');
const { table, getDatabases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { logger } = require('#src/utility/logging/logger');

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

	it('names the table and key once when many requests wait on one fill', async function () {
		const fixture = setUpTable();
		const hot = reads(fixture, 'hot', 60);
		await waitFor(() => fixture.parked >= 59);
		assert.deepEqual(warningsFor(fixture), [
			`50 requests on this thread are waiting for record 'hot' of ${fixture.name} to load from its source`,
		]);

		const second = reads(fixture, 'hot-again', 60);
		await waitFor(() => fixture.parked >= 59 + 59 && fixture.sourceCalls === 2);
		assert.equal(warningsFor(fixture).length, 1, 'one warning per table per interval');
		for (const call of fixture.pending) call.resolve(undefined);
		await Promise.all([...hot, ...second]);
	});

	it("reports the status of the key's last failed fill on this thread", async function () {
		const fixture = setUpTable();
		const first = reads(fixture, 'failing', 10);
		await waitFor(() => fixture.parked >= 9);
		fixture.pending[0].reject(Object.assign(new Error('origin unavailable'), { statusCode: 503 }));
		await waitFor(() => fixture.sourceCalls === 2);
		const more = reads(fixture, 'failing', 50);
		await waitFor(() => warningsFor(fixture).length > 0);
		assert.match(
			warningsFor(fixture)[0],
			/^\d+ requests on this thread are waiting for record 'failing' of SourceFillWaiters\d+ to load from its source; its last fill on this thread failed with 503$/
		);
		for (const call of fixture.pending) call.resolve(undefined);
		await Promise.all([...first, ...more]);
	});

	it('bounds a long key in the warning', async function () {
		const fixture = setUpTable();
		const longKey = 'k'.repeat(1_500);
		const waiting = reads(fixture, longKey, 60);
		await waitFor(() => warningsFor(fixture).length > 0 && fixture.sourceCalls === 1);
		const [warning] = warningsFor(fixture);
		assert.ok(warning.length < 400, `the warning is ${warning.length} characters long`);
		assert.ok(!warning.includes(longKey));
		for (const call of fixture.pending) call.resolve(undefined);
		await Promise.all(waiting);
	});
});
