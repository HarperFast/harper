const assert = require('node:assert');
describe('failure fixture', () => {
	it('fails intentionally', () => assert.fail('intentional unit runner failure'));
});
