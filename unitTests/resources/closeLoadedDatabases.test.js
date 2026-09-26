'use strict';

// Regression test for the job-worker RocksDB handle leak that blocked online restore_backup:
// rocksdb-js's registry is process-global across worker threads, and a thread that exits without
// closing leaks its handles (the process-global refCount never drops to zero). Job workers open
// the database graph via getDatabases() and exit per job, so they must release their handles
// explicitly. closeLoadedDatabases() is what jobProcess calls on exit to do that.

require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join, relative, sep } = require('node:path');
const {
	table,
	database,
	getDatabases,
	closeDatabase,
	closeLoadedDatabases,
	resetDatabases,
	openBranchDatabase,
	closeBranchDatabases,
	prepareDatabaseDrop,
	completeDatabaseDropPreparation,
	databases,
} = require('#src/resources/databases');
const { registryStatus, RocksDatabase } = require('@harperfast/rocksdb-js');
const { schema: schemaHandler } = require('#js/server/itc/serverHandlers');
const { OPERATIONS_ENUM } = require('#src/utility/hdbTerms');
const { ResourceBridge } = require('#src/dataLayer/harperBridge/ResourceBridge');
const { dropSchema } = require('#src/dataLayer/schema');
const {
	claimDatabaseDropPreparation,
	databaseDropPreparedWithin,
	handleDatabaseDropPreparationOwnerExit,
	releaseDatabaseDropPreparation,
} = require('#src/resources/databaseDropPreparation');
const {
	getSuspendedDatabaseRootCount,
	databaseCommitsSuspended,
	setDatabaseCommitDrainTimeoutMilliseconds,
	trackOutstandingCommit,
} = require('#src/resources/DatabaseTransaction');

