'use strict';

require('../../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../../testUtils');
const { table } = require('#src/resources/databases');
const { cleanupExpiredAnalytics } = require('#src/resources/analytics/write');

const HOUR = 3600000;
const RETENTION = 1000;

describe('analytics retention cleanup', () => {
	let tableCount = 0;
	let Analytics;
	let store;

	before(function () {
		setupTestDBPath();
	});

	// A fresh table per test: the cleanup keeps its cursor per store.
	beforeEach(function () {
		Analytics = table({
			table: `AnalyticsCleanup${tableCount++}`,
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		store = Analytics.primaryStore;
	});

	async function seed(times) {
		await Promise.all(times.map((time) => store.put([time, 'node-1'], { time })));
	}

	// LMDB queues the cleanup's unawaited removes; a later write commits only after them.
	async function remainingTimes() {
		await store.remove(['settle']);
		return Array.from(store.getKeys({ start: false, end: Infinity }), (key) => key[0]);
	}

	function recordGetKeysStarts() {
		const starts = [];
		const getKeys = store.getKeys;
		store.getKeys = function (options) {
			starts.push(options.start);
			return getKeys.call(this, options);
		};
		return starts;
	}

	it('deletes rows older than the retention window and keeps the rest', async function () {
		await seed([100, 200, 5000, 6000]);
		await cleanupExpiredAnalytics(Analytics, RETENTION, 5500);
		assert.deepStrictEqual(await remainingTimes(), [5000, 6000]);
	});

	it('starts each pass where the previous one ended instead of at the first key', async function () {
		await seed([100, 200, 5000, 6000]);
		const starts = recordGetKeysStarts();
		await cleanupExpiredAnalytics(Analytics, RETENTION, 5500);
		await cleanupExpiredAnalytics(Analytics, RETENTION, 7500);
		assert.deepStrictEqual(starts, [false, 4500]);
		assert.deepStrictEqual(await remainingTimes(), []);
	});

	it('does nothing when the clock is behind the previous pass', async function () {
		await seed([100, 5000, 6000]);
		await cleanupExpiredAnalytics(Analytics, RETENTION, 5500);
		const starts = recordGetKeysStarts();
		await cleanupExpiredAnalytics(Analytics, RETENTION, 5000);
		assert.deepStrictEqual(starts, []);
		assert.deepStrictEqual(await remainingTimes(), [5000, 6000]);
	});

	it('yields to the event loop between batches of a large backlog', async function () {
		this.timeout(20000);
		const times = Array.from({ length: 2500 }, (_, index) => index + 1);
		await seed([...times, 100000]);
		const order = [];
		setImmediate(() => order.push('event loop'));
		await cleanupExpiredAnalytics(Analytics, RETENTION, 50000);
		order.push('cleanup done');
		assert.deepStrictEqual(order, ['event loop', 'cleanup done']);
		assert.deepStrictEqual(await remainingTimes(), [100000]);
	});

	it('compacts the expired range on its first pass, then at most hourly and only after deleting', async function () {
		if (typeof store.compact !== 'function') this.skip();
		const compactions = [];
		const compact = store.compact;
		store.compact = function (options) {
			compactions.push(options);
			return compact.call(this, options);
		};
		const start = 10 * HOUR;
		await seed([start - 2 * RETENTION, start + 10, start + HOUR + 10]);

		await cleanupExpiredAnalytics(Analytics, RETENTION, start);
		await cleanupExpiredAnalytics(Analytics, RETENTION, start + RETENTION + 20);
		await cleanupExpiredAnalytics(Analytics, RETENTION, start + HOUR + RETENTION + 20);
		await cleanupExpiredAnalytics(Analytics, RETENTION, start + 3 * HOUR);

		assert.deepStrictEqual(compactions, [
			{ start: false, end: start - RETENTION },
			{ start: false, end: start + HOUR + 20 },
		]);
	});

	it('refuses a pass that starts while another is still deleting', async function () {
		this.timeout(20000);
		await seed(Array.from({ length: 2500 }, (_, index) => index + 1));
		const starts = recordGetKeysStarts();
		await Promise.all([
			cleanupExpiredAnalytics(Analytics, RETENTION, 50000),
			cleanupExpiredAnalytics(Analytics, RETENTION, 50000),
		]);
		assert.strictEqual(starts.filter((start) => start === false).length, 1);
		assert.deepStrictEqual(await remainingTimes(), []);
	});
});
