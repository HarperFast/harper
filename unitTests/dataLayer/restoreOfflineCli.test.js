'use strict';

const assert = require('node:assert');
const { existsSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { fileLockRelease, tryFileLock } = require('@harperfast/rocksdb-js');
const { restoreChildLockPath } = require('#src/dataLayer/restoreChildRunner');
const { isolatedInstall } = require('./fixtures/isolatedInstall.js');
const { waitFor } = require('../waitFor.js');

const describeUnlessLmdb = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? describe.skip : describe;
const NAME = 'restore_offline_cli';
const PEER = 'restore-offline-cli-peer';

// `harper restore_backup` with the server stopped: a fresh process that has loaded no database, on an
// install whose `system` database exists and is closed, restoring a user database in place. The
// install is one only spawned processes open, so this process's own databases are never touched.
describeUnlessLmdb('offline restore_backup in a fresh CLI process', function () {
	this.timeout(120000);
	let install;

	beforeEach(function () {
		install = isolatedInstall();
	});

	afterEach(function () {
		install?.remove();
	});

	/**
	 * An install as it stands when the server stops: system tables (and a peer row, when asked), a
	 * user database with a backup and then a write the backup lacks, every handle closed by exit.
	 */
	function seed({ peer = false } = {}) {
		return install.runToReport(`
			const m = { databases: require(paths.databases), fixture: require(paths.fixture) };
			await require(paths.mountHdb).default(require(paths.env).getHdbBasePath());
			if (${peer}) await m.databases.getDatabases().system.hdb_nodes.put({ name: ${JSON.stringify(PEER)} });
			await m.fixture.writeRecords(${JSON.stringify(NAME)}, [['alpha', { n: 1 }]]);
			const { backup_id } = await require(paths.rocksdbBackup).createBackupOffline(${JSON.stringify(NAME)});
			await m.fixture.writeRecords(${JSON.stringify(NAME)}, [['after-backup', { kept: true }]]);
			await m.databases.closeLoadedDatabases();
			await m.databases.closeDatabase('system');
			report({ backupId: backup_id });
		`);
	}

	/** What bin/backup.ts runs once it finds the local server stopped. */
	function restore(backupId) {
		return install.runToReport(`
			const { databasesLoaded } = require(paths.databases);
			try {
				const result = await require(paths.rocksdbBackup).restoreBackupOffline(${JSON.stringify(NAME)}, ${backupId});
				report({ result, scanned: databasesLoaded() === true });
			} catch (error) {
				report({ error: error.message, statusCode: error.statusCode, scanned: databasesLoaded() === true });
			}
			`);
	}

	/** The target as the next process to open the install finds it. */
	function inspect() {
		return install.runToReport(`
			const { resolveDatabasePath } = require(paths.databases);
			const { backupDirForDatabase } = require(paths.rocksdbBackup);
			const { checkRestoreState } = require(paths.restoreMarker);
			const fixture = require(paths.fixture);
			const dir = resolveDatabasePath(${JSON.stringify(NAME)});
			report({
				state: checkRestoreState(dir),
				debris: fixture.restoreDebris(dir, backupDirForDatabase(${JSON.stringify(NAME)})),
				alpha: (await fixture.readRecord(${JSON.stringify(NAME)}, 'alpha')) ?? null,
				afterBackup: (await fixture.readRecord(${JSON.stringify(NAME)}, 'after-backup')) ?? null,
			});
			`);
	}

	const restored = { state: 'clear', debris: [], alpha: { n: 1 }, afterBackup: null };

	it('restores an existing database in place without opening it before the restore child does', async function () {
		const { backupId } = await seed();
		const outcome = await restore(backupId);
		assert.strictEqual(outcome.error, undefined, `the restore failed: ${outcome.error}`);
		assert.strictEqual(outcome.result.backup_id, backupId);
		assert.strictEqual(outcome.scanned, false, 'the offline CLI never scans, so never opens, the databases');
		assert.deepStrictEqual(await inspect(), restored);
	});

	it('is not stopped by a corrupt sibling database it has no reason to open', async function () {
		const { backupId } = await seed();
		const sibling = join(install.root, 'database', `${NAME}_corrupt`);
		mkdirSync(sibling);
		writeFileSync(join(sibling, 'CURRENT'), 'MANIFEST-000001\n');
		writeFileSync(join(sibling, 'MANIFEST-000001'), Buffer.alloc(4096, 0x5a));
		const outcome = await restore(backupId);
		// the inspecting process scans, which the sibling would stop
		rmSync(sibling, { recursive: true, force: true });
		assert.strictEqual(outcome.error, undefined, `the restore failed: ${outcome.error}`);
		assert.deepStrictEqual(await inspect(), restored);
	});

	it('refuses on a node whose system database lists a replication peer, changing nothing', async function () {
		const { backupId } = await seed({ peer: true });
		const outcome = await restore(backupId);
		assert.strictEqual(outcome.statusCode, 409, outcome.error);
		assert.match(outcome.error, new RegExp(`replication peers \\(${PEER}\\)`));
		assert.deepStrictEqual(await inspect(), {
			state: 'clear',
			debris: [],
			alpha: { n: 1 },
			afterBackup: { kept: true },
		});
	});

	/**
	 * Runs `restoreCall` in a process that SIGKILLs itself when its child has verified the backup and asks
	 * to purge, before the marker that permits it: what a crash leaves at that point. Returns once the
	 * orphaned child, never permitted to purge, has exited.
	 */
	async function killBeforeMarking(databaseDir, restoreCall) {
		const killed = await install.run(`
			const runner = require(paths.restoreChildRunner);
			const run = runner.runRestoreChild;
			runner.runRestoreChild = (command, args, options) =>
				run(command, args, { ...options, beforeDestruction: () => process.kill(process.pid, 'SIGKILL') });
			const backup = require(paths.rocksdbBackup);
			await ${restoreCall};
			report({ restored: true });
		`);
		assert.strictEqual(killed.signal, 'SIGKILL', `exited ${killed.code}: ${killed.stderr}`);
		await waitFor(() => noRestoreChild(databaseDir), {
			timeout: 15000,
			message: 'the orphaned restore child did not exit',
		});
	}

	function noRestoreChild(databaseDir) {
		const lockPath = restoreChildLockPath(databaseDir);
		if (!existsSync(lockPath)) return true;
		const token = tryFileLock(lockPath);
		if (token === 0) return false;
		fileLockRelease(token);
		return true;
	}

	/** The claim as the next startup's first step finds it, and what that step leaves. */
	function startupPass(databaseName) {
		return install.runToReport(`
			const { databasesLoaded, resolveDatabasePath } = require(paths.databases);
			const { backupDirForDatabase } = require(paths.rocksdbBackup);
			const { checkRestoreState } = require(paths.restoreMarker);
			const { readRestoreReceipt } = require(paths.restoreReceipt);
			const { readBackupPins } = require(paths.backupRepository);
			const dir = resolveDatabasePath(${JSON.stringify(databaseName)});
			const backupDir = backupDirForDatabase(${JSON.stringify(databaseName)});
			const claim = () => ({
				state: checkRestoreState(dir),
				receipt: readRestoreReceipt(dir).receipt?.state ?? null,
				route: readRestoreReceipt(dir).receipt?.route ?? null,
				pins: readBackupPins(backupDir).length,
			});
			const before = claim();
			await require(paths.restoreIntent).finishCommittedRestoresBeforeStartup();
			report({ before, after: claim(), opened: databasesLoaded() === true });
		`);
	}

	for (const route of ['online', 'offline']) {
		it(`drops the claim of an ${route} restore killed before it marked its target, and the database loads as it was`, async function () {
			const { backupId } = await seed();
			const databaseDir = join(install.root, 'database', NAME);
			await killBeforeMarking(
				databaseDir,
				route === 'offline'
					? `backup.restoreBackupOffline(${JSON.stringify(NAME)}, ${backupId})`
					: `backup.restoreBackup({ database: ${JSON.stringify(NAME)}, backup_id: ${backupId} })`
			);

			assert.deepStrictEqual(await startupPass(NAME), {
				before: { state: 'pending', receipt: 'applying', route, pins: 1 },
				after: { state: 'clear', receipt: null, route: null, pins: 0 },
				opened: false,
			});
			assert.deepStrictEqual(await inspect(), {
				state: 'clear',
				debris: [],
				alpha: { n: 1 },
				afterBackup: { kept: true },
			});
		});
	}

	it('drops the claim of an offline restore of system killed before it marked system, before anything opens it', async function () {
		const { systemDir, backupId } = await install.runToReport(`
			const databases = require(paths.databases);
			await require(paths.mountHdb).default(require(paths.env).getHdbBasePath());
			await databases.closeDatabase('system');
			const { backup_id } = await require(paths.rocksdbBackup).createBackupOffline('system');
			report({ systemDir: databases.resolveDatabasePath('system'), backupId: backup_id });
		`);
		await install.runToReport(`
			const databases = require(paths.databases);
			await databases.getDatabases().system.hdb_nodes.put({ name: 'after-backup' });
			await databases.closeDatabase('system');
			report({});
		`);
		await killBeforeMarking(systemDir, `backup.restoreBackupOffline('system', ${backupId})`);

		const loadSystem = `
			const system = require(paths.databases).getDatabases().system;
			report({ before, node: system ? ((await system.hdb_nodes.get('after-backup'))?.name ?? null) : 'not loaded' });
		`;
		// without the pass, startup's scan skips the system database the restore never touched
		assert.deepStrictEqual(await install.runToReport(`const before = null;${loadSystem}`), {
			before: null,
			node: 'not loaded',
		});

		const recovered = await install.runToReport(`
			const { readRestoreReceipt } = require(paths.restoreReceipt);
			const { readBackupPins } = require(paths.backupRepository);
			const claim = () => ({
				receipt: readRestoreReceipt(${JSON.stringify(systemDir)}).receipt?.state ?? null,
				pins: readBackupPins(require(paths.rocksdbBackup).backupDirForDatabase('system')).length,
			});
			const found = claim();
			const opened = require(paths.databases).databasesLoaded() === true;
			await require(paths.restoreIntent).finishCommittedRestoresBeforeStartup();
			const before = { found, opened, left: claim() };
			${loadSystem}
		`);
		assert.deepStrictEqual(recovered, {
			before: { found: { receipt: 'applying', pins: 1 }, opened: false, left: { receipt: null, pins: 0 } },
			node: 'after-backup',
		});
	});
});
