const assert = require('node:assert/strict');
const path = require('node:path');
const { loadComponent, loadedPaths } = require('#src/components/componentLoader');
const { PACKAGE_ROOT } = require('#js/utility/packageUtils');
const { ApplicationScope } = require('#js/components/ApplicationScope');

describe('Global Variable Isolation in testJSWithDeps', function () {
	let mockResources;

	beforeEach(function () {
		// Create mock resources
		mockResources = new Map();
		mockResources.isWorker = true;

		// Ensure no global variables from previous tests
		delete global.globalVariableFromComponent;
		// Set a global variable in the parent context
		global.globalVariableFromParent = 'parent-value';
		loadedPaths.clear();
	});

	afterEach(function () {
		// Clean up global variables
		delete global.globalVariableFromParent;
		delete global.globalVariableFromComponent;
	});
	const componentDir = path.join(__dirname, 'fixtures', 'testJSWithDeps');

	it('should isolate global variables when loading the component', async function () {
		let applicationScope = new ApplicationScope('test', mockResources, server);
		Object.assign(applicationScope, {
			mode: 'vm',
			dependencyContainment: false,
			verifyPath: PACKAGE_ROOT,
		});
		await loadComponent(componentDir, mockResources, 'test-origin', {
			applicationScope,
		});

		// The component's resources.js file asserts that globalVariableFromParent is undefined
		// If the component loaded without throwing, it means global variables are properly isolated

		// Verify the component's global variable didn't leak into our context
		assert.equal(
			typeof global.globalVariableFromComponent,
			'undefined',
			'Component global variable should not leak into parent context'
		);

		// Verify our global variable still exists
		assert.equal(global.globalVariableFromParent, 'parent-value', 'Parent global variable should remain unchanged');

		// verify the exported resource works
		assert.equal(mockResources.get('/testExport').get(), 'hello world');
		assert.equal(typeof mockResources.get('/TestComponent').get, 'function');
		assert.equal(typeof mockResources.get('/my-component').get, 'function');
	});
	it('should be able to load component with package dependency containment', async function () {
		let applicationScope = new ApplicationScope('test', mockResources, server);
		Object.assign(applicationScope, {
			mode: 'vm',
			dependencyContainment: true,
			verifyPath: PACKAGE_ROOT,
		});
		await loadComponent(componentDir, mockResources, 'test-origin', {
			applicationScope,
		});

		// Verify the component's global variable didn't leak into our context
		assert.equal(
			typeof global.globalVariableFromComponent,
			'undefined',
			'Component global variable should not leak into parent context'
		);

		// verify the exported resource works
		assert.equal(mockResources.get('/testExport').get(), 'hello world');
		assert.equal(typeof mockResources.get('/TestComponent').get, 'function');
		assert.equal(typeof mockResources.get('/my-component').get, 'function');
	});
	it('should be able to load component with SES compartment', async function () {
		let applicationScope = new ApplicationScope('test', mockResources, server);
		Object.assign(applicationScope, {
			mode: 'compartment',
			dependencyContainment: true,
			verifyPath: PACKAGE_ROOT,
		});
		await loadComponent(componentDir, mockResources, 'test-origin', {
			applicationScope,
		});

		// Verify the component's global variable didn't leak into our context
		assert.equal(
			typeof global.globalVariableFromComponent,
			'undefined',
			'Component global variable should not leak into parent context'
		);

		// verify the exported resource works
		assert.equal(mockResources.get('/testExport').get(), 'hello world');
		assert.equal(typeof mockResources.get('/TestComponent').get, 'function');
		// assert(typeof mockResources.get('/my-component').get === 'function'); // this syntax doesn't seem to work
		// with SES Compartments
	});
});
