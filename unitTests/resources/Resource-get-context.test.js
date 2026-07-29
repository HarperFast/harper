const assert = require('node:assert');
const sinon = require('sinon');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');

describe('Resource.get context passing', function () {
	// Note: When Resource.get calls source.get, the context is wrapped in a sourceContext object
	// with the original context available as sourceContext.requestContext. This matches Harper's
	// caching pattern where context is passed to sources wrapped in a requestContext property.

	let TestTable;
	let sourceGetStub;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);

		// Create a test table
		TestTable = table({
			table: 'TestTableForContext',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }, { name: 'value' }],
		});

		// Add a source with a get method that we can spy on
		sourceGetStub = sinon.stub();
		TestTable.sourcedFrom({
			get: sourceGetStub,
			// Mark that this source provides get functionality
			available: () => true,
		});
	});

	after(async function () {
		sinon.restore();

		// Clean up the test table
		await TestTable?.dropTable();
	});

	beforeEach(function () {
		sourceGetStub.reset();
	});

	it('should pass context to source.get when Resource.get is called with context', async function () {
		// Use a unique ID to ensure no cached data
		const testId = 'test-context-' + Date.now() + '-' + Math.random();
		const testContext = {
			user: { id: 'user-123', name: 'Test User' },
			customProperty: 'custom-value',
			requestId: 'req-456',
		};

		// Configure the stub to return a test record
		sourceGetStub.resolves({
			id: testId,
			name: 'Test Record',
			value: 42,
		});

		// Call Resource.get with context
		const result = await TestTable.get(testId, testContext);

		// Verify source.get was called
		assert(sourceGetStub.calledOnce, 'source.get should be called once');

		// Verify the arguments passed to source.get
		const [idArg, contextArg] = sourceGetStub.firstCall.args;

		// First argument should be the ID
		assert.strictEqual(idArg, testId, 'First argument should be the ID');

		// Second argument should be a sourceContext object containing our custom context under requestContext
		assert(contextArg, 'Context should be passed as second argument');
		assert(contextArg.requestContext, 'Context should have requestContext property');
		assert.strictEqual(contextArg.requestContext.user, testContext.user, 'User should be preserved in context');
		assert.strictEqual(
			contextArg.requestContext.customProperty,
			testContext.customProperty,
			'Custom property should be preserved'
		);
		assert.strictEqual(contextArg.requestContext.requestId, testContext.requestId, 'Request ID should be preserved');

		// Verify the result
		assert.strictEqual(result.id, testId);
		assert.strictEqual(result.name, 'Test Record');
		assert.strictEqual(result.value, 42);
	});

	it('should pass context through transaction', async function () {
		// Use a unique ID to ensure no cached data
		const testId = 'test-context-txn-' + Date.now() + '-' + Math.random();
		const testContext = {
			user: { id: 'user-789', name: 'Transaction User' },
			transactionId: 'txn-123',
		};

		sourceGetStub.resolves({
			id: testId,
			name: 'Transaction Record',
			value: 99,
		});

		// Call within a transaction
		await transaction(testContext, async () => {
			const result = await TestTable.get(testId, testContext);

			assert(sourceGetStub.calledOnce, 'source.get should be called once');

			const [idArg, contextArg] = sourceGetStub.firstCall.args;
			assert.strictEqual(idArg, testId);

			// Context should be wrapped in sourceContext
			assert(contextArg.requestContext, 'Should have requestContext');
			assert(contextArg.requestContext.transaction, 'Should have transaction in context');
			assert.strictEqual(contextArg.requestContext.user, testContext.user);
			assert.strictEqual(contextArg.requestContext.transactionId, testContext.transactionId);

			assert.strictEqual(result.name, 'Transaction Record');
		});
	});

	it.skip('should handle context with data parameter', async function () {
		// SKIPPED: The data parameter has been removed from the instance get method call.
		// Resource.ts line 52 now shows: resource.get?.(query, request) with no third parameter.
		// The transactional wrapper still accepts a data parameter in its signature (line 51),
		// but it's not passed to the instance get method.
		// This test is kept as documentation that data parameter passing is not implemented for get operations.
		// The context passing functionality (query and request parameters) is tested in other tests.
	});

	it('should work without context', async function () {
		// Use a unique ID to ensure no cached data
		const testId = 'test-no-context-' + Date.now() + '-' + Math.random();

		sourceGetStub.resolves({
			id: testId,
			name: 'No Context Record',
			value: 55,
		});

		// Call without context
		const result = await TestTable.get(testId);

		assert(sourceGetStub.calledOnce);
		const [idArg, contextArg] = sourceGetStub.firstCall.args;

		assert.strictEqual(idArg, testId);
		// Context should still be passed, but might be a default/empty context
		assert(contextArg, 'Context object should still be passed even when not provided');

		assert.strictEqual(result.name, 'No Context Record');
	});

	it('should handle source.get returning null', async function () {
		// Use a unique ID to ensure no cached data
		const testId = 'test-null-' + Date.now() + '-' + Math.random();
		const testContext = { user: { id: 'user-null' } };

		// Source returns null (record not found)
		sourceGetStub.resolves(null);

		const result = await TestTable.get(testId, testContext);

		assert(sourceGetStub.calledOnce);
		const [idArg, contextArg] = sourceGetStub.firstCall.args;

		assert.strictEqual(idArg, testId);
		assert(contextArg);
		assert(contextArg.requestContext, 'Should have requestContext');
		assert.strictEqual(contextArg.requestContext.user, testContext.user);

		// Result should be null or undefined when source returns null
		assert(!result || result === null);
	});
});

