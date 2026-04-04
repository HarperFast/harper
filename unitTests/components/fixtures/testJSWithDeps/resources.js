import assert from 'node:assert'; // verify we can access safe node built-in modules
import { Resource, getContext } from 'harper';
import { MyComponent, connect as connectFromChild } from './child-dir/in-child-dir.js';
import { connect } from 'mqtt'; // verify we can import from node_modules packages
import { testValue } from 'fake-package'; // verify we can import from *our* node_modules packages
import { fork, spawn } from 'node:child_process';

assert.equal(testValue, 42);

console.log('Verifying we can access console.log in application');
// verify we can't access parent global variables
assert(typeof globalVariableFromParent, 'undefined', 'Global variable from parent value should not be present');

assert(connectFromChild === connect);
global.globalVariableFromComponent = 'test';

logger.warn?.('Logging from testJSWithDeps/resources.js');

assert({} instanceof Object);
assert([] instanceof Array);
assert(getContext());
export const testExport = {
	get() {
		let _a = MyComponent;
		return 'hello world';
	},
	async testLoadTypeScript() {
		return await import('./child-dir/typestrip.ts');
	},
	getDate() {
		return new Date();
	},
	getArray() {
		return [];
	},
};
export class TestComponent extends Resource {}

export { MyComponent as 'my-component' };

export const processSpawnTest = {
	get() {}, // make it look like a resource
	testFork() {
		// Fork should work (allowed command)
		const child = fork('npm', ['--version'], { name: 'test-npm-process' });
		assert(child.pid, 'Fork should return a process with a PID');
		return child;
	},
	testSpawnDisallowed() {
		// Spawn with disallowed command should throw
		try {
			spawn('curl', ['https://example.com'], { name: 'test-curl-process' });
			throw new Error('Should have thrown an error for disallowed command');
		} catch (err) {
			assert(err.message.includes('not allowed'), 'Should throw error about disallowed command');
		}
	},
	testSpawnWithoutName() {
		// Spawn without name should throw
		try {
			spawn('npm', ['build']);
			throw new Error('Should have thrown an error for missing name');
		} catch (err) {
			assert(err.message.includes('name'), 'Should throw error about missing name');
		}
	},
	testProcessReuse(childProcessPath) {
		// First call should fork a new process
		const child1 = fork(childProcessPath, [], { name: 'test-reuse-process' });
		assert(child1.pid, 'First fork should return a process with a PID');

		// Second call with same name should return wrapper for existing process
		const child2 = fork(childProcessPath, [], { name: 'test-reuse-process' });
		assert.equal(child1.pid, child2.pid, 'Second fork should return same PID');

		return { child1, child2 };
	},
};
