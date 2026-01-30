import assert from 'node:assert'; // verify we can access safe node built-in modules
import { Resource } from 'harperdb';
import { connect } from 'mqtt'; // verify we can import from node_modules packages
import 'micromatch';
import 'needle';
// TODO: Verify/support circular dependencies
console.log('Verifying we can access console.log in transitive module in application');
// verify we can't access parent global variables
assert(typeof globalVariableFromParent, 'undefined', 'Global variable from parent value should not be present');

export class MyComponent extends Resource {}
export { connect };
