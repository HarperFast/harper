const assert = require('node:assert/strict');
const path = require('node:path');
const { loadComponent, loadedPaths } = require('#src/components/componentLoader');
const { PACKAGE_ROOT } = require('#js/utility/packageUtils');
const fs = require('node:fs');
const env = require('#src/utility/environment/environmentManager');
const { ApplicationScope } = require('#js/components/ApplicationScope');

describe('Global Variable Isolation in testJSWithDeps', function () {
	let mockResources;
	let pidsDir;

	beforeEach(function () {
		// Create mock resources
		mockResources = new Map();
		mockResources.isWorker = true;

		// Ensure no global variables from previous tests
		delete global.globalVariableFromComponent;
		// Set a global variable in the parent context
		global.globalVariableFromParent = 'parent-value';
		loadedPaths.clear();

		// Clean up pids directory
		const basePath = env.getHdbBasePath();
		pidsDir = path.join(basePath, 'pids');
		if (fs.existsSync(pidsDir)) {
			fs.rmSync(pidsDir, { recursive: true, force: true });
		}
	});

	afterEach(function () {
		// Clean up global variables
		delete global.globalVariableFromParent;
		delete global.globalVariableFromComponent;

		// Clean up pids directory
		if (fs.existsSync(pidsDir)) {
			fs.rmSync(pidsDir, { recursive: true, force: true });
		}
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
		assert.equal(mockResources.get('/'), undefined); // this will contain an error if it failed to load
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
		assert((await mockResources.get('/testExport').testLoadTypeScript()).isTyped, 'TypeScript exports');
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

	it('should enforce process spawning restrictions', async function () {
		let applicationScope = new ApplicationScope('test', mockResources, server);
		Object.assign(applicationScope, {
			mode: 'vm',
			dependencyContainment: false,
			verifyPath: PACKAGE_ROOT,
		});
		await loadComponent(componentDir, mockResources, 'test-origin', {
			applicationScope,
		});

		const processSpawnTest = mockResources.get('/processSpawnTest');

		// Test that disallowed commands throw
		processSpawnTest.testSpawnDisallowed();

		// Test that spawn without name throws
		processSpawnTest.testSpawnWithoutName();
	});

	it('should allow fork with allowed commands', async function () {
		let applicationScope = new ApplicationScope('test', mockResources, server);
		Object.assign(applicationScope, {
			mode: 'vm',
			dependencyContainment: false,
			verifyPath: PACKAGE_ROOT,
		});
		await loadComponent(componentDir, mockResources, 'test-origin', {
			applicationScope,
		});

		const processSpawnTest = mockResources.get('/processSpawnTest');

		// Test that fork works
		const child = processSpawnTest.testFork();
		assert(child.pid, 'Should return a child process with PID');

		// Clean up
		child.kill();
	});

	it('should reuse existing processes with same name', async function () {
		this.timeout(10000); // Increase timeout for process spawning

		let applicationScope = new ApplicationScope('test', mockResources, server);
		Object.assign(applicationScope, {
			mode: 'vm',
			dependencyContainment: false,
			verifyPath: PACKAGE_ROOT,
		});
		await loadComponent(componentDir, mockResources, 'test-origin', {
			applicationScope,
		});

		const processSpawnTest = mockResources.get('/processSpawnTest');
		const childProcessPath = path.join(componentDir, 'test-child-process.js');

		// Test process reuse
		const { child1, child2 } = processSpawnTest.testProcessReuse(childProcessPath);

		// Verify both have same PID
		assert.equal(child1.pid, child2.pid, 'Should reuse existing process');

		// Verify exit event is emitted on wrapper
		await new Promise((resolve) => {
			child2.on('exit', resolve);
			child1.kill();
		});
	});

	it('should handle ESM circular dependencies correctly', async function () {
		let applicationScope = new ApplicationScope('test', mockResources, server);
		Object.assign(applicationScope, {
			mode: 'vm',
			dependencyContainment: false,
			verifyPath: PACKAGE_ROOT,
		});
		await loadComponent(componentDir, mockResources, 'test-origin', {
			applicationScope,
		});

		// The circular.js and in-child-dir.js have circular imports
		// If they loaded successfully, circular dependencies work
		// The test is in in-child-dir.js line 18: assert.equal(testCircularExport(), MyComponent)
		assert(mockResources.get('/testExport'), 'Should load with circular dependencies');
	});

	it('should handle CJS circular dependencies correctly', async function () {
		const { scopedImport } = require('#src/security/jsLoader');
		let applicationScope = new ApplicationScope('test', mockResources, server);
		Object.assign(applicationScope, {
			mode: 'vm',
			dependencyContainment: false,
			verifyPath: PACKAGE_ROOT,
		});

		const cjsModuleA = await scopedImport(
			path.join(componentDir, 'cjs-circular-a.cjs'),
			applicationScope
		);

		// Should successfully load circular CJS modules
		assert.equal(cjsModuleA.valueA, 'from-a', 'Should have valueA');
		assert.equal(cjsModuleA.valueB, 'from-b', 'Should have valueB from circular import');
		assert.equal(cjsModuleA.combined(), 'from-a-from-b', 'Should combine values from both modules');
	});

	it('should load packages that depend on harper through VM', async function () {
		const { scopedImport } = require('#src/security/jsLoader');
		let applicationScope = new ApplicationScope('test', mockResources, server);
		Object.assign(applicationScope, {
			mode: 'vm',
			dependencyContainment: false, // Default to native loading
			verifyPath: PACKAGE_ROOT,
		});

		// harper-dependent-package has harper in its dependencies, so should use VM
		const harperPkg = await scopedImport(
			path.join(componentDir, 'node_modules', 'harper-dependent-package', 'index.js'),
			applicationScope
		);

		assert(harperPkg.HarperDependentResource, 'Should load package that depends on harper');
		assert.equal(harperPkg.usesHarper, true, 'Should have access to harper exports');
	});

	it('should load packages without harper dependency natively', async function () {
		const { scopedImport } = require('#src/security/jsLoader');
		let applicationScope = new ApplicationScope('test', mockResources, server);
		Object.assign(applicationScope, {
			mode: 'vm',
			dependencyContainment: false, // Default to native loading
			verifyPath: PACKAGE_ROOT,
		});

		// fake-package doesn't depend on harper, should load natively (not through VM)
		// This avoids context isolation issues with packages like vite
		const fakePkg = await scopedImport(
			path.join(componentDir, 'node_modules', 'fake-package', 'index.js'),
			applicationScope
		);

		// Should load successfully without VM context issues
		assert(fakePkg, 'Should load package without harper dependency');
	});

	it('should handle CJS modules from node_modules correctly', async function () {
		let applicationScope = new ApplicationScope('test', mockResources, server);
		Object.assign(applicationScope, {
			mode: 'vm',
			dependencyContainment: false,
			verifyPath: PACKAGE_ROOT,
		});
		await loadComponent(componentDir, mockResources, 'test-origin', {
			applicationScope,
		});

		// mqtt is a CJS module that should be detected and loaded properly
		// The test imports { connect } from 'mqtt' in in-child-dir.js
		// If it loaded without error, CJS detection works
		assert(mockResources.get('/testExport'), 'Should load CJS packages with named exports');
	});
});
