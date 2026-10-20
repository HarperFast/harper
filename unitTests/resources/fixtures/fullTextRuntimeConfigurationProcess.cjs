const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { getFullTextRuntimeConfiguration } = require('#src/resources/indexes/fullTextRuntimeConfiguration');
const { resolveFullTextSearchLimits } = require('#src/resources/indexes/fullTextSearchLimits');

async function run() {
	if (process.argv[3] === 'unmanaged') {
		const { Worker } = require('node:worker_threads');
		const result = await new Promise((resolve, reject) => {
			const worker = new Worker(
				`
				const { parentPort } = require('node:worker_threads');
				require('#src/resources/indexes/fullTextNativeBinding').loadFullTextNativeBinding().then(
					() => parentPort.postMessage('ready'),
					(error) => { throw error; }
				);
			`,
				{ eval: true }
			);
			worker.once('message', resolve);
			worker.once('error', reject);
		});
		console.log(JSON.stringify({ unmanaged: result }));
		return;
	}
	const maxSearchThreads = Number(process.argv[2]);
	env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT, { runtime: { maxSearchThreads } });
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