describe('dropTable waits for in-flight source-populated cache writes (harper#1381)', function () {
	// Resource.get() resolves to its caller as soon as the source responds - the resulting
	// cache write to the primary store commits "in the background" afterward (see
	// getFromSource in Table.ts). If dropTable() drops the table's column families while one
	// of those writes is still landing, RocksDB rejects the write with "Invalid column family
	// specified in write batch" (or "Could not access column family N"), which can also abort
	// the drop itself before it removes the tombstoned catalog rows - leaving the table stuck
	// "dropping" for completeInterruptedDrop to retry (and fail identically) on every
	// subsequent load. That is the failure this test reproduces deterministically: rather than
	// racing real timing (which only sometimes loses), an async step in the write's own
	// path (the @embed pre-commit hook) is gated behind a promise the test controls, so the
	// GET has already resolved to its caller - and the write is provably still pending - when
	// dropTable() is called.
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return; // this table drop path is RocksDB-only

	it('does not resolve dropTable() until a gated cache-from-source write has landed', async function () {
		setupTestDBPath();
		setMainIsWorker(true);

		const TestTable = table({
			table: 'DropRaceTable',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name' },
				// A get() resolves to its caller as soon as the source responds; the resulting
				// cache write only actually stages afterward, past an async embed-hook step (see
				// getFromSource - the embed step runs after the caller's promise has resolved).
				// Gating the embed hook (rather than source.get() itself) pins down that exact
				// post-resolution, pre-staging window instead of merely proving dropTable() waits
				// on an outstanding source fetch (which it deliberately no longer does - a call
				// still waiting on the source isn't tracked as a pending commit).
				{ name: 'vector', type: 'Array', embed: { source: 'name', model: 'unused' } },
			],
		});

		let releaseEmbed;
		const embedGate = new Promise((resolve) => {
			releaseEmbed = resolve;
		});
		let embedEntered;
		const embedEnteredPromise = new Promise((resolve) => {
			embedEntered = resolve;
		});
		TestTable.setEmbedAttribute('vector', async () => {
			embedEntered();
			await embedGate;
			return [1, 2, 3];
		});
		TestTable.sourcedFrom({
			get: async (id) => ({ id, name: 'gated' }),
			available: () => true,
		});

		// The GET resolves as soon as source.get() does; only the embed hook (and the write it
		// gates) is held back, so the caller already has its data while the write is still
		// pending. Wait on an explicit signal that the embedder was entered - not a guessed
		// number of ticks - so this doesn't depend on scheduler timing under a loaded test runner.
		const getPromise = TestTable.get('gated-1', {});
		await embedEnteredPromise;

		let dropResolved = false;
		const dropPromise = TestTable.dropTable().then(() => {
			dropResolved = true;
		});

		// The embed hook hasn't been released yet, so the cache write can't have staged - dropTable()
		// must still be waiting on it, not racing ahead to drop the column families.
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.strictEqual(
			dropResolved,
			false,
			'dropTable() must not drop the column families while a source-populated cache write is still pending'
		);

		releaseEmbed();
		await getPromise;
		await dropPromise;
		assert.strictEqual(dropResolved, true, 'dropTable() should resolve once the pending write has landed');
	});

	it('does not start a new cache write once dropTable() has begun (late admission during the drain)', async function () {
		setupTestDBPath();
		setMainIsWorker(true);

		const TestTable = table({
			table: 'DropRaceLateAdmission',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});

		let releaseFirst;
		const firstGate = new Promise((resolve) => {
			releaseFirst = resolve;
		});
		let firstEntered;
		const firstEnteredPromise = new Promise((resolve) => {
			firstEntered = resolve;
		});
		let lateSourceCalled = false;
		TestTable.sourcedFrom({
			get: async (id) => {
				if (id === 'first') {
					firstEntered();
					await firstGate;
				} else lateSourceCalled = true;
				return { id, name: 'value' };
			},
			available: () => true,
		});

		// Start a write that keeps dropTable() draining, so there is a window in which the
		// table is already marked dropping but the drop itself hasn't touched storage yet. Wait
		// on an explicit "entered the source" signal rather than a guessed number of ticks.
		const firstGetPromise = TestTable.get('first', {});
		await firstEnteredPromise;

		const dropPromise = TestTable.dropTable();

		// A get() admitted while the drop is draining must still return fresh source data...
		const lateResult = await TestTable.get('late', {});
		assert.ok(lateSourceCalled, 'the source should still be consulted for a late-admitted read');
		assert.strictEqual(lateResult.name, 'value');
		// ...but must not have started a new cache write into a table that's being dropped. The
		// get() call itself resolves before its own cache write would land (that's the whole
		// bug this file covers), so a correctly-blocked write and one that merely hasn't landed
		// YET look identical immediately after the await above. Give a generous, bounded window
		// for an (incorrectly) unblocked local write to land - the drop itself is still parked on
		// the gated first write, so this checks storage well before any column family is
		// touched, not a race against the drop.
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.strictEqual(
			TestTable.primaryStore.getSync('late'),
			undefined,
			'a get() admitted after dropTable() started must not cache its result'
		);

		releaseFirst();
		await firstGetPromise;
		await dropPromise;
	});

	// Not covered by an automated test here: dropTable()'s drain is bounded by LOCK_TIMEOUT
	// (10s) and FAILS the drop (throws, leaving the durable tombstone for completeInterruptedDrop
	// to retry) rather than proceeding to drop column families out from under a write that may
	// still be staged - see the comment above the drain in dropTable(). Exercising the real
	// 10-second timeout here would make this suite slow, and sinon fake timers over the
	// transaction/commit machinery this exercises reliably hung the test run rather than
	// advancing it. Verified manually with a standalone script instead (a source that never
	// resolves; dropTable() rejects with a "timed out" error after ~10s and no column family is
	// touched).
});
