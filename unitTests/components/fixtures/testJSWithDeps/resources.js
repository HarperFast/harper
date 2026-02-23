import assert from 'node:assert'; // verify we can access safe node built-in modules
import { Resource, getContext } from 'harper';
import { MyComponent, connect as connectFromChild } from './child-dir/in-child-dir.js';
import { connect } from 'mqtt'; // verify we can import from node_modules packages

console.log('Verifying we can access console.log in application');
// verify we can't access parent global variables
assert(typeof globalVariableFromParent, 'undefined', 'Global variable from parent value should not be present');

assert(connectFromChild === connect);
global.globalVariableFromComponent = 'test';

logger.warn('Logging from testJSWithDeps/resources.js');

assert({} instanceof Object);
assert([] instanceof Array);
assert(getContext());
export const testExport = {
	get() {
		let _a = MyComponent;
		return 'hello world';
	},
};
export class TestComponent extends Resource {}

export { MyComponent as 'my-component' };
