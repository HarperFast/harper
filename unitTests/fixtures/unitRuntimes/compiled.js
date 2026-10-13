const assert = require('node:assert');
const { types } = require('node:util');
const env = require('#js/utility/environment/environmentManager');

describe('compiled lane fixture', () => {
	it('uses the same mutable namespace for both aliases', () => {
		assert.strictEqual(require('#src/utility/environment/environmentManager'), env);
		assert(!types.isModuleNamespaceObject(env));
		assert(require.resolve('#js/utility/hdbTerms').includes('/dist/'));
	});
});
