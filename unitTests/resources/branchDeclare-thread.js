const { parentPort, workerData } = require('node:worker_threads');
const { setupTestDBPath } = require('../testUtils');
const { reloadBranchAt } = require('#src/resources/databases');
const { getOrCreateBranch } = require('#src/resources/branchDatabase');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

// phase (main -> here): 0 open the branch, 1 the main thread has declared the table. Absent when
// mocha loads this file itself.
const { phase, baseName, appName, tableName } = workerData ?? {};
if (phase) run();

async function run() {
	setupTestDBPath();
	setMainIsWorker(true);
	const branch = await getOrCreateBranch(baseName, appName);
	parentPort.postMessage({ type: 'opened', loaded: Boolean(branch.tables[tableName]) });
	Atomics.wait(phase, 0, 0);
	// what the ITC schema-change handler does on a thread that holds the branch open
	reloadBranchAt(branch.path);
	const Table = branch.tables[tableName];
	const row = Table ? await Table.get('declared-elsewhere') : undefined;
	parentPort.postMessage({
		type: 'reloaded',
		loaded: Boolean(Table),
		attributes: Table ? Table.attributes.map((attribute) => attribute.name) : [],
		note: row?.note ?? null,
	});
}
