const assert = require('node:assert');
const { getDatabases } = require('#src/utility/databasesRef');
require.resolve('#src/resources/databases');
describe('a utility-only source suite', () => {
	it('does not initialize the database registry', () => assert.deepStrictEqual(getDatabases(), {}));
});
