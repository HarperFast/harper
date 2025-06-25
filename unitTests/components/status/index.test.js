const assert = require('node:assert/strict');
const { statusForComponent, reset, STATUS, internal } = require('../../../components/status/index.ts');
const { ComponentStatus } = internal;

describe('Component Status API', function() {
	beforeEach(function() {
		// Clear the registry before each test
		reset();
	});

	after(function() {
		// Clean up the registry after all tests complete
		reset();
	});

	describe('statusForComponent', function() {
		it('should return a ComponentStatusBuilder instance', function() {
			const api = statusForComponent('test-component');
			assert.ok(api);
			assert.equal(typeof api.warning, 'function');
			assert.equal(typeof api.error, 'function');
			assert.equal(typeof api.healthy, 'function');
			assert.equal(typeof api.loading, 'function');
			assert.equal(typeof api.unknown, 'function');
			assert.equal(typeof api.get, 'function');
		});

		it('should return the same instance for the same component name', function() {
			const api1 = statusForComponent('cached-component');
			const api2 = statusForComponent('cached-component');
			assert.strictEqual(api1, api2);
		});

		it('should return different instances for different component names', function() {
			const api1 = statusForComponent('component-1');
			const api2 = statusForComponent('component-2');
			assert.notStrictEqual(api1, api2);
		});
	});

	describe('ComponentStatusAPI methods', function() {
		let api;
		
		beforeEach(function() {
			api = statusForComponent('test-api-component');
		});

		describe('warning', function() {
			it('should set component status to warning', function() {
				api.warning('High memory usage detected');
				
				const status = internal.componentStatusRegistry.getStatus('test-api-component');
				assert.ok(status);
				assert.equal(status.status, STATUS.WARNING);
				assert.equal(status.message, 'High memory usage detected');
			});
		});

		describe('error', function() {
			it('should set component status to error with message only', function() {
				api.error('Connection failed');
				
				const status = internal.componentStatusRegistry.getStatus('test-api-component');
				assert.ok(status);
				assert.equal(status.status, STATUS.ERROR);
				assert.equal(status.message, 'Connection failed');
				assert.equal(status.error, undefined);
			});

			it('should set component status to error with message and Error object', function() {
				const error = new Error('Database timeout');
				api.error('Failed to connect to database', error);
				
				const status = internal.componentStatusRegistry.getStatus('test-api-component');
				assert.ok(status);
				assert.equal(status.status, STATUS.ERROR);
				assert.equal(status.message, 'Failed to connect to database');
				assert.equal(status.error, error);
			});
		});

		describe('healthy', function() {
			it('should set component status to healthy with message', function() {
				api.healthy('Component is running smoothly');
				
				const status = internal.componentStatusRegistry.getStatus('test-api-component');
				assert.ok(status);
				assert.equal(status.status, STATUS.HEALTHY);
				assert.equal(status.message, 'Component is running smoothly');
			});

			it('should set component status to healthy without message', function() {
				api.healthy();
				
				const status = internal.componentStatusRegistry.getStatus('test-api-component');
				assert.ok(status);
				assert.equal(status.status, STATUS.HEALTHY);
				assert.equal(status.message, undefined);
			});
		});

		describe('loading', function() {
			it('should set component status to loading with message', function() {
				api.loading('Initializing database connection');
				
				const status = internal.componentStatusRegistry.getStatus('test-api-component');
				assert.ok(status);
				assert.equal(status.status, STATUS.LOADING);
				assert.equal(status.message, 'Initializing database connection');
			});

			it('should set component status to loading without message', function() {
				api.loading();
				
				const status = internal.componentStatusRegistry.getStatus('test-api-component');
				assert.ok(status);
				assert.equal(status.status, STATUS.LOADING);
				assert.equal(status.message, 'Loading...'); // Default message
			});
		});

		describe('unknown', function() {
			it('should set component status to unknown with message', function() {
				api.unknown('Component state is unclear');
				
				const status = internal.componentStatusRegistry.getStatus('test-api-component');
				assert.ok(status);
				assert.equal(status.status, STATUS.UNKNOWN);
				assert.equal(status.message, 'Component state is unclear');
			});

			it('should set component status to unknown without message', function() {
				api.unknown();
				
				const status = internal.componentStatusRegistry.getStatus('test-api-component');
				assert.ok(status);
				assert.equal(status.status, STATUS.UNKNOWN);
				assert.equal(status.message, undefined);
			});
		});

		describe('get', function() {
			it('should return undefined for non-existent component', function() {
				const status = api.get();
				assert.equal(status, undefined);
			});

			it('should return the current status of the component', function() {
				api.healthy('Running');
				
				const status = api.get();
				assert.ok(status instanceof ComponentStatus);
				assert.equal(status.status, STATUS.HEALTHY);
				assert.equal(status.message, 'Running');
			});

			it('should reflect status changes', function() {
				// Initially healthy
				api.healthy('Started');
				let status = api.get();
				assert.equal(status.status, STATUS.HEALTHY);
				
				// Change to warning
				api.warning('Performance degraded');
				status = api.get();
				assert.equal(status.status, STATUS.WARNING);
				
				// Change to error
				api.error('Failed');
				status = api.get();
				assert.equal(status.status, STATUS.ERROR);
			});
		});
	});

	describe('Integration with componentStatusRegistry', function() {
		it('should properly integrate with the global registry', function() {
			const api1 = statusForComponent('integration-test-1');
			const api2 = statusForComponent('integration-test-2');
			
			api1.healthy('Component 1 is healthy');
			api2.warning('Component 2 has warnings');
			
			// Check via registry
			const status1 = internal.componentStatusRegistry.getStatus('integration-test-1');
			const status2 = internal.componentStatusRegistry.getStatus('integration-test-2');
			
			assert.equal(status1.status, STATUS.HEALTHY);
			assert.equal(status2.status, STATUS.WARNING);
			
			// Check via API
			assert.equal(api1.get().status, STATUS.HEALTHY);
			assert.equal(api2.get().status, STATUS.WARNING);
		});

		it('should work with registry methods', function() {
			const api = statusForComponent('registry-integration');
			
			// Set status via API
			api.error('API error', new Error('Test'));
			
			// Check via registry methods
			const errorComponents = internal.componentStatusRegistry.getComponentsByStatus(STATUS.ERROR);
			assert.equal(errorComponents.length, 1);
			assert.equal(errorComponents[0].name, 'registry-integration');
			
			// Check summary
			const summary = internal.componentStatusRegistry.getStatusSummary();
			assert.equal(summary[STATUS.ERROR], 1);
			assert.equal(summary[STATUS.HEALTHY], 0);
		});
	});

	describe('Multiple component workflow', function() {
		it('should handle multiple components independently', function() {
			const authApi = statusForComponent('auth-service');
			const dbApi = statusForComponent('database');
			const cacheApi = statusForComponent('cache');
			
			// Set different statuses
			authApi.healthy('Authentication service running');
			dbApi.error('Connection pool exhausted');
			cacheApi.warning('Cache size at 90% capacity');
			
			// Verify each component has correct status
			assert.equal(authApi.get().status, STATUS.HEALTHY);
			assert.equal(dbApi.get().status, STATUS.ERROR);
			assert.equal(cacheApi.get().status, STATUS.WARNING);
			
			// Verify registry summary
			const summary = internal.componentStatusRegistry.getStatusSummary();
			assert.equal(summary[STATUS.HEALTHY], 1);
			assert.equal(summary[STATUS.ERROR], 1);
			assert.equal(summary[STATUS.WARNING], 1);
			assert.equal(summary[STATUS.LOADING], 0);
			assert.equal(summary[STATUS.UNKNOWN], 0);
		});
	});

	describe('Status transition scenarios', function() {
		it('should handle component lifecycle transitions', function() {
			const api = statusForComponent('lifecycle-component');
			
			// Component starts loading
			api.loading('Initializing...');
			assert.equal(api.get().status, STATUS.LOADING);
			
			// Component becomes healthy
			api.healthy('Initialization complete');
			assert.equal(api.get().status, STATUS.HEALTHY);
			
			// Component encounters warning
			api.warning('Resource usage high');
			assert.equal(api.get().status, STATUS.WARNING);
			
			// Component fails
			const error = new Error('Out of memory');
			api.error('Component crashed', error);
			const errorStatus = api.get();
			assert.equal(errorStatus.status, STATUS.ERROR);
			assert.equal(errorStatus.error, error);
			
			// Component recovers
			api.healthy('Restarted successfully');
			assert.equal(api.get().status, STATUS.HEALTHY);
		});
	});
});