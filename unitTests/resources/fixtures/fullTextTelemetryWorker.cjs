'use strict';
const { parentPort, threadId, workerData } = require('node:worker_threads');
workerData.noServerStart = true;
require('#src/server/threads/manageThreads');
const env = require('#src/utility/environment/environmentManager');
env.initSync();
const { loadFullTextNativeBinding } = require('#src/resources/indexes/fullTextNativeBinding');
const analytics = require('#src/resources/analytics/write');
const {
	initializeFullTextTelemetry,
	registerNativeFullTextTelemetry,
	subscribeFullTextTelemetry,
	fullTextTelemetryCollector,
} = require('#src/resources/analytics/fullTextTelemetryRuntime');
const { waitFor } = require('../../waitFor');
let writer;
let removeConsumer;
let barrier;
let pendingFailure;

parentPort.on('message', ({ id, command, ...options }) => {
	if (!command) return;
	void (async () => {
		if (command === 'produce') {
			env.setProperty('analytics_fullText', { enabled: true, intervalMilliseconds: 60_000 });
			initializeFullTextTelemetry();
			analytics.setAnalyticsEnabled(true);
			await waitFor(() => fullTextTelemetryCollector.collecting, 5000);
			const binding = await loadFullTextNativeBinding();
			writer = await binding.openNativeFullTextIndex({
				path: options.path,
				indexId: options.label,
				generation: 'generation-1',
				fields: [{ name: 'title' }],
				analyzer: 'english@2',
				positions: true,
				limits: {
					indexingThreads: 2,
					searchThreads: 2,
					writerMemoryBytes: 64 * 1024 * 1024,
					maxQueuedCommands: 16,
					maxQueuedBytes: 64 * 1024 * 1024,
					maxBatchBytes: 8 * 1024 * 1024,
				},
			});
			registerNativeFullTextTelemetry(writer, options.label, 'writer');
			await writer.applyMutationBatch({
				upserts: [{ id: 'widget', fields: { title: 'catalog widget' } }],
				deletes: [],
			});
			await writer.publish('worker-telemetry');
			barrier = new Int32Array(options.barrier);
			let paused = false;
			removeConsumer = subscribeFullTextTelemetry(
				(sample) => {
					if (paused || sample.index !== options.label || !sample.snapshot?.available) return;
					paused = true;
					fullTextTelemetryCollector.beforeClose(writer);
					parentPort.postMessage({
						event: 'sample-before-main-policy',
						sampledAt: sample.sampledAt,
						threadId,
						completed: sample.snapshot.native.operations.applyFrame.completed.toString(),
					});
					// Hold only this synthetic worker's timer turn until main has applied its operator policy.
					if (Atomics.wait(barrier, 0, 0, 10_000) === 'timed-out')
						pendingFailure = new Error('Main did not release telemetry report ordering barrier');
				},
				{ intervalMilliseconds: 60_000 }
			);
			fullTextTelemetryCollector.collect(writer);
			if (pendingFailure) throw pendingFailure;
			return { paused: true, threadId };
		}
		if (command === 'close') {
			if (writer) {
				fullTextTelemetryCollector.beforeClose(writer);
				await writer.close({ mode: 'rollback' });
				fullTextTelemetryCollector.afterClose(writer);
				writer = undefined;
			}
			removeConsumer?.();
			fullTextTelemetryCollector.stop();
			return { closed: true };
		}
		throw new Error(`Unknown telemetry worker command '${command}'`);
	})().then(
		(result) => parentPort.postMessage({ id, result }),
		(error) => parentPort.postMessage({ id, error: { message: error.message, code: error.code } })
	);
});
parentPort.ref();
