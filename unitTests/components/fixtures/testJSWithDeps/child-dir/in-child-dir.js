import assert from 'node:assert'; // verify we can access safe node built-in modules
import { Resource } from 'harperdb'; // alternate names
import { Resource as Resource2 } from '@harperfast/harper';
import { connect } from 'mqtt'; // verify we can import from node_modules packages
import 'micromatch';
import 'needle';
import { testCircularExport } from './circular.js';
// TODO: Verify/support circular dependencies
console.log('Verifying we can access console.log in transitive module in application');
assert(testCircularExport);
assert.equal(Resource, Resource2);
// verify we can't access parent global variables
assert(typeof globalVariableFromParent, 'undefined', 'Global variable from parent value should not be present');

export class MyComponent extends Resource {}
export { connect };

assert.equal(testCircularExport(), MyComponent);
