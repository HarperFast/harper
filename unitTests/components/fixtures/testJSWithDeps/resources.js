import assert from 'node:assert'; // verify we can access safe node built-in modules
import { Resource } from 'harperdb';
import { MyComponent, connect as connectFromChild } from './child-dir/in-child-dir.js';
import { connect } from 'mqtt'; // verify we can import from node_modules packages

console.log('Verifying we can access console.log in application');
// verify we can't access parent global variables
assert(typeof globalVariableFromParent, 'undefined', 'Global variable from parent value should not be present');

assert(connectFromChild === connect);
global.globalVariableFromComponent = 'test';
export const testExport = {
	get() {
		let a = MyComponent;
		return 'hello world';
	},
};
export class TestComponent extends Resource {}

export { MyComponent as 'my-component' };
