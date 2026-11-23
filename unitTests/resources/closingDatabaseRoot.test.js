'use strict';

require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { closeDatabase, database, databases, resetDatabases, table } = require('#src/resources/databases');
const { DatabaseClosingError } = require('#src/utility/errors/hdbError');

const definition = (databaseName) => ({
	database: databaseName,
	table: 'Items',
	attributes: [
		{ name: 'id', isPrimaryKey: true },
		{ name: 'name', indexed: true },
	],
});

describe('A database root while its close is in flight', function () {
	before(() => setupTestDBPath());

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
		assert.ok(duringClose.open instanceof DatabaseClosingError, `open during close: ${duringClose.open}`);
		const readError = await duringClose.read;
		assert.ok(readError instanceof DatabaseClosingError, `read during close: ${readError}`);
		assert.ok(duringClose.closingItems === Items, 'the rescan leaves the closing database to its close');
		assert.strictEqual((await duringClose.neighborItems?.get(2))?.name, 'two');
		assert.ok(databases[databaseName] === undefined, 'the close unregisters the database');
		const Reopened = resetDatabases()[databaseName].Items;
		assert.ok(Reopened.primaryStore.rootStore !== rootStore, 'the reopen opens a new root');
		assert.strictEqual((await Reopened.get(1)).name, 'one');
		assert.ok(database({ database: databaseName }));
	});
});

function catchError(callback) {
	try {
		return callback();
	} catch (error) {
		return error;
	}
}
