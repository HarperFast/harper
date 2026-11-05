'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { onStartup } = require('#src/utility/lifecycle');
const { onMessageByType } = require('#src/server/threads/manageThreads');
const { closeScopeOnShutdown } = require('#src/components/scopeShutdown');

function waitForMessage(type) {
	return new Promise((resolve) => {
		const listener = (message) => {
			if (message.type !== type) return;
			parentPort.off('message', listener);
			resolve();
		};
		parentPort.on('message', listener);
	});
}

// Run after the configuration startup callbacks, then hold before HTTP starts binding.
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
		const options = {
			path: workerData.indexPath,
			indexId: workerData.indexLabel,
			generation: 'shutdown-generation',
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
		};
		const writer = await binding.openNativeFullTextIndex(options);
		registerNativeFullTextTelemetry(writer, workerData.indexLabel, 'writer');
		await writer.applyMutationBatch({ upserts: [{ id: 'widget', fields: { title: 'widget' } }], deletes: [] });
		const previous = await binding.openNativeFullTextIndex({
			...options,
			path: workerData.indexPath + '-previous',
			indexId: workerData.indexLabel + '-previous',
		});
		registerNativeFullTextTelemetry(previous, workerData.indexLabel + '-previous', 'writer');
		fullTextTelemetryCollector.beforeClose(previous);
		await previous.close({ mode: 'rollback' });
		fullTextTelemetryCollector.afterClose(previous);
		onMessageByType('shutdown', (message) => {
			closeScopeOnShutdown(async () => {
				fullTextTelemetryCollector.beforeClose(writer);
				const released = waitForMessage('release-close');
				parentPort.postMessage({ type: 'native-close-held', collecting: fullTextTelemetryCollector.collecting });
				await released;
				await writer.close({ mode: 'rollback' });
				fullTextTelemetryCollector.afterClose(writer);
				parentPort.postMessage({ type: 'native-closed', state: writer.telemetry().native.state });
			}, message.exitDeadline !== undefined);
		});
		const released = waitForMessage('release-startup');
		parentPort.postMessage({ type: 'native-ready', pending: fullTextTelemetryCollector.hasPendingRows });
		await released;
	})
);
