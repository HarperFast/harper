// Child half of the quarantine case in branchDatabase.test.js: rocksdb-js keeps a database whose close-time flush
// failed until the process's shutdown(), so it cannot run in the shared test process.
require('../../mocha.init.js');
const { chmodSync } = require('node:fs');
const { dirname } = require('node:path');
const { setupTestDBPath } = require('../../testUtils');
const {
	assertBranchIdentityAvailable,
	closeBranchDatabases,
	registryEntryAt,
	resolveBranchPath,
	table,
} = require('#src/resources/databases');
const { closeBranchAt, getOrCreateBranch } = require('#src/resources/branchDatabase');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');

const STORE = `${'quarantineApp'.length}_quarantineApp__quarantinebase`;

const failure = (error) => [error.message, ...(error.errors ?? []).map(failure)].join('; ');

function identityHeld() {
	try {
		assertBranchIdentityAvailable(STORE);
		return false;
	} catch {
		return true;
	}
}

async function run() {
	setupTestDBPath();
	setMainIsWorker(true);
	table({ table: 'Rows', database: 'quarantinebase', attributes: [{ name: 'id', isPrimaryKey: true }] });
	const branchPath = resolveBranchPath('quarantinebase', 'quarantineApp');
	const branch = await getOrCreateBranch('quarantinebase', 'quarantineApp');
	await branch.tables.Rows.put({ id: 'unflushed' });
	const appDirectory = dirname(branchPath);
	chmodSync(appDirectory, 0o000);
	let close;
	try {
		close = await closeBranchAt(branchPath).then(() => 'resolved', failure);
	} finally {
		chmodSync(appDirectory, 0o755);
	}
	const result = { close, closeError: registryEntryAt(branch.path)?.closeError, identityHeld: identityHeld() };
	// the handle closeBranchAt dropped is still reachable from worker teardown
	result.retry = await closeBranchDatabases(true).then(() => 'resolved', failure);
	result.identityHeldAfterRetry = identityHeld();
	return result;
}

run().then(
	(result) => process.send({ type: 'result', result }, () => process.exit(0)),
	(error) => process.send({ type: 'error', message: error.stack }, () => process.exit(1))
);
