// A fresh process for recordCacheSizing.test.js: the verification table is sized once per process and a
// thread's record cache expirer once per thread, so neither can be observed from inside the suite.
const { createRequire } = require('node:module');
const path = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
const { Worker, isMainThread, workerData, parentPort } = require('node:worker_threads');
const req = createRequire(path.resolve(__dirname, '../../../package.json'));
// the copy Harper's own imports load, compiled or type-stripped; loading the other one as well throws
const rocks = () => req('./unitTests/rocksdbBindings.mts').rocksdbBindings();

const RECORD_CACHE_SIZE = 65536;
const THREADS_COUNT = 3;

const WRITE_BUFFER_MANAGER_SIZE = 64 * 1024 ** 2;

function configure(root, scenario) {
	process.env.ROOTPATH = root;
	process.env.STORAGE_PATH = path.join(root, 'database');
	const env = req('#src/utility/environment/environmentManager');
	const { CONFIG_PARAMS, HDB_SETTINGS_NAMES } = req('#src/utility/hdbTerms');
	env.setProperty(HDB_SETTINGS_NAMES.HDB_ROOT_KEY, root);
	env.setProperty(CONFIG_PARAMS.STORAGE_PATH, path.join(root, 'database'));
	env.setProperty(CONFIG_PARAMS.THREADS_COUNT, THREADS_COUNT);
	env.setProperty('storage_recordCacheSize', RECORD_CACHE_SIZE);
	if (scenario === 'caching-off') env.setProperty(CONFIG_PARAMS.STORAGE_CACHING, false);
	if (scenario === 'preused') {
		// not rocksdb-js's defaults, so its stats show whether Harper's other settings arrived
		env.setProperty(CONFIG_PARAMS.STORAGE_ROCKS_WRITEBUFFERMANAGERSIZE, WRITE_BUFFER_MANAGER_SIZE);
		env.setProperty(CONFIG_PARAMS.STORAGE_ROCKS_WRITEBUFFERMANAGERALLOWSTALL, true);
	}
}

function spyOnRocksConfig(failFirstSizing = false) {
	const calls = [];
	const { RocksDatabase } = rocks();
	const config = RocksDatabase.config;
	RocksDatabase.config = function (options) {
		calls.push({ ...options });
		if (failFirstSizing && 'verificationTableEntries' in options) {
			failFirstSizing = false;
			throw new Error('injected config failure');
		}
		return config.call(this, options);
	};
	return calls;
}

const verificationTableSets = (calls) =>
	calls.filter((options) => 'verificationTableEntries' in options).map((options) => options.verificationTableEntries);

function openCachedStores(databasePath) {
	const { openRocksDatabase } = req('#src/resources/databases');
	const root = openRocksDatabase(databasePath, { disableWAL: false });
	return [
		root,
		openRocksDatabase(databasePath, { name: 'first', cache: true }),
		openRocksDatabase(databasePath, { name: 'second', cache: true }),
	];
}

async function runWorker() {
	configure(workerData.root);
	const calls = spyOnRocksConfig();
	const [root, first, second] = openCachedStores(workerData.databasePath);
	parentPort.postMessage({
		lruSizes: [first.cache.expirer.lruSize, second.cache.expirer.lruSize],
		sharedExpirer: first.cache.expirer === second.cache.expirer,
		verificationTableSets: verificationTableSets(calls),
	});
	for (const store of [second, first, root]) store.close();
}

async function main() {
	const [scenario, root, output] = process.argv.slice(2);
	configure(root, scenario);
	const databasePath = path.join(root, 'database', 'cachesizing');
	mkdirSync(databasePath, { recursive: true });
	const result = {};

	if (scenario === 'preused') {
		// something outside Harper uses the table first, so Harper's request is refused
		const { RocksDatabase } = rocks();
		const outside = RocksDatabase.open(path.join(root, 'outside'), { verificationTable: true });
		outside.populateVersion('key', 1);
		outside.close();
	}
	// Whatever else in the thread constructs weak-lru-cache's default expirer first must not size the
	// record cache: lmdb does on an LMDB database, and so does any cache constructed without options.
	const lmdbStore = req('lmdb').open({ path: path.join(root, 'lmdb'), cache: { validated: true } });
	const defaultCaches = [
		new (req('weak-lru-cache').WeakLRUCache)(),
		new (await import('weak-lru-cache')).WeakLRUCache(),
	];

	const calls = spyOnRocksConfig(scenario === 'config-error');
	if (scenario === 'config-error') {
		try {
			openCachedStores(databasePath);
		} catch (error) {
			result.firstOpenError = error.message;
		}
	}
	const [rootStore, first, second] = openCachedStores(databasePath);
	result.lruSizes = [first.cache.expirer.lruSize, second.cache.expirer.lruSize];
	result.sharedExpirer = first.cache.expirer === second.cache.expirer;
	result.defaultExpirerLruSizes = defaultCaches.map((cache) => cache.expirer.lruSize);
	result.verificationTableSets = verificationTableSets(calls);
	const { bufferSize, allowStall } = rocks().getWriteBufferManagerStats();
	result.writeBufferManager = { bufferSize, allowStall };

	first.populateVersion('used', 1);
	const third = req('#src/resources/databases').openRocksDatabase(databasePath, { name: 'third', cache: true });
	result.verificationTableSetsAfterUse = verificationTableSets(calls);

	if (scenario === 'configured') {
		result.worker = await new Promise((resolve, reject) => {
			const worker = new Worker(__filename, { workerData: { root, databasePath } });
			worker.once('message', resolve);
			worker.once('error', reject);
		});
	}
	for (const store of [third, second, first, rootStore]) store.close();
	await lmdbStore.close();
	writeFileSync(output, JSON.stringify(result));
}

(isMainThread ? main : runWorker)().catch((error) => {
	console.error(error);
	process.exit(1);
});
