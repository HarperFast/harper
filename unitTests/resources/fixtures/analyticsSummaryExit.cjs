'use strict';

// With the main thread's own analytics off, its final flush stores nothing, so only the exit's own wait for the summary
// queue keeps a worker's queued report from being lost.
const assert = require('node:assert');
const env = require('#src/utility/environment/environmentManager');
env.initSync();
const { table } = require('#src/resources/databases');
const analytics = require('#src/resources/analytics/write');
const { runStartup } = require('#src/utility/lifecycle');

const METRICS = 4;
const RUNS = 300_000;
runStartup()
	.then(async () => {
		const raw = table({
			table: 'hdb_raw_analytics',
			database: 'system',
			audit: false,
			trackDeletes: false,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'action' }, { name: 'metrics' }],
		});
		if (process.argv[2] === 'write') {
			analytics.setAnalyticsEnabled(false);
			// a commit still in flight when the exit flush returns would land after it, if at all; a report that
			// arrives while the first one commits must be waited for too
			const committed = new Set();
			let lateSent = false;
			const putOffThread = raw.primaryStore.putOffThread;
			if (putOffThread)
				raw.primaryStore.putOffThread = function (id, value) {
					if (!lateSent) {
						lateSent = true;
						setTimeout(
							() =>
								void analytics.recordAnalyticsReportForTests({
									report: { time: Date.now(), period: 1000, threadId: 98, metrics: [{ metric: 'summary-exit-late' }] },
								}),
							50
						);
					}
					return putOffThread
						.call(this, id, value)
						.then((result) => new Promise((resolve) => setTimeout(() => resolve(result), 200)))
						.finally(() => committed.add(value.metrics[0].metric));
				};
			const metrics = Array.from({ length: METRICS }, (_, i) => ({
				metric: 'summary-exit-probe',
				path: 'p' + i,
				method: undefined,
				type: undefined,
				mean: 2,
				count: RUNS,
			}));
			const runs = metrics.map((_, index) => ({
				index,
				values: Float32Array.from({ length: RUNS }, (_, n) => (n * 7919) % RUNS),
				runs: new Uint16Array(RUNS).fill(1),
				length: RUNS,
			}));
			void analytics.recordAnalyticsReportForTests({
				report: { time: Date.now(), period: 1000, threadId: 99, metrics },
				runs,
			});
			// a listener that throws on the final flush must not cost the reports already admitted
			analytics.addAnalyticsListener((_metrics, final) => {
				if (final) throw new Error('listener refused');
			});
			let flushError;
			await analytics.flushAnalyticsForExit().catch((error) => (flushError = error));
			assert.strictEqual(flushError?.message, 'listener refused', 'the listener error still surfaces');
			if (putOffThread) {
				assert.ok(committed.has('summary-exit-probe'), 'the exit flush waited for the report to commit');
				assert.ok(committed.has('summary-exit-late'), 'and for the report that arrived while it did');
			}
		} else {
			let summarized = 0;
			for (const { value } of raw.primaryStore.getRange({ start: false, end: Infinity }))
				for (const metric of value.metrics)
					if (metric.metric === 'summary-exit-probe' && Array.isArray(metric.distribution)) summarized++;
			assert.strictEqual(summarized, METRICS, 'the queued report reached the store before exit');
		}
		process.exit(0);
	})
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
