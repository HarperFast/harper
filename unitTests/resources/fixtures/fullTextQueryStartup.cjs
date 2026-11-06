const { materializePerPidRoot, removePerPidRoot } = require('../../perPidRoot.js');
const { basename } = require('node:path');
process.env.ROOTPATH = materializePerPidRoot();
process.on('exit', removePerPidRoot);

async function run() {
	const startupOnly = process.argv[3] === 'initialize';
	const startup = startupOnly
		? require('#src/resources/indexes/fullTextNativeBinding').initializeFullTextQueryPolicy
		: require('#src/server/threads/socketRouter').startHTTPThreads;
	const env = require('#src/utility/environment/environmentManager');
	const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
	env.setProperty(
		CONFIG_PARAMS.STORAGE_FULL_TEXT_QUERY,
		process.argv[2] === 'undefined' ? undefined : JSON.parse(process.argv[2])
	);
	env.setProperty(CONFIG_PARAMS.THREADS_V8FLAGS, 'fulltext-startup-sentinel');
	try {
		await startup(0);
		if (!startupOnly) throw new Error('Startup passed the invalid V8 sentinel');
		const nativeLoadedAtStartup = process.report
			.getReport()
			.sharedObjects.some((file) => /^fulltext(?:\..*)?\.node$/i.test(basename(file)));
		let nativeUnavailable = false;
		try {
			await (await import('@harperfast/fulltext/native')).runtimeInfo();
		} catch {
			nativeUnavailable = true;
		}
		return { initialized: true, nativeUnavailable, nativeLoadedAtStartup };
	} catch (error) {
		if (startupOnly) throw error;
		return { error: error.message };
	}
}

run().then(
	(result) => {
		process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(0));
	},
	(error) => {
		process.stderr.write(String(error.stack ?? error) + '\n', () => process.exit(1));
	}
);
