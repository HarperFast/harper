const assert = require('node:assert/strict');
const sinon = require('sinon');
const { getMockLMDBPath } = require('../test_utils');
const { table } = require('../../resources/databases');
const { setMainIsWorker } = require('../../server/threads/manageThreads');
const { transaction } = require('../../resources/transaction');

describe('Resource.get context passing', function() {
	// Note: When Resource.get calls source.get, the context is wrapped in a sourceContext object
	// with the original context available as sourceContext.requestContext. This matches Harper's
	// caching pattern where context is passed to sources wrapped in a requestContext property.
	
	let TestTable;
	let sourceGetStub;
	
	before(function() {
		getMockLMDBPath();
		setMainIsWorker(true);
		
		// Create a test table
		TestTable = table({
			table: 'TestTableForContext',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name' },
				{ name: 'value' }
			],
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
	
	beforeEach(function() {
		sourceGetStub.reset();
	});
	
	it('should pass context to source.get when Resource.get is called with context', async function() {
		// Use a unique ID to ensure no cached data
		const testId = 'test-context-' + Date.now() + '-' + Math.random();
		const testContext = {
			user: { id: 'user-123', name: 'Test User' },
			customProperty: 'custom-value',
			requestId: 'req-456'
		};
		
		// Configure the stub to return a test record
		sourceGetStub.resolves({
			id: testId,
			name: 'Test Record',
			value: 42
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
		assert.strictEqual(contextArg.requestContext.customProperty, testContext.customProperty, 'Custom property should be preserved');
		assert.strictEqual(contextArg.requestContext.requestId, testContext.requestId, 'Request ID should be preserved');
		
		// Verify the result
		assert.strictEqual(result.id, testId);
		assert.strictEqual(result.name, 'Test Record');
		assert.strictEqual(result.value, 42);
	});
	
	it('should pass context through transaction', async function() {
		// Use a unique ID to ensure no cached data
		const testId = 'test-context-txn-' + Date.now() + '-' + Math.random();
		const testContext = {
			user: { id: 'user-789', name: 'Transaction User' },
			transactionId: 'txn-123'
		};
		
		sourceGetStub.resolves({
			id: testId,
			name: 'Transaction Record',
			value: 99
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
	
	it.skip('should handle context with data parameter', async function() {
		// SKIPPED: The data parameter has been removed from the instance get method call.
		// Resource.ts line 52 now shows: resource.get?.(query, request) with no third parameter.
		// The transactional wrapper still accepts a data parameter in its signature (line 51),
		// but it's not passed to the instance get method.
		
		// This test is kept as documentation that data parameter passing is not implemented for get operations.
		// The context passing functionality (query and request parameters) is tested in other tests.
	});
	
	it('should work without context', async function() {
		// Use a unique ID to ensure no cached data
		const testId = 'test-no-context-' + Date.now() + '-' + Math.random();
		
		sourceGetStub.resolves({
			id: testId,
			name: 'No Context Record',
			value: 55
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
	
	it('should handle source.get returning null', async function() {
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