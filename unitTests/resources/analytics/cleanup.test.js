'use strict';

require('../../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../../testUtils');
const { table } = require('#src/resources/databases');
const { cleanupExpiredAnalytics } = require('#src/resources/analytics/cleanup');

const HOUR = 3600000;
const RETENTION = 1000;

describe('analytics retention cleanup', () => {
	let tableCount = 0;
	let Analytics;
	let store;

	before(function () {
		setupTestDBPath();
	});

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

	function remainingTimes() {
		return Array.from(store.getKeys({ start: false, end: Infinity }), (key) => key[0]);
	}

	function record(calls, method, entry = (options) => options.start) {
		const original = store[method];
		store[method] = function (...args) {
			calls.push(entry(...args));
			return original.apply(this, args);
		};
	}

	function withoutCompaction() {
		store.compact = undefined;
	}

	it('deletes rows older than the retention window and keeps the rest', async function () {
		await seed([100, 200, 5000, 6000]);
		await cleanupExpiredAnalytics(Analytics, RETENTION, 5500);
		assert.deepStrictEqual(remainingTimes(), [5000, 6000]);
	});

	it('starts each pass where the previous one ended instead of at the first key', async function () {
		await seed([100, 200, 5000, 6000]);
		const starts = [];
		record(starts, 'getKeys');
		await cleanupExpiredAnalytics(Analytics, RETENTION, 5500);
		await cleanupExpiredAnalytics(Analytics, RETENTION, 7500);
		assert.deepStrictEqual(starts, [false, 4500]);
		assert.deepStrictEqual(remainingTimes(), []);
	});

	it('does nothing when the clock is behind the previous pass', async function () {
		await seed([100, 5000, 6000]);
		await cleanupExpiredAnalytics(Analytics, RETENTION, 5500);
		const starts = [];
		record(starts, 'getKeys');
		await cleanupExpiredAnalytics(Analytics, RETENTION, 5000);
		assert.deepStrictEqual(starts, []);
		assert.deepStrictEqual(remainingTimes(), [5000, 6000]);
	});

	for (const [failureStyle, fail] of [
		['rejects', () => Promise.reject(new Error('disk full'))],
		[
			'throws',
			() => {
				throw new Error('disk full');
			},
		],
	]) {
		it(`keeps its place when a removal ${failureStyle}, so the next pass retries it`, async function () {
			await seed([100, 200, 5000]);
			const remove = store.remove;
			let failNext = true;
			store.remove = function (key) {
				if (failNext && key[0] === 200) {
					failNext = false;
					return fail();
				}
				return remove.call(this, key);
			};
			const starts = [];
			record(starts, 'getKeys');
			await cleanupExpiredAnalytics(Analytics, RETENTION, 5500);
			assert.strictEqual(store.get([100, 'node-1']), undefined);
			assert.ok(store.get([200, 'node-1']));
			await cleanupExpiredAnalytics(Analytics, RETENTION, 5600);
			assert.deepStrictEqual(starts, [false, false]);
			assert.deepStrictEqual(remainingTimes(), [5000]);
		});
	}

	it('keeps the batches that settled when a later batch fails', async function () {
		this.timeout(20000);
		await seed(Array.from({ length: 1500 }, (_, index) => index + 1));
		const remove = store.remove;
		store.remove = function (key) {
			if (key[0] === 1200) return Promise.reject(new Error('disk full'));
			return remove.call(this, key);
		};
		const starts = [];
		record(starts, 'getKeys');
		await cleanupExpiredAnalytics(Analytics, RETENTION, 50000);
		await cleanupExpiredAnalytics(Analytics, RETENTION, 50000);
		assert.deepStrictEqual(starts, [false, [1000, 'node-1'], [1000, 'node-1']]);
	});

	it('yields to the event loop between batches of a large backlog', async function () {
		this.timeout(20000);
		withoutCompaction();
		const times = Array.from({ length: 2500 }, (_, index) => index + 1);
		await seed([...times, 100000]);
		const remove = store.remove;
		let removingSync = false;
		store.remove = function (key) {
			// lmdb-js implements removeSync through remove.
			if (removingSync) return remove.call(this, key);
			removingSync = true;
			try {
				this.removeSync(key);
			} finally {
				removingSync = false;
			}
		};
		const order = [];
		record(order, 'getKeys', () => 'batch');
		setImmediate(() => order.push('event loop'));
		await cleanupExpiredAnalytics(Analytics, RETENTION, 50000);
		assert.deepStrictEqual(order, ['batch', 'event loop', 'batch', 'batch']);
		assert.deepStrictEqual(remainingTimes(), [100000]);
	});

	it('refuses a pass that starts while another is still deleting', async function () {
		this.timeout(20000);
		withoutCompaction();
		await seed(Array.from({ length: 2500 }, (_, index) => index + 1));
		const starts = [];
		record(starts, 'getKeys');
		await Promise.all([
			cleanupExpiredAnalytics(Analytics, RETENTION, 50000),
			cleanupExpiredAnalytics(Analytics, RETENTION, 50000),
		]);
		assert.strictEqual(starts.filter((start) => start === false).length, 1);
		assert.deepStrictEqual(remainingTimes(), []);
	});

	describe('compaction', function () {
		beforeEach(function () {
			if (typeof store.compact !== 'function') this.skip();
		});

		it('compacts the expired range before the first scan of a process', async function () {
			await seed([100, 5000]);
			const calls = [];
			record(calls, 'compact', () => 'compact');
			record(calls, 'getKeys', () => 'getKeys');
			await cleanupExpiredAnalytics(Analytics, RETENTION, 5500);
			assert.deepStrictEqual(calls, ['compact', 'getKeys']);
		});

		it('compacts again at most hourly, once a pass since the last compaction has deleted rows', async function () {
			const start = 10 * HOUR;
			await seed([start - 2 * RETENTION, start + 10]);
			const compactions = [];
			record(compactions, 'compact', (options) => options);

			await cleanupExpiredAnalytics(Analytics, RETENTION, start);
			await cleanupExpiredAnalytics(Analytics, RETENTION, start + RETENTION + 20);
			await cleanupExpiredAnalytics(Analytics, RETENTION, start + HOUR + RETENTION + 20);
			await cleanupExpiredAnalytics(Analytics, RETENTION, start + 3 * HOUR);

			assert.deepStrictEqual(compactions, [
				{ start: false, end: start - RETENTION },
				{ start: false, end: start + HOUR + 20 },
			]);
		});

		it('still compacts hourly while a removal keeps failing', async function () {
			const start = 10 * HOUR;
			await seed([start - 3 * RETENTION, start - 2 * RETENTION]);
			const remove = store.remove;
			store.remove = function (key) {
				if (key[0] === start - 2 * RETENTION) return Promise.reject(new Error('disk full'));
				return remove.call(this, key);
			};
			const compactions = [];
			record(compactions, 'compact', (options) => options.end);

			await cleanupExpiredAnalytics(Analytics, RETENTION, start);
			await cleanupExpiredAnalytics(Analytics, RETENTION, start + HOUR);

			assert.deepStrictEqual(compactions, [start - RETENTION, start + HOUR - RETENTION]);
		});

		it('retries a failed compaction an hour later even when nothing more was deleted', async function () {
			const start = 10 * HOUR;
			const compact = store.compact;
			const attempts = [];
			store.compact = function (options) {
				attempts.push(options.end);
				if (attempts.length === 1) return Promise.reject(new Error('compaction failed'));
				return compact.call(this, options);
			};

			await cleanupExpiredAnalytics(Analytics, RETENTION, start);
			await cleanupExpiredAnalytics(Analytics, RETENTION, start + 60000);
			await cleanupExpiredAnalytics(Analytics, RETENTION, start + HOUR);
			await cleanupExpiredAnalytics(Analytics, RETENTION, start + HOUR + 60000);

			assert.deepStrictEqual(attempts, [start - RETENTION, start + HOUR - RETENTION]);
		});
	});
});
