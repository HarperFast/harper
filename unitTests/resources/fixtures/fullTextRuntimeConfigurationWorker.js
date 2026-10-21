'use strict';
const { parentPort, threadId, workerData } = require('node:worker_threads');
workerData.noServerStart = true;
const { onMessageByType } = require('#js/server/threads/manageThreads');
onMessageByType('full-text-runtime-test-command', async (event) => {
	try {
		if (event.message.operation === 'runtime-configuration') {
			const { getFullTextRuntimeConfiguration } = require('#src/resources/indexes/fullTextRuntimeConfiguration');
			const { resolveFullTextSearchLimits } = require('#src/resources/indexes/fullTextSearchLimits');
			const { loadFullTextNativeBinding } = require('#src/resources/indexes/fullTextNativeBinding');
			const runtime = resolveFullTextSearchLimits(getFullTextRuntimeConfiguration()).runtime;
			const binding = await loadFullTextNativeBinding();
			binding.configureNativeFullTextRuntime(runtime);
			let changedCode;
			try {
				binding.configureNativeFullTextRuntime({ ...runtime, maxSearchThreads: runtime.maxSearchThreads + 1 });
			} catch (error) {
				changedCode = error.code;
			}
			const { Worker } = require('node:worker_threads');
			const { once } = require('node:events');
			const child = new Worker(
				`
				const { parentPort, workerData } = require('node:worker_threads');
				const env = require('#src/utility/environment/environmentManager');
				const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
				env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT, { runtime: { maxSearchThreads: workerData.maxSearchThreads + 1 } });
				require('#src/resources/indexes/fullTextNativeBinding').loadFullTextNativeBinding().then(
					() => parentPort.postMessage({ ready: true }),
					(error) => parentPort.postMessage({ error: error.message })
				);
			`,
				{ eval: true, workerData: { maxSearchThreads: runtime.maxSearchThreads } }
			);
			const [rawChild] = await once(child, 'message', { signal: AbortSignal.timeout(10000) }).finally(() =>
				child.terminate()
			);
			if (!rawChild.ready) throw new Error(rawChild.error);
			parentPort.postMessage({
				type: 'full-text-runtime-test-response',
				message: { originator: threadId, value: { runtime, changedCode, rawChildReady: rawChild.ready } },
			});
			return;
		}
	} catch (error) {
		parentPort.postMessage({
			type: 'full-text-runtime-test-response',
			message: { originator: threadId, error: String(error) },
		});
	}
});
parentPort.ref();
parentPort.postMessage({ type: 'full-text-runtime-test-response', message: { originator: threadId, ready: true } });
