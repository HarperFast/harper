/** A restore gives the database a new generation, so nothing minted before it resumes (harper#2451). */
const assert = require('node:assert');
const { rmSync } = require('node:fs');
const { setupTestDBPath } = require('../testUtils');
const { table, closeDatabase } = require('#src/resources/databases');
const { createBackupOffline, restoreBackupOffline, backupDirForDatabase } = require('#src/dataLayer/rocksdbBackup');
const { getAuditFloor, getDatabaseGeneration, isResumablePosition } = require('#src/resources/auditStore');
const { DatabaseGenerationChangedError } = require('#src/utility/errors/hdbError');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

describe('A restore starts a new database generation', function () {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return; // restore_backup is RocksDB-only
	let sequence = 0;
	const databases = [];
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});
	after(() => {
		for (const database of databases) rmSync(backupDirForDatabase(database), { recursive: true, force: true });
	});

	/** A database with one write in its backup and one after it. */
	async function backedUpDatabase() {
		const database = `restore_generation_${++sequence}`;
		databases.push(database);
		const open = () =>
			table({
				table: 'Restored',
				database,
				audit: true,
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
			});
		// Backed up while open, so the database is closed exactly once before the restore: a second
		// close after a reopen in the same process leaves the root handle registered. Flushed first,
		// because `table()`'s on-demand reopen does not replay the transaction log the way a server
		// reload does.
		const T = open();
		await T.put('A', { value: 1 });
		await T.auditStore.rootStore.flush({ allowWriteStall: true });
		const { backup_id: backupId } = await createBackupOffline(database);
		await T.put('A', { value: 2 });
		return { database, open, T, backupId };
	}

	it('ends a live subscription from before the restore instead of resuming it against the restored data', async () => {
		const { database, open, T, backupId } = await backedUpDatabase();
		const events = [];
		const subscription = await T.subscribe({ id: 'A', listener: (event) => events.push(event) });
		assert.ok(await closeDatabase(database));
		await restoreBackupOffline(database, backupId);
		const restored = open();
		assert.strictEqual((await restored.get('A')).value, 1, 'precondition: the restore took effect');
		const current = [];
		await restored.subscribe({ id: 'A', listener: (event) => current.push(event) });
		await restored.put('A', { value: 3 });
		await waitFor(() => current.some((event) => event.value?.value === 3));
		assert.ok(
			!events.some((event) => event.value?.value === 3),
			'the old subscriber must not silently receive the restored database’s writes'
		);
		assert.strictEqual(subscription.closed, true);
	});

	it('refuses a position minted after the backup point, and accepts one minted after the restore', async () => {
		const { database, open, T, backupId } = await backedUpDatabase();
		const before = getDatabaseGeneration(T.auditStore);
		const cursor = Date.now();
		assert.strictEqual(isResumablePosition(T.auditStore, before.id, cursor), true, 'precondition');
		const floor = getAuditFloor(T.auditStore);
		const events = [];
		await T.subscribe({ id: 'A', listener: (event) => events.push(event) });
		assert.ok(await closeDatabase(database));
		await restoreBackupOffline(database, backupId);
		const restored = open();
		const after = getDatabaseGeneration(restored.auditStore);
		assert.notStrictEqual(after.id, before.id);
		assert.ok(after.epoch >= cursor, 'the generation began at the restore');
		assert.strictEqual(isResumablePosition(restored.auditStore, before.id, cursor), false);
		assert.strictEqual(isResumablePosition(restored.auditStore, after.id, Date.now()), true);
		assert.strictEqual(getAuditFloor(restored.auditStore), floor, 'the restore carried its log, so its floor stands');
		assert.ok(events.at(-1) instanceof DatabaseGenerationChangedError, 'the old subscriber is told to resync');
	});

	it('gives a restore into a new database a generation of its own', async () => {
		const { database, T, backupId } = await backedUpDatabase();
		const source = getDatabaseGeneration(T.auditStore);
		const target = `${database}_target`;
		databases.push(target);
		assert.ok(await closeDatabase(database));
		await restoreBackupOffline(database, backupId, target);
		const copy = table({
			table: 'Restored',
			database: target,
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
		});
		assert.notStrictEqual(getDatabaseGeneration(copy.auditStore).id, source.id);
	});
});
