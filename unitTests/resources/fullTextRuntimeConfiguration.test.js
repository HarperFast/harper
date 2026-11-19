const { getFullTextTestConfiguration, setFullTextTestConfiguration } = require('./fullTextTestConfiguration');
require('../testUtils');
const assert = require('node:assert');
const { once } = require('node:events');

const { startWorker, onMessageByType } = require('#src/server/threads/manageThreads');
const { supportsPublishedFullTextBinding } = require('./fullTextNativePlatform');
onMessageByType('full-text-runtime-test-response', () => {});
function response(worker, action, timeout = 60000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => finish(new Error(`Full-text runtime worker did not answer: ${action ?? 'ready'}`)),
			timeout
		);
		const receive = (event) => {
			if (event.type === 'full-text-runtime-test-response') finish(undefined, event.message);
		};
		function finish(error, value) {
			clearTimeout(timer);
			worker.off('message', receive);
			if (error) reject(error);
			else resolve(value);
		}
		worker.on('message', receive);
		if (action)
			worker.postMessage({
				type: 'full-text-runtime-test-command',
				message: { originator: 0, ...(typeof action === 'string' ? { operation: action } : action) },
			});
	});
}

async function terminateWorker(worker) {
	if (!worker || worker.threadId < 0) return;
	const exited = once(worker, 'exit', { signal: AbortSignal.timeout(10000) });
	await Promise.all([exited, worker.terminate()]);
}

describe('full-text native runtime configuration', () => {
	it('keeps one native runtime configuration across replacement workers and their application workers', async function () {
		this.timeout(300000);
		if (!(await supportsPublishedFullTextBinding())) this.skip();
		const { getFullTextRuntimeConfiguration } = require('#src/resources/indexes/fullTextRuntimeConfiguration');
		const { resolveFullTextSearchLimits } = require('#src/resources/indexes/fullTextSearchLimits');
		const runtime = resolveFullTextSearchLimits(getFullTextRuntimeConfiguration()).runtime;
		const previous = getFullTextTestConfiguration();
		const workers = [];
		try {
			for (let n = 0; n < 4; n++) {
				if (n === 1)
					setFullTextTestConfiguration({
						...previous,
						runtime: { maxSearchThreads: runtime.maxSearchThreads + 1 },
					});
				if (n === 2) setFullTextTestConfiguration({ ...previous, requestBudgetMilliseconds: 0 });
				if (n === 3) setFullTextTestConfiguration({ ...previous, runtime: { maxSearchThreads: 0 } });
				const worker = startWorker(require.resolve('./fixtures/fullTextRuntimeConfigurationWorker.js'), {
					name: `full-text-runtime-${n}`,
					autoRestart: false,
					workerIndex: n,
					threadCount: 4,
				});
				workers.push(worker);
				assert.strictEqual((await response(worker)).ready, true);
				const result = await response(worker, 'runtime-configuration');
				assert.deepStrictEqual(result.value?.runtime, runtime, JSON.stringify(result));
				assert.strictEqual(result.value.changedCode, 'E_RESOURCE_LIMIT');
				assert.strictEqual(result.value.rawChildReady, true);
			}
			assert.deepStrictEqual((await response(workers[0], 'runtime-configuration')).value.runtime, runtime);
		} finally {
			setFullTextTestConfiguration(previous);
			for (const worker of workers) await terminateWorker(worker);
		}
	});
});
