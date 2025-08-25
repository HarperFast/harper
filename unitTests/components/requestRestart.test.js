const { requestRestart, restartNeeded } = require('../../components/requestRestart');
const assert = require('node:assert/strict');

describe('requestRestart', () => {
	it('should update the shared buffer', () => {
		assert.strictEqual(restartNeeded(), false);
		requestRestart();
		assert.strictEqual(restartNeeded(), true);
	});
});
