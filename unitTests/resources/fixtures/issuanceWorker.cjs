const { parentPort, workerData } = require('node:worker_threads');
const { setupTestDBPath } = require('../../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { RocksDatabase } = require('../../rocksdbBindings.mts').rocksdbBindings();
const { RocksTransactionLogStore } = require('#src/resources/RocksTransactionLogStore');
const { seedLocalIssuance, freshLocalKey } = require('#src/resources/originClosedFloor');
const { coverLocalIssuance, readLocalIssuanceCeiling } = require('#src/resources/auditStore');
const { waitFor } = require('../../waitFor');

async function run() {
	setupTestDBPath();
	setMainIsWorker(true);
	const Tbl = table(workerData.definition);
	const root = Tbl.primaryStore.rootStore;
	if (workerData.mode === 'issue') {
		const key = freshLocalKey(root);
		return { key, ceiling: readLocalIssuanceCeiling(Tbl.auditStore) };
	}
	const failedRoot = RocksDatabase.open(workerData.failedPath);
	const failedAudit = new RocksTransactionLogStore(failedRoot);
	failedRoot.close();
	let failures = 0;
	seedLocalIssuance(root, readLocalIssuanceCeiling(Tbl.auditStore), (key) => {
		try {
			return coverLocalIssuance(failedAudit, key);
		} catch (error) {
			failures++;
			throw error;
		}
	});
	const calls = [];
	let releaseFirst;
	const firstResponse = new Promise((resolve) => (releaseFirst = resolve));
	Tbl.sourcedFrom({
		get(id, context) {
			calls.push({ noCacheStore: context.noCacheStore });
			context.noCacheStore = false;
			seedLocalIssuance(root, readLocalIssuanceCeiling(Tbl.auditStore), (key) =>
				coverLocalIssuance(Tbl.auditStore, key)
			);
			const record = { id, n: calls.length };
			return calls.length === 1 ? firstResponse.then(() => record) : record;
		},
	});
	const id = 'coverage-failure';
	const first = Tbl.get(id, {});
	const waiter = Tbl.get(id, {});
	await waitFor(() => calls.length === 1);
	releaseFirst();
	const values = await Promise.all([first, waiter]);
	await waitFor(() => !Tbl.primaryStore.hasLock(id));
	const cached = Tbl.primaryStore.getEntry(id);
	return {
		failures,
		calls,
		values: values.map((value) => ({ n: value.n, version: value.getUpdatedTime() })),
		cached: cached && { n: cached.value.n, version: cached.version },
	};
}

run().then(
	(result) => {
		parentPort.postMessage({ result });
		process.exit(0);
	},
	(error) => {
		parentPort.postMessage({ error: error.stack });
		process.exit(1);
	}
);
