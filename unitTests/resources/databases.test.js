require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const {
	table,
	flushDatabases,
	dropDatabase,
	closeDatabase,
	database,
	getDatabases,
	resetDatabases,
	quiesceSchemaTarget,
	abortSchemaQuiesce,
	commitSchemaQuiesce,
	renewSchemaQuiesce,
	finishSchemaQuiesce,
	completeSchemaQuiesce,
	expireSchemaQuiesceLeaseForTests,
	recoverCommittedSchemaQuiesceForTests,
} = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { RocksDatabase } = require('@harperfast/rocksdb-js');
const signalling = require('#src/utility/signalling');
const {
	acquireRestoreLock,
	releaseRestoreLock,
	beginRestore,
	completeRestore,
	RESTORE_META_DIR,
} = require('#src/dataLayer/restoreMarker');

describe('flushDatabases', () => {
	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		table({
			table: 'FlushTest',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
	});

	it('flushes all databases without error', async function () {
		await assert.doesNotReject(() => flushDatabases());
	});
});

describe('table() randomAccessFields directive', () => {
	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('defaults to classic structures (struct writes disabled) when the directive is absent', function () {
		const DefaultTable = table({
			table: 'RafDefault',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		const encoder = DefaultTable.primaryStore.encoder;
		assert.ok(!encoder.randomAccessStructure);
		assert.strictEqual(encoder._writeStruct.length, 0, 'expected the no-op write stub');
	});

	it('enables typed random-access structures when @table(randomAccessFields: true)', function () {
		const RafTable = table({
			table: 'RafEnabled',
			database: 'test',
			randomAccessFields: true,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		const encoder = RafTable.primaryStore.encoder;
		assert.strictEqual(encoder.randomAccessStructure, true);
		assert.ok(encoder._writeStruct.length > 0, 'expected the real struct-write hook');
	});
});

describe('schemaDefined backfill on replicas missing the flag', () => {
	const TABLE = 'SchemaDefinedBackfillTest';
	const DB = 'test';

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('heals in-memory and on-disk schemaDefined when an explicit reload sees a stale descriptor', async function () {
		// Create the table without an explicit schemaDefined — it defaults to true on disk.
		const Tbl = table({
			table: TABLE,
			database: DB,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		assert.strictEqual(Tbl.schemaDefined, true, 'fresh table should be schemaDefined=true');

		const dbisDB = Tbl.dbisDB;
		const descriptorKey = TABLE + '/';
		const original = dbisDB.getSync(descriptorKey);
		assert.ok(original, 'primary descriptor should exist after table creation');
		assert.strictEqual(original.schemaDefined, true, 'descriptor should carry schemaDefined=true initially');

		// Simulate a stale replica descriptor: strip schemaDefined from disk and from the live Table.
		// This reproduces the state a replica node was left in after a 4.7.x deploy where the
		// replicated descriptor lacked the flag.
		const stripped = { ...original };
		delete stripped.schemaDefined;
		await dbisDB.put(descriptorKey, stripped);
		Tbl.schemaDefined = undefined;
		assert.strictEqual(
			dbisDB.getSync(descriptorKey).schemaDefined,
			undefined,
			'precondition: descriptor should be missing the flag'
		);
		assert.strictEqual(Tbl.schemaDefined, undefined, 'precondition: in-memory flag should be cleared');

		// Re-enter table() with an explicit schemaDefined: true (as the schema declaration would do
		// on every worker reload). schemaDefinedExplicit=true causes the existing-Table branch to
		// re-assert the in-memory value and to rewrite the on-disk descriptor when there's a mismatch.
		const Rehealed = table({
			table: TABLE,
			database: DB,
			schemaDefined: true,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		assert.strictEqual(Rehealed.schemaDefined, true, 'Table.schemaDefined must be healed in memory');

		await Rehealed.dbisDB.committed;
		const healed = Rehealed.dbisDB.getSync(descriptorKey);
		assert.strictEqual(healed.schemaDefined, true, 'on-disk descriptor must be rewritten with schemaDefined=true');
	});
});

describe('dropDatabase restore serialization', () => {
	const DB = 'drop-vs-restore-test';

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('refuses to drop a RocksDB database while a restore holds its lock, then drops once released', async function () {
		this.timeout(30000);
		const Table = table({
			table: 'DropRestore',
			database: DB,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		const rootStore = Table.primaryStore.rootStore;
		if (!(rootStore instanceof RocksDatabase)) return this.skip(); // serialization is RocksDB-only

		// simulate a restore in progress: it holds the per-database restore lock
		const lock = beginRestore(rootStore.path);
		try {
			await assert.rejects(dropDatabase(DB), (error) => error.statusCode === 409);
		} finally {
			completeRestore(lock);
		}
		// the blocked window may have unloaded the database from the in-memory map (a DB being
		// restored is intentionally not loaded); re-resolve it now that the marker is cleared, then
		// confirm the drop proceeds once the lock is released
		table({ table: 'DropRestore', database: DB, attributes: [{ name: 'id', isPrimaryKey: true }] });
		await assert.doesNotReject(dropDatabase(DB));
	});

	it('drops a multi-table RocksDB database without a spurious lock 409', async function () {
		this.timeout(30000);
		// every table shares one root store / lock path, so the per-table lock must dedupe by path —
		// otherwise the second table would re-acquire the (non-reentrant) lock and 409
		const MULTI = 'drop-multi-table-test';
		const T1 = table({ table: 'One', database: MULTI, attributes: [{ name: 'id', isPrimaryKey: true }] });
		table({ table: 'Two', database: MULTI, attributes: [{ name: 'id', isPrimaryKey: true }] });
		if (!(T1.primaryStore.rootStore instanceof RocksDatabase)) return this.skip();
		await assert.doesNotReject(dropDatabase(MULTI));
	});

	it('rebuilds authoritative registrations after a native close failure', async () => {
		const CLOSE_FAILURE_DB = 'close-failure-recovery-test';
		const Original = table({
			table: 'Records',
			database: CLOSE_FAILURE_DB,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		const originalClose = Original.primaryStore.close;
		Original.primaryStore.close = () => {
			throw new Error('injected close failure');
		};
		try {
			await assert.rejects(
				closeDatabase(CLOSE_FAILURE_DB),
				(error) =>
					error instanceof AggregateError &&
					error.errors.some((closeError) => closeError.cause?.message === 'injected close failure')
			);
		} finally {
			Original.primaryStore.close = originalClose;
		}
		const Recovered = getDatabases()[CLOSE_FAILURE_DB]?.Records;
		assert.ok(Recovered, 'the authoritative catalog should be reloaded after close failure');
		assert.notStrictEqual(Recovered, Original, 'the half-closed table registration must not remain public');
		assert.strictEqual(Recovered.isDropQuiescing(), false, 'the recovered table must be writable again');
	});

	it('never loads the reserved restore-metadata directory as a database', function () {
		// the API can't create a database with this name (schemaRegex rejects the backtick), but the
		// scan opens any CURRENT+MANIFEST directory regardless of name, so it must skip the reserved dir
		const anchor = table({
			table: 'Anchor',
			database: 'scan-skip-test',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		if (!(anchor.primaryStore.rootStore instanceof RocksDatabase)) return this.skip();
		const databasesRoot = dirname(anchor.primaryStore.rootStore.path);

		// plant a directory that looks exactly like a RocksDB database at the reserved path
		const reservedDir = join(databasesRoot, RESTORE_META_DIR);
		mkdirSync(reservedDir, { recursive: true });
		writeFileSync(join(reservedDir, 'CURRENT'), 'MANIFEST-000001\n');
		writeFileSync(join(reservedDir, 'MANIFEST-000001'), '');

		resetDatabases();
		const loaded = getDatabases();
		assert.strictEqual(loaded[RESTORE_META_DIR], undefined, 'reserved dir must not be loaded as a database');
		assert.ok(existsSync(reservedDir), 'the reserved dir itself is left in place (used for lifecycle metadata)');
	});
});

describe('cross-worker schema quiescence', () => {
	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('waits for in-flight table quiescence before authoritative abort recovery', async () => {
		const DB = 'quiesce-abort-wait-test';
		const Table = table({ table: 'Records', database: DB, attributes: [{ name: 'id', isPrimaryKey: true }] });
		const originalQuiesce = Table.quiesceForDrop;
		let releaseQuiesce;
		Table.quiesceForDrop = () => new Promise((resolve) => (releaseQuiesce = resolve));
		const message = {
			operation: 'drop_table',
			schema: DB,
			table: 'Records',
			quiesceId: 'q-abort-wait',
			leaseUntil: Date.now() + 60_000,
		};
		try {
			const quiesce = quiesceSchemaTarget(message);
			await new Promise(setImmediate);
			let abortSettled = false;
			const abort = abortSchemaQuiesce(message).then(() => (abortSettled = true));
			await new Promise(setImmediate);
			assert.strictEqual(abortSettled, false, 'abort must not reset while quiescence is still closing');
			releaseQuiesce();
			const [result] = await Promise.all([quiesce, abort]);
			assert.strictEqual(result.quiesced, false);
			assert.ok(getDatabases()[DB]?.Records, 'authoritative reset must restore a table that was not dropped');
		} finally {
			Table.quiesceForDrop = originalQuiesce;
		}
	});

	it('keeps a schema unavailable until terminal reset completes', async () => {
		const DB = 'quiesce-final-gate-test';
		table({ table: 'Records', database: DB, attributes: [{ name: 'id', isPrimaryKey: true }] });
		const message = {
			operation: 'drop_schema',
			schema: DB,
			quiesceId: 'q-final-gate',
			leaseUntil: Date.now() + 60_000,
		};
		const result = await quiesceSchemaTarget(message);
		assert.strictEqual(result.quiesced, true);
		assert.strictEqual(finishSchemaQuiesce(message), true);
		assert.throws(() => database({ database: DB, table: null }), /closing and cannot be opened/);
		resetDatabases();
		assert.throws(() => database({ database: DB, table: null }), /closing and cannot be opened/);
		completeSchemaQuiesce(message);
		assert.doesNotThrow(() => database({ database: DB, table: null }));
		assert.strictEqual(finishSchemaQuiesce(message), false, 'completed IDs must not re-enter finalization');
	});

	it('accepts a terminal rescan with no local state while rejecting aborted IDs', async () => {
		const DB = 'quiesce-stale-id-test';
		table({ table: 'Records', database: DB, attributes: [{ name: 'id', isPrimaryKey: true }] });
		const message = {
			operation: 'drop_table',
			schema: DB,
			table: 'Records',
			quiesceId: 'q-aborted-terminal',
			leaseUntil: Date.now() + 60_000,
		};
		assert.strictEqual((await quiesceSchemaTarget(message)).quiesced, true);
		await abortSchemaQuiesce(message);
		assert.strictEqual(finishSchemaQuiesce(message), false);
		assert.strictEqual(
			finishSchemaQuiesce({ ...message, quiesceId: 'q-never-quiesced', phase: 'finalize-quiesce' }),
			true,
			'a worker that joined after quiescence must accept the authoritative terminal rescan'
		);
	});

	it('does not re-register a table while resetDatabases runs during quiescence', async () => {
		const DB = 'quiesce-reset-registration-test';
		table({ table: 'Records', database: DB, attributes: [{ name: 'id', isPrimaryKey: true }] });
		const message = {
			operation: 'drop_table',
			schema: DB,
			table: 'Records',
			quiesceId: 'q-reset-registration',
			leaseUntil: Date.now() + 60_000,
		};
		assert.strictEqual((await quiesceSchemaTarget(message)).quiesced, true);
		assert.strictEqual(getDatabases()[DB]?.Records, undefined);
		resetDatabases();
		assert.strictEqual(getDatabases()[DB]?.Records, undefined, 'catalog rescan must not resurrect a quiesced table');
		await abortSchemaQuiesce(message);
		assert.ok(getDatabases()[DB]?.Records, 'abort recovery should reload the authoritative live table');
	});

	it('does not reopen a root store or replay logs while its schema is quiesced', async () => {
		const DB = 'quiesce-reset-root-handle-test';
		const Table = table({ table: 'Records', database: DB, attributes: [{ name: 'id', isPrimaryKey: true }] });
		const rootStore = Table.primaryStore.rootStore;
		const message = {
			operation: 'drop_schema',
			schema: DB,
			quiesceId: 'q-reset-root-handle',
			leaseUntil: Date.now() + 60_000,
		};
		assert.strictEqual((await quiesceSchemaTarget(message)).quiesced, true);
		assert.strictEqual(rootStore.status, 'closed');
		resetDatabases();
		assert.strictEqual(rootStore.status, 'closed', 'catalog scan must not reopen the quiesced root store');
		assert.strictEqual(getDatabases()[DB], undefined, 'schema scan must remain fenced before replay/registration');
		await abortSchemaQuiesce(message);
		assert.ok(getDatabases()[DB]?.Records);
	});

	it('retains a missing-table quiescence until its terminal message', async () => {
		const message = {
			operation: 'drop_table',
			schema: 'quiesce-missing-table-test',
			table: 'Records',
			quiesceId: 'q-missing-table',
			leaseUntil: Date.now() + 60_000,
		};
		assert.strictEqual((await quiesceSchemaTarget(message)).quiesced, true);
		assert.strictEqual(finishSchemaQuiesce(message), true);
		completeSchemaQuiesce(message);
		assert.strictEqual(finishSchemaQuiesce(message), false);
	});

	it('serializes schema and table quiescence hierarchically', async () => {
		const DB = 'quiesce-hierarchy-test';
		const First = table({ table: 'First', database: DB, attributes: [{ name: 'id', isPrimaryKey: true }] });
		table({ table: 'Second', database: DB, attributes: [{ name: 'id', isPrimaryKey: true }] });
		const originalQuiesce = First.quiesceForDrop;
		let releaseFirst;
		First.quiesceForDrop = () => new Promise((resolve) => (releaseFirst = resolve));
		const firstMessage = {
			operation: 'drop_table',
			schema: DB,
			table: 'First',
			quiesceId: 'q-hierarchy-first',
			originLocal: true,
		};
		try {
			const first = quiesceSchemaTarget(firstMessage);
			await new Promise(setImmediate);
			const duplicate = await quiesceSchemaTarget({ ...firstMessage, quiesceId: 'q-hierarchy-duplicate' });
			assert.strictEqual(duplicate.quiesced, false);
			const schema = await quiesceSchemaTarget({
				operation: 'drop_schema',
				schema: DB,
				quiesceId: 'q-hierarchy-schema',
				originLocal: true,
			});
			assert.strictEqual(schema.quiesced, false);
			releaseFirst();
			assert.strictEqual((await first).quiesced, true);
			await abortSchemaQuiesce(firstMessage);
			First.quiesceForDrop = originalQuiesce;

			const schemaMessage = {
				operation: 'drop_schema',
				schema: DB,
				quiesceId: 'q-hierarchy-schema-owner',
				originLocal: true,
			};
			assert.strictEqual((await quiesceSchemaTarget(schemaMessage)).quiesced, true);
			const tableWhileSchema = await quiesceSchemaTarget({
				operation: 'drop_table',
				schema: DB,
				table: 'Second',
				quiesceId: 'q-hierarchy-table-loser',
				originLocal: true,
			});
			assert.strictEqual(tableWhileSchema.quiesced, false);
			await abortSchemaQuiesce(schemaMessage);
		} finally {
			First.quiesceForDrop = originalQuiesce;
		}
	});

	it('stays fail-closed after the commit boundary until a terminal reconcile', async () => {
		const DB = 'quiesce-committed-test';
		const Table = table({ table: 'Records', database: DB, attributes: [{ name: 'id', isPrimaryKey: true }] });
		const message = {
			operation: 'drop_table',
			schema: DB,
			table: 'Records',
			quiesceId: 'q-committed',
			originLocal: true,
		};
		assert.strictEqual((await quiesceSchemaTarget(message)).quiesced, true);
		assert.strictEqual((await commitSchemaQuiesce(message)).committed, true);
		await assert.rejects(() => abortSchemaQuiesce(message), /commit boundary/);
		const terminal = { ...message, phase: 'reconcile-quiesce' };
		assert.strictEqual(finishSchemaQuiesce(terminal), true);
		await completeSchemaQuiesce(terminal);
		assert.strictEqual(Table.isDropQuiescing(), false);
	});

	it('does not recover a committed peer quiescence while its origin is connected', async () => {
		const message = {
			originator: require('node:worker_threads').threadId,
			operation: 'drop_table',
			schema: 'quiesce-live-origin-test',
			table: 'Missing',
			quiesceId: 'q-live-origin',
		};
		assert.strictEqual((await quiesceSchemaTarget(message)).quiesced, true);
		assert.strictEqual((await commitSchemaQuiesce(message)).committed, true);
		expireSchemaQuiesceLeaseForTests(message.quiesceId);
		assert.strictEqual(
			renewSchemaQuiesce({ ...message, leaseUntil: Date.now() + 60_000 }).quiesced,
			true,
			'a connected origin must keep the committed peer fence active'
		);
		const terminal = { ...message, phase: 'reconcile-quiesce' };
		assert.strictEqual(finishSchemaQuiesce(terminal), true);
		await completeSchemaQuiesce(terminal);
	});

	it('recovers a committed peer quiescence after its origin disconnects', async () => {
		const message = {
			originator: Number.MAX_SAFE_INTEGER,
			operation: 'drop_table',
			schema: 'quiesce-disconnected-origin-test',
			table: 'Missing',
			quiesceId: 'q-disconnected-origin',
		};
		assert.strictEqual((await quiesceSchemaTarget(message)).quiesced, true);
		assert.strictEqual((await commitSchemaQuiesce(message)).committed, true);
		expireSchemaQuiesceLeaseForTests(message.quiesceId);
		assert.strictEqual(
			renewSchemaQuiesce({ ...message, leaseUntil: Date.now() + 60_000 }).quiesced,
			false,
			'a disconnected origin must allow authoritative recovery'
		);
	});

	it('recovers an expired committed quiescence from the durable live catalog', async () => {
		const DB = 'quiesce-committed-recovery-test';
		const Original = table({ table: 'Records', database: DB, attributes: [{ name: 'id', isPrimaryKey: true }] });
		const message = {
			operation: 'drop_table',
			schema: DB,
			table: 'Records',
			quiesceId: 'q-committed-recovery',
			originLocal: true,
			leaseUntil: Date.now() + 60_000,
		};
		assert.strictEqual((await quiesceSchemaTarget(message)).quiesced, true);
		assert.strictEqual((await commitSchemaQuiesce(message)).committed, true);
		const registry = getDatabases();
		const originalGetSync = Original.dbisDB.getSync;
		let descriptorReadBeforeMutation = false;
		Original.dbisDB.getSync = function (key) {
			if (key === 'Records/' && !descriptorReadBeforeMutation)
				descriptorReadBeforeMutation = registry[DB]?.Records === Original;
			return originalGetSync.call(this, key);
		};
		try {
			assert.strictEqual(await recoverCommittedSchemaQuiesceForTests(message.quiesceId), true);
		} finally {
			Original.dbisDB.getSync = originalGetSync;
		}
		assert.strictEqual(descriptorReadBeforeMutation, true, 'durable descriptor must be read before registry mutation');
		const Recovered = getDatabases()[DB]?.Records;
		assert.ok(Recovered, 'the durable non-tombstoned catalog should be restored');
		assert.notStrictEqual(Recovered, Original, 'recovery must not republish the quiesced table instance');
		assert.strictEqual(Recovered.isDropQuiescing(), false);
		assert.strictEqual(finishSchemaQuiesce({ ...message, phase: 'finalize-quiesce' }), false);
	});

	it('recovers an expired committed schema and clears its unavailable fence', async () => {
		const DB = 'quiesce-committed-schema-recovery-test';
		table({ table: 'Records', database: DB, attributes: [{ name: 'id', isPrimaryKey: true }] });
		const message = {
			operation: 'drop_schema',
			schema: DB,
			quiesceId: 'q-committed-schema-recovery',
			originLocal: true,
			leaseUntil: Date.now() + 60_000,
		};
		assert.strictEqual((await quiesceSchemaTarget(message)).quiesced, true);
		assert.strictEqual((await commitSchemaQuiesce(message)).committed, true);
		assert.throws(() => database({ database: DB, table: null }), /closing and cannot be opened/);
		assert.strictEqual(await recoverCommittedSchemaQuiesceForTests(message.quiesceId), true);
		assert.doesNotThrow(() => database({ database: DB, table: null }));
		assert.ok(getDatabases()[DB]?.Records);
	});

	it('clears the origin unavailable fence when only terminal broadcast acknowledgement fails', async function () {
		this.timeout(30000);
		const DB = 'drop-terminal-broadcast-failure-test';
		table({ table: 'Records', database: DB, attributes: [{ name: 'id', isPrimaryKey: true }] });
		const originalFinalize = signalling.finalizeSchemaChange;
		signalling.finalizeSchemaChange = async (message) => {
			completeSchemaQuiesce({ ...message, phase: 'finalize-quiesce' });
			throw new Error('injected remote terminal acknowledgement failure');
		};
		try {
			await assert.rejects(dropDatabase(DB), /injected remote terminal acknowledgement failure/);
			assert.doesNotThrow(() => database({ database: DB, table: null }));
			assert.ok(
				table({ table: 'Recreated', database: DB, attributes: [{ name: 'id', isPrimaryKey: true }] }),
				'physically destroyed schema name must be reusable after local terminal completion'
			);
		} finally {
			signalling.finalizeSchemaChange = originalFinalize;
		}
	});

	it('retains the origin unavailable fence when local terminal state is unresolved', async function () {
		this.timeout(30000);
		const DB = 'drop-terminal-local-failure-test';
		table({ table: 'Records', database: DB, attributes: [{ name: 'id', isPrimaryKey: true }] });
		const originalFinalize = signalling.finalizeSchemaChange;
		let terminalMessage;
		signalling.finalizeSchemaChange = async (message) => {
			terminalMessage = message;
			throw new Error('injected local terminal failure');
		};
		try {
			await assert.rejects(dropDatabase(DB), /injected local terminal failure/);
			assert.throws(
				() => database({ database: DB, table: null }),
				/closing and cannot be opened/,
				'uncertain local terminal state must remain fail-closed'
			);
		} finally {
			signalling.finalizeSchemaChange = originalFinalize;
			if (terminalMessage) completeSchemaQuiesce({ ...terminalMessage, phase: 'reconcile-quiesce' });
		}
	});

	it('clears the origin unavailable fence when failed-drop reconciliation only loses remote acknowledgement', async function () {
		this.timeout(30000);
		const DB = 'drop-reconcile-broadcast-failure-test';
		const Table = table({ table: 'Records', database: DB, attributes: [{ name: 'id', isPrimaryKey: true }] });
		const rootStore = Table.primaryStore.rootStore;
		if (!(rootStore instanceof RocksDatabase)) return this.skip();
		const originalDestroy = rootStore.destroy;
		const originalReconcile = signalling.reconcileSchemaChange;
		rootStore.destroy = () => {
			throw new Error('injected destroy failure');
		};
		signalling.reconcileSchemaChange = async (message) => {
			await originalReconcile(message);
			throw new Error('injected remote reconciliation acknowledgement failure');
		};
		try {
			await assert.rejects(dropDatabase(DB), /injected remote reconciliation acknowledgement failure/);
			assert.doesNotThrow(() => database({ database: DB, table: null }));
			assert.ok(getDatabases()[DB]?.Records, 'locally reconciled intact storage must be available');
		} finally {
			rootStore.destroy = originalDestroy;
			signalling.reconcileSchemaChange = originalReconcile;
			await dropDatabase(DB);
		}
	});

	it('bounds committed recovery attempts while an active drop lock is still held', async () => {
		const DB = 'quiesce-committed-recovery-bound-test';
		const Table = table({ table: 'Records', database: DB, attributes: [{ name: 'id', isPrimaryKey: true }] });
		const message = {
			operation: 'drop_table',
			schema: DB,
			table: 'Records',
			quiesceId: 'q-committed-recovery-bound',
			originLocal: true,
			leaseUntil: Date.now() + 60_000,
		};
		assert.strictEqual((await quiesceSchemaTarget(message)).quiesced, true);
		assert.strictEqual((await commitSchemaQuiesce(message)).committed, true);
		const lock = acquireRestoreLock(Table.primaryStore.rootStore.path);
		try {
			for (let attempt = 0; attempt < 3; attempt++)
				assert.strictEqual(await recoverCommittedSchemaQuiesceForTests(message.quiesceId), false);
		} finally {
			releaseRestoreLock(lock);
		}
		assert.strictEqual(
			await recoverCommittedSchemaQuiesceForTests(message.quiesceId),
			false,
			'the recovery budget must not restart after it is exhausted'
		);
		const terminal = { ...message, phase: 'reconcile-quiesce' };
		assert.strictEqual(finishSchemaQuiesce(terminal), true);
		await completeSchemaQuiesce(terminal);
	});
});
