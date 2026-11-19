'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { onStartup } = require('#src/utility/lifecycle');

onStartup(() =>
	onStartup(async () => {
		const { loadFullTextNativeBinding } = require('#src/resources/indexes/fullTextNativeBinding');
		const {
			initializeFullTextTelemetry,
			registerNativeFullTextTelemetry,
			fullTextTelemetryCollector,
		} = require('#src/resources/analytics/fullTextTelemetryRuntime');
		const analytics = require('#src/resources/analytics/write');
		const { waitFor } = require('../../waitFor');
		initializeFullTextTelemetry();
		analytics.setAnalyticsEnabled(true);
		await waitFor(() => fullTextTelemetryCollector.collecting, 5000);
		const binding = await loadFullTextNativeBinding();
		const writer = await binding.openNativeFullTextIndex({
			path: workerData.indexPath,
			indexId: workerData.indexLabel,
			generation: 'job-generation',
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
		registerNativeFullTextTelemetry(writer, workerData.indexLabel, 'writer');
		fullTextTelemetryCollector.beforeClose(writer);
		await writer.close({ mode: 'rollback' });
		fullTextTelemetryCollector.afterClose(writer);
		analytics.addAnalyticsListener((_metrics, final) => {
			if (final)
				parentPort.postMessage({
					type: 'job-final-analytics',
					collectorStopped: !fullTextTelemetryCollector.collecting,
				});
		});
	})
);
