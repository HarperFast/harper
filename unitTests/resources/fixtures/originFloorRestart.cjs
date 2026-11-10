// Child process (and worker) half of originFloorRestart.test.js: each run is a fresh process, so the clock
// starts from the wall clock as after a restart, and a raise cannot leak into other test files.
const { isMainThread, parentPort, workerData, Worker } = require('node:worker_threads');
if (isMainThread) require('../../mocha.init.js');
const fs = require('node:fs');
const path = require('node:path');
const { setupTestDBPath } = require('../../testUtils');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { claimLocalKey } = require('#src/resources/originClosedFloor');
const {
	coverLocalIssuance,
	persistOriginClosedFloor,
	readLocalIssuanceCeiling,
	readOriginClosedFloor,
} = require('#src/resources/auditStore');
const { RocksDatabase, Transaction } = require('../../rocksdbBindings.mts').rocksdbBindings();

function open(dir, database) {
	setupTestDBPath();
	env.setProperty(CONFIG_PARAMS.DATABASES, { ...env.get(CONFIG_PARAMS.DATABASES), [database]: { path: dir } });
	setMainIsWorker(true);
	return table({
		table: 'RestartFloor',
		database,
		audit: true,
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
	});
}

function localKeyOf(Tbl, id, start) {
	for (const entry of Tbl.auditStore.getRange({ start, exclusiveStart: true, log: 0 }))
		if (entry.recordId === id) return entry.txnLogKey;
}

async function seed({ dir, database, floorLead, ceilingLead }) {
	const Tbl = open(dir, database);
	await Tbl.put({ id: 'before-restart', n: 0 });
	if (floorLead) persistOriginClosedFloor(Tbl.auditStore, Date.now() + floorLead);
	// coverage reserves a second of headroom above the key it covers
	if (ceilingLead) coverLocalIssuance(Tbl.auditStore, Date.now() + ceilingLead - 1000);
	return { floor: readOriginClosedFloor(Tbl.auditStore), ceiling: readLocalIssuanceCeiling(Tbl.auditStore) };
}

async function restart({ dir, database }) {
	const Tbl = open(dir, database);
	const root = Tbl.primaryStore.rootStore;
	const bound = Math.max(readOriginClosedFloor(Tbl.auditStore), readLocalIssuanceCeiling(Tbl.auditStore));
	const wall = Date.now();
	await Tbl.put({ id: 'after-restart', n: 1 });
	const putKey = localKeyOf(Tbl, 'after-restart', 0);
	const resumedKey = localKeyOf(Tbl, 'after-restart', bound);
	// an unreserved native handle, appending to `local` directly
	const raw = new Transaction(Tbl.primaryStore.store);
	const rawTimestamp = raw.getTimestamp();
	const log = root.useLog('local');
	log.addEntry(Buffer.from('unreserved'), raw.id);
	raw.commitSync();
	const rawLogKeys = [...log.query({ start: bound, exclusiveStart: true })]
		.filter((entry) => entry.data.toString() === 'unreserved')
		.map((entry) => entry.timestamp);
	const worker = await new Promise((resolve, reject) => {
		const thread = new Worker(__filename, { workerData: { mode: 'worker', dir, database } });
		thread.once('message', resolve);
		thread.once('error', reject);
	});
	return { bound, wall, putKey, resumedKey, rawTimestamp, rawLogKeys, worker };
}

async function workerRun({ dir, database }) {
	// the first timestamp this thread mints, before it opens the floored database itself
	const scratchPath = fs.mkdtempSync(path.join(dir, 'scratch-'));
	const scratch = RocksDatabase.open(scratchPath);
	const firstMint = scratch.getMonotonicTimestamp();
	scratch.close();
	const Tbl = open(dir, database);
	await Tbl.put({ id: 'worker-write', n: 2 });
	return { firstMint, putKey: localKeyOf(Tbl, 'worker-write', 0) };
}

function refusedOpen({ dir, database }) {
	const errors = [];
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			open(dir, database);
			errors.push(null);
		} catch (error) {
			errors.push(error.message);
		}
	}
	return { errors };
}

async function crossDatabase({ dir, lead }) {
	const A = open(dir, 'crossA');
	const B = open(dir, 'crossB');
	await B.put({ id: 'warm', n: 0 });
	const claimed = claimLocalKey(A.primaryStore.rootStore, Date.now() + lead);
	await B.put({ id: 'ahead', n: 1 });
	return { claimed, key: localKeyOf(B, 'ahead', 0), ceiling: readLocalIssuanceCeiling(B.auditStore) };
}

async function reopenB({ dir }) {
	const B = open(dir, 'crossB');
	const wall = Date.now();
	await B.put({ id: 'after-reopen', n: 2 });
	return { wall, key: localKeyOf(B, 'after-reopen', 0) };
}

const modes = { seed, restart, refusedOpen, crossDatabase, reopenB };

if (!isMainThread) {
	workerRun(workerData).then((result) => {
		parentPort.postMessage(result);
		process.exit(0);
	});
} else {
	const options = JSON.parse(process.argv[2]);
	Promise.resolve(modes[options.mode](options)).then(
		(result) => process.send({ type: 'result', result }, () => options.hold || process.exit(0)),
		(error) => process.send({ type: 'error', message: error.stack }, () => process.exit(1))
	);
}
