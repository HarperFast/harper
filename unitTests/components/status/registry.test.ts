import assert from 'node:assert/strict';
import { ComponentStatusRegistry } from '@/components/status/ComponentStatusRegistry';
import { describe, it, before, after } from 'mocha';

describe('componentStatusRegistry singleton', function() {
	let componentStatusRegistry;

	before(() => {
		const registry = require('@/components/status/registry');
		componentStatusRegistry = registry.componentStatusRegistry;
	});

	after(() => {
		// Clean up the global singleton after tests
		componentStatusRegistry.reset();
	});

	it('should export a ComponentStatusRegistry instance', function() {
		assert.ok(componentStatusRegistry instanceof ComponentStatusRegistry);
	});

	it('should be a singleton instance', function() {
		const { componentStatusRegistry: registry2 } = require('@/components/status/registry');
		assert.strictEqual(componentStatusRegistry, registry2);
	});

	it('should have all ComponentStatusRegistry methods', function() {
		// Check core methods exist
		assert.equal(typeof componentStatusRegistry.reset, 'function');
		assert.equal(typeof componentStatusRegistry.setStatus, 'function');
		assert.equal(typeof componentStatusRegistry.getStatus, 'function');
		assert.equal(typeof componentStatusRegistry.getAllStatuses, 'function');
		assert.equal(typeof componentStatusRegistry.reportHealthy, 'function');
		assert.equal(typeof componentStatusRegistry.reportError, 'function');
		assert.equal(typeof componentStatusRegistry.reportWarning, 'function');
		assert.equal(typeof componentStatusRegistry.initializeLoading, 'function');
		assert.equal(typeof componentStatusRegistry.markLoaded, 'function');
		assert.equal(typeof componentStatusRegistry.markFailed, 'function');
		assert.equal(typeof componentStatusRegistry.getComponentsByStatus, 'function');
		assert.equal(typeof componentStatusRegistry.getStatusSummary, 'function');
	});

	it('should work with basic operations', function() {
		// Clean up any existing state
		componentStatusRegistry.reset();
		
		// Test basic operations
		componentStatusRegistry.setStatus('test-component', 'healthy', 'Test is running');
		
		const status = componentStatusRegistry.getStatus('test-component');
		assert.ok(status);
		assert.equal(status.status, 'healthy');
		assert.equal(status.message, 'Test is running');
		
		// Clean up
		componentStatusRegistry.reset();
	});
});
