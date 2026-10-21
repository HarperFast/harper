const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { getFullTextRuntimeConfiguration } = require('#src/resources/indexes/fullTextRuntimeConfiguration');
const { resolveFullTextSearchLimits } = require('#src/resources/indexes/fullTextSearchLimits');

async function run() {
	const maxSearchThreads = Number(process.argv[2]);
	env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT, { runtime: { maxSearchThreads } });
	if (process.argv[3] === 'unmanaged' || process.argv[3] === 'early-worker') {
		const { Worker } = require('node:worker_threads');
		const early = process.argv[3] === 'early-worker';
		if (!early) getFullTextRuntimeConfiguration();
		const result = await new Promise((resolve, reject) => {
			const worker = new Worker(
				`
				const { parentPort, workerData } = require('node:worker_threads');
				const env = require('#src/utility/environment/environmentManager');
				const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
				env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT, { runtime: { maxSearchThreads: workerData.maxSearchThreads + 1 } });
				const optionalRuntime = require('#src/resources/indexes/fullTextRuntimeConfiguration').getFullTextRuntimeConfiguration(false);
				require('#src/resources/indexes/fullTextNativeBinding').loadFullTextNativeBinding().then(
					() => parentPort.postMessage('ready'),
					(error) => parentPort.postMessage({ status: error.statusCode, error: error.message, name: error.name, retryable: error.retryable, optionalRuntimeAvailable: optionalRuntime !== undefined })
				);
			`,
				{ eval: true, workerData: { maxSearchThreads } }
			);
			if (early) getFullTextRuntimeConfiguration();
			worker.once('message', resolve);
			worker.once('error', reject);
		});
		await require('#src/resources/indexes/fullTextNativeBinding').loadFullTextNativeBinding();
		console.log(JSON.stringify({ unmanaged: result }));
		return;
	}
	const snapshot = getFullTextRuntimeConfiguration();
	env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT, { runtime: { maxSearchThreads: maxSearchThreads + 1 } });
	if (getFullTextRuntimeConfiguration() !== snapshot) throw new Error('Runtime snapshot changed');
	const runtime = resolveFullTextSearchLimits(snapshot).runtime;
	const { loadFullTextNativeBinding } = require('#src/resources/indexes/fullTextNativeBinding');
	await loadFullTextNativeBinding();
	console.log(JSON.stringify({ runtime }));
}
run().catch((error) => {
	console.log(JSON.stringify({ error: error.message }));
	process.exitCode = 1;
});
