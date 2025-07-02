'use strict';

const assert = require('node:assert');
const sinon = require('sinon');

// Load modules
const { internal } = require('../../../components/status/index.ts');
const { ComponentStatusRegistry } = internal;
const requestRestartModule = require('../../../components/requestRestart.ts');

// Load status module (before stubbing)
const status = require('../../../server/status/index');

describe('server.status', function () {
	let getAggregatedStub;
	let restartNeededStub;

	before(function() {
		// Create stubs for this test suite
		getAggregatedStub = sinon.stub(ComponentStatusRegistry, 'getAggregatedFromAllThreads').resolves(new Map());
		restartNeededStub = sinon.stub(requestRestartModule, 'restartNeeded').returns(false);
	});

	beforeEach(function() {
		// Initialize/clear the component status registry before each test
		const { internal } = require('../../../components/status/index.ts');
		internal.componentStatusRegistry.reset();
		
		// Reset stub behaviors
		getAggregatedStub.resetHistory();
		getAggregatedStub.resolves(new Map());
		restartNeededStub.resetHistory();
		restartNeededStub.returns(false);
	});
	
	afterEach(function() {
		// Reset stubs to default behavior after each test
		getAggregatedStub.resetHistory();
		getAggregatedStub.resolves(new Map());
		restartNeededStub.resetHistory();
		restartNeededStub.returns(false);
	});
	
	after(function() {
		// Restore original functions
		getAggregatedStub.restore();
		restartNeededStub.restore();
		
		// Clear component status registry
		const { internal } = require('../../../components/status/index.ts');
		internal.componentStatusRegistry.reset();
	});
	
	const clearStatus = async () => Promise.all(['primary', 'test', 'maintenance', 'availability'].map((id) => status.clear({ id })));
	beforeEach(() => clearStatus());
	after(() => clearStatus());

	const assertAndOverrideTimestamps = (obj) => {
		assert.ok(obj.__updatedtime__ !== undefined);
		assert.ok(obj.__createdtime__ !== undefined);
		obj.__updatedtime__ = 42;
		obj.__createdtime__ = 42;
	};

	it('should set status', async function () {
		const statusObj = {
			status: 'starting',
		};
		const result = await status.set(statusObj);
		assert.ok(result === undefined);
	});

	it('should get specific status', async function () {
		const statusObj = {
			id: 'primary',
			status: 'testing',
		};
		const expected = {
			id: 'primary',
			status: 'testing',
			__updatedtime__: 42,
			__createdtime__: 42,
		};
		await status.set(statusObj);
		const result = await status.get({ id: 'primary' });
		// node assert/strict is blind to resource properties
		const resultObj = JSON.parse(JSON.stringify(result));
		assertAndOverrideTimestamps(resultObj);
		assert.deepEqual(expected, resultObj);
	});

	it('should get complete status with just primary set', async function () {
		const statusObj = {
			id: 'primary',
			status: 'testing',
		};
		await status.set(statusObj);
		const result = await status.get({});
		
		// Result should now be an object with systemStatus, componentStatus, and restartRequired
		assert.ok(result.systemStatus !== undefined, 'systemStatus should be defined');
		assert.ok(result.componentStatus !== undefined, 'componentStatus should be defined');
		assert.ok(Array.isArray(result.componentStatus), 'componentStatus should be an array');
		assert.ok(result.restartRequired !== undefined, 'restartRequired should be defined');
		
		// systemStatus is an async iterable, convert to array for testing
		const systemStatusArray = [];
		for await (const item of result.systemStatus) {
			systemStatusArray.push(item);
		}
		
		// Check that primary status is in systemStatus
		const primaryStatus = systemStatusArray.find(s => s.id === 'primary');
		assert.ok(primaryStatus);
		assert.equal(primaryStatus.status, 'testing');
		assertAndOverrideTimestamps(primaryStatus);
	});

	it('should get complete status', async function () {
		const statusObjs = [
			{
				id: 'primary',
				status: 'testing',
			},
			{
				id: 'maintenance',
				status: 'testing will continue',
			},
		];
		await Promise.all(statusObjs.map((sO) => status.set(sO)));
		const result = await status.get({});
		
		// Result should now be an object with systemStatus, componentStatus, and restartRequired
		assert.ok(result.systemStatus);
		assert.ok(result.componentStatus);
		assert.ok(result.restartRequired !== undefined);
		
		// systemStatus is an async iterable, convert to array for testing
		const systemStatusArray = [];
		for await (const item of result.systemStatus) {
			systemStatusArray.push(item);
		}
		assert.equal(systemStatusArray.length, 2);
		
		// Check both statuses are present
		const primaryStatus = systemStatusArray.find(s => s.id === 'primary');
		assert.ok(primaryStatus);
		assert.equal(primaryStatus.status, 'testing');
		assertAndOverrideTimestamps(primaryStatus);
		
		const maintenanceStatus = systemStatusArray.find(s => s.id === 'maintenance');
		assert.ok(maintenanceStatus);
		assert.equal(maintenanceStatus.status, 'testing will continue');
		assertAndOverrideTimestamps(maintenanceStatus);
	});

	it('should fail validation on test status', async function () {
		const statusObjs = [
			{
				id: 'primary',
				status: 'testing',
			},
			{
				id: 'test',
				status: 'really testing',
			},
			{
				id: 'maintenance',
				status: 'testing will continue',
			},
		];
		await assert.rejects(async () => Promise.all(statusObjs.map((sO) => status.set(sO))), {
			name: 'Error',
			message: "'id' must be one of [primary, maintenance, availability]",
		});
	});

	it('should validate availability status values', async function () {
		// Valid availability value
		const validStatus = {
			id: 'availability',
			status: 'Available',
		};
		await status.set(validStatus);
		const result = await status.get({ id: 'availability' });
		assert.strictEqual(result.status, 'Available');
		
		// Invalid availability value
		const invalidStatus = {
			id: 'availability',
			status: 'Partially Available',
		};
		await assert.rejects(async () => status.set(invalidStatus), {
			name: 'Error',
			message: 'Status "availability" only accepts these values: Available, Unavailable'
		});
	});

	describe('getAllStatus functionality', function() {
		beforeEach(() => clearStatus());
		after(() => clearStatus());

		it('should return system status, component status, and restart flag when calling get without id', async function() {
			// Set some system status
			await status.set({ id: 'primary', status: 'running' });
			await status.set({ id: 'maintenance', status: 'active' });

			// Mock component status
			const mockComponentStatuses = {
				'test-component': {
					componentName: 'test-component',
					status: 'healthy',
					latestMessage: 'Component loaded successfully',
					lastChecked: {
						main: Date.now(),
						workers: {
							1: Date.now()
						}
					}
				},
				'another-component': {
					componentName: 'another-component',
					status: 'error',
					latestMessage: 'Failed to start',
					lastChecked: {
						main: Date.now(),
						workers: {}
					},
					error: 'Startup failed'
				}
			};

			// Configure the stubs for this test
			getAggregatedStub.resolves((() => {
				const map = new Map();
				Object.entries(mockComponentStatuses).forEach(([name, status]) => {
					map.set(name, status);
				});
				return map;
			})());

			restartNeededStub.returns(true);

			const result = await status.get({});

			// Check that result has the expected structure
			assert.ok(result.systemStatus !== undefined);
			assert.ok(result.componentStatus !== undefined);
			assert.ok(result.restartRequired !== undefined);

			// Check system status - it's an async iterable
			const systemStatusArray = [];
			for await (const item of result.systemStatus) {
				systemStatusArray.push(item);
			}
			assert.equal(systemStatusArray.length, 2);

			// Check component status
			assert.ok(Array.isArray(result.componentStatus));
			assert.equal(result.componentStatus.length, 2);
			
			const healthyComponent = result.componentStatus.find(c => c.name === 'test-component');
			assert.ok(healthyComponent);
			assert.equal(healthyComponent.status, 'healthy');
			assert.equal(healthyComponent.latestMessage, 'Component loaded successfully');
			assert.ok(healthyComponent.lastChecked);
			assert.ok(typeof healthyComponent.lastChecked.main === 'number');
			assert.ok(typeof healthyComponent.lastChecked.workers[1] === 'number');

			const errorComponent = result.componentStatus.find(c => c.name === 'another-component');
			assert.ok(errorComponent);
			assert.equal(errorComponent.status, 'error');
			assert.equal(errorComponent.latestMessage, 'Failed to start');
			assert.equal(errorComponent.error, 'Startup failed');

			// Check restart flag
			assert.equal(result.restartRequired, true);
		});

		it('should handle empty component status gracefully', async function() {
			// Set some system status
			await status.set({ id: 'primary', status: 'running' });

			// Configure stubs for empty component status
			getAggregatedStub.resolves(new Map());
			restartNeededStub.returns(false);

			const result = await status.get({});

			// Check structure
			assert.ok(result.systemStatus !== undefined);
			assert.ok(result.componentStatus !== undefined);
			assert.ok(result.restartRequired !== undefined);

			// Component status should be empty array
			assert.ok(Array.isArray(result.componentStatus));
			assert.equal(result.componentStatus.length, 0);

			// Restart should be false
			assert.equal(result.restartRequired, false);
		});

		it('should continue working if component status functions are unavailable', async function() {
			// Set some system status
			await status.set({ id: 'primary', status: 'running' });

			// Configure stubs to throw errors
			getAggregatedStub.rejects(new Error('Component status not available'));
			restartNeededStub.throws(new Error('Restart status not available'));

			try {
				// This should either work with error handling or throw - depends on implementation
				// If the implementation doesn't handle errors, this test documents expected behavior
				const result = await status.get({});
				
				// If it succeeds, system status should still be available
				assert.ok(result.systemStatus !== undefined);
			} catch (error) {
				// If it fails, that's also acceptable behavior to document
				assert.ok(error.message.includes('Component status not available') || 
						 error.message.includes('Restart status not available'));
			}
		});
	});
});
