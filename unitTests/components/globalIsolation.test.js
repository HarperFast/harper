const assert = require('node:assert/strict');
const path = require('node:path');
const { loadComponent } = require('#src/components/componentLoader');

describe('Global Variable Isolation in testJSWithDeps', function () {
	let mockResources;

	beforeEach(function () {
		// Create mock resources
		mockResources = {
			isWorker: true,
			set: () => {},
		};

		// Ensure no global variables from previous tests
		delete global.globalVariableFromParent;
		delete global.globalVariableFromComponent;
	});

	afterEach(function () {
		// Clean up global variables
		delete global.globalVariableFromParent;
		delete global.globalVariableFromComponent;
	});

	it('should isolate global variables when loading the component', async function () {
		// Set a global variable in the parent context
		global.globalVariableFromParent = 'parent-value';

		// Load the component from the fixtures directory
		const componentDir = path.join(__dirname, 'fixtures', 'testJSWithDeps');

		await loadComponent(componentDir, mockResources, 'test-origin', false);

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
	});
});
