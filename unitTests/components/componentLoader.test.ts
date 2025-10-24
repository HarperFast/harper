import { describe, it, before, beforeEach, after } from 'mocha';
import assert from 'node:assert/strict';
import sinon from 'sinon';
import path from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';

describe('ComponentLoader Status Integration', function () {
	let componentStatusRegistry;
	let tempDir;
	let componentLoader;
	let lifecycle;

	before(() => {
		// Create a temporary directory for test components
		tempDir = mkdtempSync(path.join(tmpdir(), 'harper-test-components-'));

		// Mock environment to use our temp directory
		const env = require('@/utility/environment/environmentManager');
		sinon.stub(env, 'get').callsFake((key) => {
			if (key === 'COMPONENTSROOT') {
				return tempDir;
			}
			// Return some default values for other config
			if (key === 'CLUSTERING_ENABLED') return false;
			if (key === 'MAX_HEADER_SIZE') return 8192;
			if (key === 'HTTP_PORT') return 9925;
			if (key === 'CUSTOM_FUNCTIONS') return false;
			return '';
		});

		// Get both the lifecycle and internal objects
		const statusModule = require('@/components/status');
		const { internal } = statusModule;
		lifecycle = statusModule.lifecycle;
		componentStatusRegistry = internal.componentStatusRegistry;

		// Spy on lifecycle methods (which componentLoader uses)
		sinon.spy(lifecycle, 'loading');
		sinon.spy(lifecycle, 'loaded');
		sinon.spy(lifecycle, 'failed');

		// Also spy on registry methods for other tests
		sinon.spy(componentStatusRegistry, 'initializeLoading');
		sinon.spy(componentStatusRegistry, 'markLoaded');
		sinon.spy(componentStatusRegistry, 'markFailed');
		sinon.spy(componentStatusRegistry, 'setStatus');
		sinon.spy(componentStatusRegistry, 'getStatus');

		// Mock getConfigObj to avoid loading real config for root components
		const configUtils = require('@/config/configUtils');
		sinon.stub(configUtils, 'getConfigObj').returns({});

		// Clear the componentLoader from require cache to ensure it gets our spied lifecycle
		delete require.cache[require.resolve('@/components/componentLoader')];

		// Load componentLoader after setting up spies
		componentLoader = require('@/components/componentLoader');
	});

	after(function () {
		// Restore all spies
		sinon.restore();

		// Clean up temp directory
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}

		// Clear the component status registry
		componentStatusRegistry.reset();
	});

	beforeEach(function () {
		// Reset spy history before each test
		lifecycle.loading.resetHistory();
		lifecycle.loaded.resetHistory();
		lifecycle.failed.resetHistory();
		componentStatusRegistry.initializeLoading.resetHistory();
		componentStatusRegistry.markLoaded.resetHistory();
		componentStatusRegistry.markFailed.resetHistory();
		componentStatusRegistry.setStatus.resetHistory();
		componentStatusRegistry.getStatus.resetHistory();

		// Clear the registry state
		componentStatusRegistry.reset();
	});

	describe('Basic component status tracking', function () {
		it('should initialize loading status for non-root components', async function () {
			// Create a test component directory
			const componentDirName = 'test-component';
			const componentDir = path.join(tempDir, componentDirName);
			mkdirSync(componentDir);

			// Use dataLoader which is a trusted loader
			writeFileSync(path.join(componentDir, 'harperdb-config.yaml'), 'dataLoader: { path: "data" }');

			// Create mock resources
			const mockResources = {
				isWorker: true,
				set: sinon.stub(),
			};

			// Load the component
			await componentLoader.loadComponent(componentDir, mockResources, 'test-origin', false);

			// Check lifecycle.loading calls
			const expectedStatusName = `${componentDirName}.dataLoader`;
			const loadingCalls = lifecycle.loading.getCalls().filter((call) => call.args[0] === expectedStatusName);
			assert.equal(loadingCalls.length, 1, 'Should have called lifecycle.loading for dataLoader component');

			// Also check it eventually gets marked as loaded or failed
			const loadedCalls = lifecycle.loaded.getCalls().filter((call) => call.args[0] === expectedStatusName);
			const failedCalls = lifecycle.failed.getCalls().filter((call) => call.args[0] === expectedStatusName);

			// Should have either loaded or failed
			assert.ok(
				loadedCalls.length > 0 || failedCalls.length > 0,
				'Component should be marked as either loaded or failed'
			);
		});

		it('should track loading for components with trusted loaders', async function () {
			// Create a component using a trusted loader
			const componentDirName = 'trusted-component';
			const componentDir = path.join(tempDir, componentDirName);
			mkdirSync(componentDir);

			// Use 'logging' which is a trusted loader that won't cause side effects
			writeFileSync(path.join(componentDir, 'harperdb-config.yaml'), 'logging: { level: "info" }');

			// Create mock resources
			const mockResources = {
				isWorker: true,
				set: sinon.stub(),
			};

			// Load the component
			await componentLoader.loadComponent(componentDir, mockResources, 'test-origin', false);

			// Should initialize the logging component
			const expectedStatusName = `${componentDirName}.logging`;
			const dirInitCalls = componentStatusRegistry.initializeLoading
				.getCalls()
				.filter((call) => call.args[0] === expectedStatusName);
			assert.equal(dirInitCalls.length, 1);

			// Should mark as loaded after successful loading
			const loadedCalls = componentStatusRegistry.markLoaded
				.getCalls()
				.filter((call) => call.args[0] === expectedStatusName);
			assert.equal(loadedCalls.length, 1);
			assert.match(loadedCalls[0].args[1], /loaded successfully/);
		});

		it('should mark component as failed when it loads no functionality', async function () {
			// Create a component directory without config
			// This will use DEFAULT_CONFIG but won't actually load anything
			const componentDirName = 'empty-component';
			const componentDir = path.join(tempDir, componentDirName);
			mkdirSync(componentDir);

			// Create mock resources
			const mockResources = {
				isWorker: true,
				set: sinon.stub(),
			};

			// Load the component - no config means DEFAULT_CONFIG is used
			await componentLoader.loadComponent(componentDir, mockResources, 'test-origin', false);

			// Should initialize first
			assert.ok(componentStatusRegistry.initializeLoading.called);

			// Should mark as failed because no functionality was loaded
			const failedCalls = componentStatusRegistry.markFailed.getCalls();

			// When no functionality is loaded, it marks the basename as failed
			const componentFailure = failedCalls.find(
				(call) =>
					call.args[0] === componentDirName &&
					String(call.args[1]).includes('did not load any modules, resources, or files')
			);

			assert.ok(componentFailure, 'Component should be marked as failed for not loading functionality');
			assert.equal(componentFailure.args[0], componentDirName);
		});
	});

	describe('Component status verification', function () {
		it('should properly set status in registry after successful load', async function () {
			// Create a component
			const componentDirName = 'verify-status';
			const componentDir = path.join(tempDir, componentDirName);
			mkdirSync(componentDir);
			writeFileSync(path.join(componentDir, 'harperdb-config.yaml'), 'logging: {}');

			// Create mock resources
			const mockResources = {
				isWorker: true,
				set: sinon.stub(),
			};

			// Load the component
			await componentLoader.loadComponent(componentDir, mockResources, 'test-origin', false);

			// Get the actual status from registry using the correct name
			const expectedStatusName = `${componentDirName}.logging`;
			const status = componentStatusRegistry.getStatus(expectedStatusName);
			assert.ok(status, 'Component should have a status');
			assert.equal(status.status, 'healthy', 'Component should be healthy');
			assert.ok(status.message, 'Should have a status message');
		});

		it('should handle component loading errors gracefully', async function () {
			// Stub the dataLoader module's handleApplication method to throw an error
			const dataLoaderModule = require('@/resources/dataLoader');
			const originalhandleApplication = dataLoaderModule.handleApplication;
			sinon.stub(dataLoaderModule, 'handleApplication').throws(new Error('DataLoader failed to initialize'));

			// Create a component that uses dataLoader
			const componentDirName = 'error-component';
			const componentDir = path.join(tempDir, componentDirName);
			mkdirSync(componentDir);

			// Create config that uses dataLoader
			writeFileSync(path.join(componentDir, 'harperdb-config.yaml'), 'dataLoader:\n  path: "data"');

			// Create mock resources
			const mockResources = {
				isWorker: true,
				set: sinon.stub(),
			};

			// Load the component - won't throw, but will handle the error internally
			await componentLoader.loadComponent(componentDir, mockResources, 'test-origin', false);

			// Should have initialized the component
			const expectedStatusName = `${componentDirName}.dataLoader`;
			const loadingCalls = lifecycle.loading.getCalls().filter((call) => call.args[0] === expectedStatusName);
			assert.equal(loadingCalls.length, 1, 'Should have called lifecycle.loading for the component');

			// Should have marked the specific component as failed
			const failedCalls = lifecycle.failed.getCalls();
			const componentFailure = failedCalls.find((call) => call.args[0] === expectedStatusName);
			assert.ok(componentFailure, 'Should have marked the component as failed');
			assert.ok(componentFailure.args[1] instanceof Error, 'Should have passed an Error object');
			assert.match(
				String(componentFailure.args[1]),
				/DataLoader failed to initialize/,
				'Error should contain our error message'
			);

			// Should have set an error resource
			assert.ok(mockResources.set.called, 'Should have called resources.set');
			const errorCall = mockResources.set
				.getCalls()
				.find((call) => call.args[1]?.constructor?.name === 'ErrorResource');
			assert.ok(errorCall, 'Should have created an ErrorResource');

			// Restore the original handleApplication method
			dataLoaderModule.handleApplication = originalhandleApplication;
		});
	});
});