describe('RocksDB handle release', function () {
	before(function () {
		setupTestDBPath();
	});

	function openRocksDb(databaseName) {
		const T = table({
			table: 'pkg',
			database: databaseName,
			attributes: [{ attribute: 'id', isPrimaryKey: true }, { attribute: 'name' }],
		});
		getDatabases();
		return T.primaryStore.rootStore;
	}

	function refCountFor(dbPath) {
		return registryStatus().find((e) => e.path === dbPath)?.refCount ?? 0;
	}

	it('returns a stable conflict error for a concurrent database drop', function () {
		const databaseName = 'drop_schema_conflict';
		claimDatabaseDropPreparation(databaseName, 'first-drop');
		try {
			assert.throws(
				() => claimDatabaseDropPreparation(databaseName, 'second-drop'),
				(error) =>
					error.name === 'DatabaseDroppingError' &&
					error.code === 'DATABASE_DROP_IN_PROGRESS' &&
					error.statusCode === 409
			);
		} finally {
			releaseDatabaseDropPreparation(databaseName, 'first-drop');
		}
	});

	it('normalizes directory spellings when checking a drop fence', function () {
		const rootPath = join(process.cwd(), 'prepared-root', 'database');
		const preparationId = 'normalized-drop-path';
		claimDatabaseDropPreparation(rootPath, preparationId);
		try {
			assert.strictEqual(databaseDropPreparedWithin(dirname(rootPath) + sep), true);
			assert.strictEqual(databaseDropPreparedWithin(relative(process.cwd(), dirname(rootPath))), true);
		} finally {
			releaseDatabaseDropPreparation(rootPath, preparationId);
		}
	});

	it('closeDatabase releases all of a database’s native handles (refCount → 0)', async function () {
		this.timeout(30000);
		const suspendedBefore = getSuspendedDatabaseRootCount();
		const rootStore = openRocksDb('closerelease1');
		if (!(rootStore instanceof RocksDatabase)) return this.skip();
		const dbPath = rootStore.path;
		assert.ok(refCountFor(dbPath) > 0, 'database should be open before close');

		await closeDatabase('closerelease1');

		assert.strictEqual(refCountFor(dbPath), 0, 'no native handles should remain after closeDatabase');
		assert.strictEqual(
			getSuspendedDatabaseRootCount(),
			suspendedBefore,
			'a closed root must not keep the process-wide active-suspension fast path engaged'
		);
	});

	it('keeps database handles open when an outstanding commit misses the drain deadline', async function () {
		this.timeout(30000);
		const databaseName = 'close_drain_timeout';
		const rootStore = openRocksDb(databaseName);
		if (!(rootStore instanceof RocksDatabase)) return this.skip();
		let settle;
		const pending = new Promise((resolve) => (settle = resolve));
		trackOutstandingCommit(pending, { rootStore });
		const previousTimeout = setDatabaseCommitDrainTimeoutMilliseconds(10);
		try {
			await assert.rejects(
				closeDatabase(databaseName),
				(error) => error.code === 'DATABASE_DRAIN_TIMEOUT' && error.retryable === true
			);
			assert.ok(refCountFor(rootStore.path) > 0, 'a drain timeout must occur before native handles close');
			assert.strictEqual(databases[databaseName].pkg.primaryStore.rootStore, rootStore);
		} finally {
			setDatabaseCommitDrainTimeoutMilliseconds(previousTimeout);
			settle();
			await pending;
			await closeDatabase(databaseName);
		}
	});

	it('restores admission when audit cleanup cannot settle before handle teardown', async function () {
		this.timeout(30000);
		const databaseName = 'close_audit_cleanup_failure';
		const rootStore = openRocksDb(databaseName);
		if (!(rootStore instanceof RocksDatabase)) return this.skip();
		const suspendedBefore = getSuspendedDatabaseRootCount();
		const stopAuditCleanup = rootStore.auditStore.stopAuditCleanup;
		rootStore.auditStore.stopAuditCleanup = () => Promise.reject(new Error('audit cleanup failed'));

		await assert.rejects(closeDatabase(databaseName), /audit cleanup failed/);

		assert.strictEqual(databases[databaseName].pkg.primaryStore.rootStore, rootStore);
		assert.strictEqual(databaseCommitsSuspended(rootStore), false);
		assert.strictEqual(getSuspendedDatabaseRootCount(), suspendedBefore);
		rootStore.auditStore.stopAuditCleanup = stopAuditCleanup;
		await closeDatabase(databaseName);
	});

	it('a drop-schema preparation event closes the peer database before acknowledging', async function () {
		this.timeout(30000);
		const databaseName = 'drop_schema_prepare';
		const dropPreparationId = 'drop-schema-prepare-test';
		const rootStore = openRocksDb(databaseName);
		if (!(rootStore instanceof RocksDatabase)) return this.skip();

		await schemaHandler({
			type: 'schema',
			message: {
				originator: process.pid,
				operation: OPERATIONS_ENUM.DROP_SCHEMA,
				schema: databaseName,
				prepareDrop: true,
				dropPreparationId,
				dropPreparationOwnerThreadId: 0,
			},
		});

		assert.strictEqual(databases[databaseName], undefined);
		assert.strictEqual(refCountFor(rootStore.path), 0);
		assert.throws(
			() => database({ database: databaseName }),
			(error) => error.code === 'DATABASE_CLOSING'
		);

		await schemaHandler({
			type: 'schema',
			message: {
				originator: process.pid,
				operation: OPERATIONS_ENUM.DROP_SCHEMA,
				schema: databaseName,
				dropPreparationId,
			},
		});
		assert.ok(database({ database: databaseName }));
		await closeDatabase(databaseName);
	});

	it('a peer preparation reports close failures and stays fenced until completion', async function () {
		this.timeout(30000);
		const databaseName = 'drop_schema_close_failure';
		const dropPreparationId = 'drop-schema-close-failure-test';
		const rootStore = openRocksDb(databaseName);
		const suspendedBefore = getSuspendedDatabaseRootCount();
		const close = rootStore.close;
		rootStore.close = () => {
			throw new Error('root close failed');
		};

		await assert.rejects(
			schemaHandler({
				type: 'schema',
				message: {
					originator: process.pid,
					operation: OPERATIONS_ENUM.DROP_SCHEMA,
					schema: databaseName,
					prepareDrop: true,
					dropPreparationId,
					dropPreparationOwnerThreadId: 0,
				},
			}),
			/Could not prepare database/
		);
		assert.throws(
			() => database({ database: databaseName }),
			(error) => error.code === 'DATABASE_CLOSING'
		);
		assert.strictEqual(
			databases[databaseName]?.pkg,
			undefined,
			'a partially closed graph must not remain available through a table'
		);
		assert.strictEqual(databaseCommitsSuspended(rootStore), true, 'the abandoned root must remain fenced');
		assert.strictEqual(
			getSuspendedDatabaseRootCount(),
			suspendedBefore,
			'an abandoned root must not retain the process-wide active-fence fast path'
		);
		rootStore.close = close;
		await schemaHandler({
			type: 'schema',
			message: {
				originator: process.pid,
				operation: OPERATIONS_ENUM.DROP_SCHEMA,
				schema: databaseName,
				dropPreparationId,
			},
		});
		assert.throws(
			() => database({ database: databaseName }),
			(error) => error.code === 'DATABASE_CLOSING',
			'a failed native close must remain fenced after the failed preparation is released'
		);
		await new ResourceBridge().dropSchema({ schema: databaseName });
		assert.strictEqual(
			refCountFor(rootStore.path),
			0,
			`a same-worker drop retry must release the stranded native wrapper (${rootStore.status}): ${JSON.stringify(registryStatus())}`
		);
		assert.strictEqual(databases[databaseName], undefined);
	});

	it('keeps admission fenced when completion arrives before preparation finishes closing', async function () {
		this.timeout(30000);
		const databaseName = 'drop_schema_late_close';
		const dropPreparationId = 'drop-schema-late-close-test';
		const rootStore = openRocksDb(databaseName);
		const close = rootStore.close;
		let continueClose;
		let closeStarted;
		const started = new Promise((resolve) => (closeStarted = resolve));
		const blocked = new Promise((resolve) => (continueClose = resolve));
		rootStore.close = async () => {
			closeStarted();
			await blocked;
			return close.call(rootStore);
		};

		const preparation = prepareDatabaseDrop(databaseName, dropPreparationId, 0);
		await started;
		let completed = false;
		const completion = completeDatabaseDropPreparation(databaseName, dropPreparationId).then(() => (completed = true));
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(completed, false);
		assert.throws(
			() => database({ database: databaseName }),
			(error) => error.code === 'DATABASE_CLOSING'
		);

		continueClose();
		await Promise.all([preparation, completion]);
		assert.ok(database({ database: databaseName }));
		await closeDatabase(databaseName);
	});

	it('keeps admission fenced until a dead owner’s local preparation settles', async function () {
		this.timeout(30000);
		const databaseName = 'drop_schema_dead_owner_close';
		const dropPreparationId = 'drop-schema-dead-owner-close-test';
		const ownerThreadId = 42;
		const rootStore = openRocksDb(databaseName);
		const close = rootStore.close;
		let continueClose;
		let closeStarted;
		const started = new Promise((resolve) => (closeStarted = resolve));
		const blocked = new Promise((resolve) => (continueClose = resolve));
		rootStore.close = async () => {
			closeStarted();
			await blocked;
			return close.call(rootStore);
		};

		const preparation = prepareDatabaseDrop(databaseName, dropPreparationId, ownerThreadId);
		await started;
		handleDatabaseDropPreparationOwnerExit(ownerThreadId);
		assert.throws(
			() => database({ database: databaseName }),
			(error) => error.code === 'DATABASE_CLOSING'
		);

		continueClose();
		await preparation;
		await new Promise((resolve) => setImmediate(resolve));
		assert.ok(database({ database: databaseName }));
		await completeDatabaseDropPreparation(databaseName, dropPreparationId);
		await closeDatabase(databaseName);
	});

	it('dropSchema coordinates peer preparation before destroying the local database', async function () {
		this.timeout(30000);
		const databaseName = 'drop_schema_coordinated';
		const rootStore = openRocksDb(databaseName);
		if (!(rootStore instanceof RocksDatabase)) return this.skip();

		await new ResourceBridge().dropSchema({ schema: databaseName });

		assert.strictEqual(databases[databaseName], undefined);
		assert.strictEqual(refCountFor(rootStore.path), 0);
	});

	it('the public dropSchema path emits one coordinated completion', async function () {
		this.timeout(30000);
		const databaseName = 'drop_schema_single_completion';
		const rootStore = openRocksDb(databaseName);
		if (!(rootStore instanceof RocksDatabase)) return this.skip();
		let completions = 0;
		const removeListener = schemaHandler.addListener((message) => {
			if (message.operation === OPERATIONS_ENUM.DROP_SCHEMA && message.schema === databaseName) completions++;
		});
		try {
			await dropSchema({ operation: OPERATIONS_ENUM.DROP_SCHEMA, schema: databaseName });
			assert.strictEqual(completions, 1);
		} finally {
			removeListener();
		}
	});

	it('dropSchema destroys a tableless database without tripping its own fence', async function () {
		this.timeout(30000);
		const databaseName = 'drop_schema_tableless';
		const rootStore = database({ database: databaseName });
		if (!(rootStore instanceof RocksDatabase)) return this.skip();
		const suspendedBefore = getSuspendedDatabaseRootCount();

		await new ResourceBridge().dropSchema({ schema: databaseName });

		assert.strictEqual(databases[databaseName], undefined);
		assert.strictEqual(refCountFor(rootStore.path), 0);
		assert.strictEqual(getSuspendedDatabaseRootCount(), suspendedBefore);
	});

	it('dropSchema opens and destroys a tableless database root not attached to this worker’s catalog', async function () {
		this.timeout(30000);
		const databaseName = 'drop_schema_unloaded_tableless';
		const rootStore = database({ database: databaseName });
		if (!(rootStore instanceof RocksDatabase)) return this.skip();
		const dbPath = rootStore.path;
		await closeDatabase(databaseName);
		resetDatabases();
		assert.ok(databases[databaseName], 'the on-disk database should be discovered');
		assert.deepStrictEqual(Object.keys(databases[databaseName]), [], 'no table can expose the root to dropSchema');

		await new ResourceBridge().dropSchema({ schema: databaseName });

		assert.strictEqual(databases[databaseName], undefined);
		assert.strictEqual(refCountFor(dbPath), 0);
	});

	it('closeLoadedDatabases releases every loaded user database (what a job worker does on exit)', async function () {
		this.timeout(30000);
		const a = openRocksDb('closerelease2a');
		const b = openRocksDb('closerelease2b');
		if (!(a instanceof RocksDatabase)) return this.skip();
		assert.ok(refCountFor(a.path) > 0 && refCountFor(b.path) > 0, 'both databases should be open');

		await closeLoadedDatabases();

		assert.strictEqual(refCountFor(a.path), 0, 'database a should be released');
		assert.strictEqual(refCountFor(b.path), 0, 'database b should be released');
	});

	it('closeLoadedDatabases releases a branch database (invisible to the databases map it walks)', async function () {
		this.timeout(30000);
		const rootStore = openRocksDb('closerelease4');
		if (!(rootStore instanceof RocksDatabase)) return this.skip();
		const scratchRoot = mkdtempSync(join(tmpdir(), 'harper.unit-test.branch-close-'));
		const checkpointDir = join(scratchRoot, 'checkpoint');
		try {
			await rootStore.createCheckpoint(checkpointDir);
			const branch = openBranchDatabase(checkpointDir, 'closerelease4', 'appA__closerelease4');
			assert.ok(refCountFor(branch.rootStore.path) > 0, 'branch should be open');
			const suspendedBefore = getSuspendedDatabaseRootCount();

			await closeLoadedDatabases();

			// a branch is not in `databases`, so the walk below cannot reach it — an exiting job worker
			// would leak its handles process-wide unless this is the single teardown entry point
			assert.strictEqual(refCountFor(checkpointDir), 0, 'branch should be released on thread teardown');
			assert.strictEqual(getSuspendedDatabaseRootCount(), suspendedBefore);
		} finally {
			await closeBranchDatabases();
			rmSync(scratchRoot, { recursive: true, force: true });
		}
	});

	it('strict job cleanup reports a branch failure after closing regular databases', async function () {
		this.timeout(30000);
		const rootStore = openRocksDb('closerelease5');
		if (!(rootStore instanceof RocksDatabase)) return this.skip();
		const scratchRoot = mkdtempSync(join(tmpdir(), 'harper.unit-test.branch-close-failure-'));
		const checkpointDir = join(scratchRoot, 'checkpoint');
		let branch;
		const suspendedBefore = getSuspendedDatabaseRootCount();
		try {
			await rootStore.createCheckpoint(checkpointDir);
			branch = openBranchDatabase(checkpointDir, 'closerelease5', 'appA__closerelease5');
			const BranchTable = branch.tables[Object.keys(branch.tables)[0]];
			BranchTable.derivedIndexRuntime = { close: () => Promise.reject(new Error('writer still active')) };

			await assert.rejects(
				closeLoadedDatabases({ requireClosed: true }),
				/Could not close every database during worker teardown/
			);

			assert.strictEqual(refCountFor(rootStore.path), 0, 'regular database handles are still released');
			assert.ok(refCountFor(branch.rootStore.path) > 0, 'the unsafe branch close remains fail-closed');
			assert.strictEqual(getSuspendedDatabaseRootCount(), suspendedBefore);
			BranchTable.derivedIndexRuntime = { close: () => Promise.resolve() };
			await branch.close();
		} finally {
			if (branch && branch.rootStore.status !== 'closed') {
				branch.tables[Object.keys(branch.tables)[0]].derivedIndexRuntime = { close: () => Promise.resolve() };
				await branch.close();
			}
			await closeBranchDatabases();
			rmSync(scratchRoot, { recursive: true, force: true });
		}
	});

	it('closeLoadedDatabases releases a tableless database (root store not reachable via any table)', async function () {
		this.timeout(30000);
		// open a database with no tables: its root store is tracked only on the defined-database
		// entry, so the table-based detection alone would miss it and leak the handle
		const rootStore = database({ database: 'closerelease3' });
		if (!(rootStore instanceof RocksDatabase)) return this.skip();
		const dbPath = rootStore.path;
		assert.ok(refCountFor(dbPath) > 0, 'tableless database should be open');

		await closeLoadedDatabases();

		assert.strictEqual(refCountFor(dbPath), 0, 'tableless database should be released');
	});
});
