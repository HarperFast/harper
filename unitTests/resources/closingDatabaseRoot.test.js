'use strict';

require('../testUtils');
const assert = require('node:assert');
const { join } = require('node:path');
const { mkdirSync } = require('node:fs');
const { setupTestDBPath } = require('../testUtils');
const { closeDatabase, database, databases, resetDatabases, table } = require('#src/resources/databases');
const { DatabaseClosingError } = require('#src/utility/errors/hdbError');
const { ResourceBridge } = require('#src/dataLayer/harperBridge/ResourceBridge');
const env = require('#src/utility/environment/environmentManager');
const terms = require('#src/utility/hdbTerms');

const definition = (databaseName) => ({
	database: databaseName,
	table: 'Items',
	attributes: [
		{ name: 'id', isPrimaryKey: true },
		{ name: 'name', indexed: true },
	],
});

describe('A database root while its close is in flight', function () {
	let testRoot;
	before(() => {
		testRoot = setupTestDBPath();
	});

	it('is skipped by a rescan and refused to an open until the close completes', async () => {
		const databaseName = 'closingRootRescan';
		const neighborName = 'closingRootNeighbor';
		const Items = table(definition(databaseName));
		await Items.put({ id: 1, name: 'one' });
		const Neighbor = table(definition(neighborName));
		await Neighbor.put({ id: 2, name: 'two' });
		const rootStore = Items.primaryStore.rootStore;
		const close = rootStore.close;
		let duringClose;
		rootStore.close = function (...args) {
			rootStore.close = close;
			const closing = close.apply(this, args);
			// a schema change on any thread rescans every database; in production that rescan lands here
			const rescanned = catchError(() => resetDatabases());
			duringClose = {
				rescanError: rescanned instanceof Error ? rescanned : undefined,
				closingItems: rescanned[databaseName]?.Items,
				neighborItems: rescanned[neighborName]?.Items,
				open: catchError(() => database({ database: databaseName })),
				read: (async () => Items.get(1))().catch((error) => error),
			};
			return closing;
		};

		await closeDatabase(databaseName);
		// an LMDB read during the close arms lmdb's read-txn reset timer, which throws once it fires
		await new Promise((resolve) => setTimeout(resolve, 0));

		assert.ok(duringClose, 'precondition: the root close ran through the hook');
		assert.ok(!duringClose.rescanError, `rescan during close: ${duringClose.rescanError?.message}`);
		assert.ok(duringClose.open instanceof DatabaseClosingError, `open during close: ${duringClose.open?.message}`);
		const readError = await duringClose.read;
		assert.ok(readError instanceof DatabaseClosingError, `read during close: ${readError?.message}`);
		assert.ok(duringClose.closingItems === Items, 'the rescan leaves the closing database to its close');
		assert.strictEqual((await duringClose.neighborItems?.get(2))?.name, 'two');
		assert.ok(databases[databaseName] === undefined, 'the close unregisters the database');
		const Reopened = resetDatabases()[databaseName].Items;
		assert.ok(Reopened.primaryStore.rootStore !== rootStore, 'the reopen opens a new root');
		assert.strictEqual((await Reopened.get(1)).name, 'one');
		assert.ok(database({ database: databaseName }));
	});

	it('refuses a declaration from the start of the close, before its handles close', async () => {
		const databaseName = 'closingRootDrain';
		const Items = table(definition(databaseName));
		await Items.put({ id: 1, name: 'one' });
		const auditStore = Items.primaryStore.rootStore.auditStore;
		const stopAuditCleanup = auditStore.stopAuditCleanup;
		let declared;
		auditStore.stopAuditCleanup = function (...args) {
			auditStore.stopAuditCleanup = stopAuditCleanup;
			declared = catchError(() => table({ ...definition(databaseName), table: 'Late' }));
			return stopAuditCleanup.apply(this, args);
		};

		await closeDatabase(databaseName);

		assert.ok(declared instanceof DatabaseClosingError, `declaration during the drain: ${declared?.message}`);
		assert.ok(!resetDatabases()[databaseName].Late, 'the refused declaration created no table');
	});

	it('keeps a closing database on its root through a rescan, so an overlapping close waits for it', async () => {
		const databaseName = 'closingRootTableless';
		const rootStore = database({ database: databaseName });
		const stopAuditCleanup = rootStore.auditStore.stopAuditCleanup;
		let overlapping;
		let refusedMeanwhile;
		rootStore.auditStore.stopAuditCleanup = function (...args) {
			rootStore.auditStore.stopAuditCleanup = stopAuditCleanup;
			resetDatabases();
			overlapping = closeDatabase(databaseName, { requireClosed: true }).then(() => rootStore.status);
			refusedMeanwhile = catchError(() => database({ database: databaseName })) instanceof DatabaseClosingError;
			return stopAuditCleanup.apply(this, args);
		};

		await closeDatabase(databaseName);

		assert.ok(overlapping, 'precondition: the overlapping close started during the first');
		assert.ok(refusedMeanwhile, 'an open is refused while the closes overlap');
		assert.strictEqual(await overlapping, 'closed', 'the overlapping close resolves only once the root is closed');
	});

	it('hands a close that throws partway to the incomplete-close record, which a drop recovers', async () => {
		const databaseName = 'closingRootThrows';
		const Items = table(definition(databaseName));
		await Items.put({ id: 1, name: 'one' });
		const cleanup = Items.cleanup;
		Items.cleanup = function () {
			Items.cleanup = cleanup;
			throw new Error('cleanup failed');
		};

		await assert.rejects(closeDatabase(databaseName), /cleanup failed/);

		assert.ok(catchError(() => database({ database: databaseName })) instanceof DatabaseClosingError);
		await new ResourceBridge().dropSchema({ schema: databaseName });
		const Recreated = table(definition(databaseName));
		await Recreated.put({ id: 2, name: 'two' });
		assert.ok((await Recreated.get(1)) == null, 'the drop removed the old record');
		assert.strictEqual((await Recreated.get(2)).name, 'two');
	});

	it('lets an overlapping close that finishes cleanly clear the record a failed close left', async () => {
		const databaseName = 'closingRootOverlapClean';
		const Items = table(definition(databaseName));
		await Items.put({ id: 1, name: 'one' });
		const auditStore = Items.primaryStore.rootStore.auditStore;
		const stopAuditCleanup = auditStore.stopAuditCleanup;
		const cleanup = Items.cleanup;
		let overlapping;
		auditStore.stopAuditCleanup = function (...args) {
			auditStore.stopAuditCleanup = stopAuditCleanup;
			overlapping = closeDatabase(databaseName);
			Items.cleanup = function () {
				Items.cleanup = cleanup;
				throw new Error('cleanup failed');
			};
			return stopAuditCleanup.apply(this, args);
		};

		await assert.rejects(closeDatabase(databaseName), /cleanup failed/);
		assert.strictEqual(await overlapping, true);

		const Reopened = table(definition(databaseName));
		assert.strictEqual((await Reopened.get(1)).name, 'one');
	});

	it('refuses an alias of a database whose failed close awaits recovery', async () => {
		const storageRoot = join(testRoot, 'closing-alias');
		mkdirSync(storageRoot, { recursive: true });
		env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, storageRoot);
		env.setProperty(terms.CONFIG_PARAMS.DATABASES, {});
		resetDatabases();
		try {
			const Physical = table(definition('closing_physical'));
			await Physical.put({ id: 1, name: 'one' });
			await closeDatabase('closing_physical');
			env.setProperty(terms.CONFIG_PARAMS.DATABASES, { closing_alias: { path: storageRoot } });
			const loaded = resetDatabases();
			assert.ok(loaded.closing_alias?.Items, 'precondition: the alias loads the physical root');
			const Items = loaded.closing_physical.Items;
			const cleanup = Items.cleanup;
			Items.cleanup = function () {
				Items.cleanup = cleanup;
				throw new Error('cleanup failed');
			};

			await assert.rejects(closeDatabase('closing_physical'), /cleanup failed/);

			const opened = catchError(() => database({ database: 'closing_alias' }));
			assert.ok(
				opened instanceof DatabaseClosingError,
				`alias open during recovery: ${opened?.message ?? opened?.path}`
			);
		} finally {
			try {
				await new ResourceBridge().dropSchema({ schema: 'closing_physical' });
			} finally {
				env.setProperty(terms.CONFIG_PARAMS.DATABASES, {});
				setupTestDBPath();
			}
		}
	});
});

function catchError(callback) {
	try {
		return callback();
	} catch (error) {
		return error;
	}
}
