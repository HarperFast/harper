import assert from 'node:assert/strict';
import { statusForComponent, lifecycle, reset, STATUS, internal } from '@/../components/status';
import { describe, it, afterEach } from 'mocha';

describe('Component Status Public API', function() {
	afterEach(function() {
		// Clean up after each test
		reset();
	});

	describe('statusForComponent() API', function() {
		it('should provide fluent interface for status reporting', function() {
			// Test chaining
			const result = statusForComponent('test-service')
				.healthy('Service initialized')
				.warning('High memory usage')
				.error('Connection lost', new Error('timeout'));
			
			// Should return the builder for chaining
			assert.ok(result);
			
			// Final status should be error
			const status = statusForComponent('test-service').get();
			assert.equal(status.status, STATUS.ERROR);
			assert.equal(status.message, 'Connection lost');
		});

		it('should report healthy status', function() {
			statusForComponent('api').healthy('API server running');
			
			const status = statusForComponent('api').get();
			assert.equal(status.status, STATUS.HEALTHY);
			assert.equal(status.message, 'API server running');
		});

		it('should report healthy status without message', function() {
			statusForComponent('cache').healthy();
			
			const status = statusForComponent('cache').get();
			assert.equal(status.status, STATUS.HEALTHY);
			assert.equal(status.message, undefined);
		});

		it('should report warning status', function() {
			statusForComponent('database').warning('Replication lag detected');
			
			const status = statusForComponent('database').get();
			assert.equal(status.status, STATUS.WARNING);
			assert.equal(status.message, 'Replication lag detected');
		});

		it('should report error status with Error object', function() {
			const error = new Error('Connection timeout');
			statusForComponent('redis').error('Redis connection failed', error);
			
			const status = statusForComponent('redis').get();
			assert.equal(status.status, STATUS.ERROR);
			assert.equal(status.message, 'Redis connection failed');
			assert.equal(status.error, error);
		});

		it('should report loading status', function() {
			statusForComponent('ml-model').loading('Loading model weights');
			
			const status = statusForComponent('ml-model').get();
			assert.equal(status.status, STATUS.LOADING);
			assert.equal(status.message, 'Loading model weights');
		});

		it('should report loading status with default message', function() {
			statusForComponent('data-processor').loading();
			
			const status = statusForComponent('data-processor').get();
			assert.equal(status.status, STATUS.LOADING);
			assert.equal(status.message, 'Loading...');
		});

		it('should report unknown status', function() {
			statusForComponent('mystery').unknown('State unclear');
			
			const status = statusForComponent('mystery').get();
			assert.equal(status.status, STATUS.UNKNOWN);
			assert.equal(status.message, 'State unclear');
		});

		it('should reuse builder instances', function() {
			const builder1 = statusForComponent('shared');
			const builder2 = statusForComponent('shared');
			
			assert.strictEqual(builder1, builder2);
		});

		it('should return undefined for non-existent component', function() {
			const status = statusForComponent('non-existent').get();
			assert.equal(status, undefined);
		});
	});

	describe('lifecycle API', function() {
		it('should handle component loading lifecycle', function() {
			// Loading phase
			lifecycle.loading('auth-service', 'Initializing authentication');
			let status = internal.query.get('auth-service');
			assert.equal(status.status, STATUS.LOADING);
			assert.equal(status.message, 'Initializing authentication');
			
			// Success case
			lifecycle.loaded('auth-service', 'Authentication ready');
			status = internal.query.get('auth-service');
			assert.equal(status.status, STATUS.HEALTHY);
			assert.equal(status.message, 'Authentication ready');
		});

		it('should handle component failure', function() {
			lifecycle.loading('payment-gateway');
			
			const error = new Error('Invalid API key');
			lifecycle.failed('payment-gateway', error, 'Failed to initialize payment gateway');
			
			const status = internal.query.get('payment-gateway');
			assert.equal(status.status, STATUS.ERROR);
			assert.equal(status.message, 'Failed to initialize payment gateway');
			assert.equal(status.error, error);
		});
	});

	describe('reset API', function() {
		it('should clear all component statuses', function() {
			statusForComponent('temp1').healthy();
			statusForComponent('temp2').error('Failed');
			
			assert.equal(internal.query.all().size, 2);
			
			reset();
			
			assert.equal(internal.query.all().size, 0);
			assert.equal(internal.query.get('temp1'), undefined);
			assert.equal(internal.query.get('temp2'), undefined);
		});
	});

	describe('STATUS constants', function() {
		it('should expose status level constants', function() {
			assert.equal(STATUS.HEALTHY, 'healthy');
			assert.equal(STATUS.WARNING, 'warning');
			assert.equal(STATUS.ERROR, 'error');
			assert.equal(STATUS.LOADING, 'loading');
			assert.equal(STATUS.UNKNOWN, 'unknown');
		});
	});
});
