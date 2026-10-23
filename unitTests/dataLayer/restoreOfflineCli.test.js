'use strict';

const testUtils = require('../testUtils');
testUtils.preTestPrep();

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { SYSTEM_TABLE_NAMES } = require('#src/utility/hdbTerms');
const {
	closeDatabase,
	closeLoadedDatabases,
	getDatabases,
	resetDatabases,
	resolveDatabasePath,
} = require('#src/resources/databases');
const { setAnalyticsEnabled } = require('#src/resources/analytics/write');
const { backupDirForDatabase, createBackupOffline, getBackupsRoot } = require('#src/dataLayer/rocksdbBackup');
const { checkRestoreState } = require('#src/dataLayer/restoreMarker');
const harperDatabase = require('./fixtures/harperDatabase.js');
const { clearRestoreDebris, readRecord, restoreDebris } = harperDatabase;

const describeUnlessLmdb = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? describe.skip : describe;
const PEER = 'restore-offline-cli-peer';

// `harper restore_backup` with the server stopped: a fresh process that has loaded no database, on an
// install whose `system` database exists and is closed, restoring a user database in place.
describeUnlessLmdb('offline restore_backup in a fresh CLI process', function () {
	this.timeout(60000);
	const name = `restore_offline_cli_${process.pid}`;
	const corruptSibling = `${name}_corrupt`;
	let scriptDir;

	before(async function () {
		testUtils.setupTestDBPath();
		setAnalyticsEnabled(false);
		await testUtils.ensureSystemTables();
		scriptDir = mkdtempSync(join(tmpdir(), 'harper.unit-test.restore-offline-cli-'));
	});

	afterEach(async function () {
		await closeLoadedDatabases();
		rmSync(resolveDatabasePath(corruptSibling), { recursive: true, force: true });
		clearRestoreDebris(resolveDatabasePath(name), backupDirForDatabase(name));
		rmSync(backupDirForDatabase(name), { recursive: true, force: true });
	});

	after(async function () {
		setAnalyticsEnabled(true);
		rmSync(scriptDir, { recursive: true, force: true });
		// what the next suite expects: system open
		resetDatabases();
	});

	/** As a stopped server leaves them: `system` is not enumerable, so closeLoadedDatabases skips it. */
	async function closeEverything() {
		await closeLoadedDatabases();
		await closeDatabase('system');
	}

	/** A database with a backup, then a write the backup lacks; every handle in this process closed. */
	async function seed() {
		await harperDatabase.writeRecords(name, [['alpha', { n: 1 }]]);
		const { backup_id: backupId } = await createBackupOffline(name);
		await harperDatabase.writeRecords(name, [['after-backup', { kept: true }]]);
		await closeEverything();
		return backupId;
	}

	/** What bin/backup.ts runs once it finds the local server stopped, in a process of its own. */
	async function restoreInFreshProcess(backupId) {
		const script = join(scriptDir, 'restore.cjs');
		writeFileSync(
			script,
			`
			const env = require(${JSON.stringify(require.resolve('#src/utility/environment/environmentManager'))});
			env.initSync();
			env.setProperty('storage.backupPath', ${JSON.stringify(getBackupsRoot())});
			const { restoreBackupOffline } = require(${JSON.stringify(require.resolve('#src/dataLayer/rocksdbBackup'))});
			const { databasesLoaded } = require(${JSON.stringify(require.resolve('#src/resources/databases'))});
			const report = (outcome) => process.stdout.write(JSON.stringify({ ...outcome, scanned: databasesLoaded() === true }));
			restoreBackupOffline(${JSON.stringify(name)}, ${backupId}).then(
				(result) => { report({ result }); process.exit(0); },
				(error) => { report({ error: error.message, statusCode: error.statusCode }); process.exit(1); }
			);
		`
		);
		const child = spawn(process.execPath, [script], { timeout: 45000 });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (data) => (stdout += data));
		child.stderr.on('data', (data) => (stderr += data));
		const code = await new Promise((resolve, reject) => {
			child.once('error', reject);
			child.once('exit', (exitCode, signal) => resolve(signal ?? exitCode));
		});
		try {
			return { code, ...JSON.parse(stdout) };
		} catch {
			assert.fail(`the restore process exited ${code} without a report: ${stdout}\n${stderr}`);
		}
	}

	async function assertRestored() {
		assert.strictEqual(checkRestoreState(resolveDatabasePath(name)), 'clear');
		assert.deepStrictEqual(restoreDebris(resolveDatabasePath(name), backupDirForDatabase(name)), []);
		assert.deepStrictEqual(await readRecord(name, 'alpha'), { n: 1 });
		assert.strictEqual(await readRecord(name, 'after-backup'), undefined, 'the restore took effect');
	}

	it('restores an existing database in place without opening it before the restore child does', async function () {
		const backupId = await seed();
		const outcome = await restoreInFreshProcess(backupId);
		assert.strictEqual(outcome.code, 0, `the restore failed: ${outcome.error}`);
		assert.strictEqual(outcome.result.backup_id, backupId);
		assert.strictEqual(outcome.scanned, false, 'the offline CLI never scans, so never opens, the databases');
		await assertRestored();
	});

	it('is not stopped by a corrupt sibling database it has no reason to open', async function () {
		const backupId = await seed();
		const sibling = resolveDatabasePath(corruptSibling);
		mkdirSync(sibling, { recursive: true });
		writeFileSync(join(sibling, 'CURRENT'), 'MANIFEST-000001\n');
		writeFileSync(join(sibling, 'MANIFEST-000001'), Buffer.alloc(4096, 0x5a));
		const outcome = await restoreInFreshProcess(backupId);
		rmSync(sibling, { recursive: true, force: true });
		assert.strictEqual(outcome.code, 0, `the restore failed: ${outcome.error}`);
		await assertRestored();
	});

	it('refuses on a node whose system database lists a replication peer, changing nothing', async function () {
		const backupId = await seed();
		resetDatabases();
		const nodes = getDatabases().system[SYSTEM_TABLE_NAMES.NODE_TABLE_NAME];
		await nodes.put({ name: PEER });
		await closeEverything();
		let outcome;
		try {
			outcome = await restoreInFreshProcess(backupId);
		} finally {
			resetDatabases();
			await getDatabases().system[SYSTEM_TABLE_NAMES.NODE_TABLE_NAME].delete(PEER);
			await closeEverything();
		}
		assert.strictEqual(outcome.code, 1);
		assert.strictEqual(outcome.statusCode, 409, outcome.error);
		assert.match(outcome.error, new RegExp(`replication peers \\(${PEER}\\)`));
		assert.strictEqual(checkRestoreState(resolveDatabasePath(name)), 'clear');
		assert.deepStrictEqual(restoreDebris(resolveDatabasePath(name), backupDirForDatabase(name)), []);
		assert.deepStrictEqual(await readRecord(name, 'after-backup'), { kept: true }, 'nothing was restored');
	});
});
