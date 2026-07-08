const { requestRestart, restartNeeded } = require('#src/components/requestRestart');
const assert = require('node:assert');

describe('requestRestart', () => {
	it('should update the shared buffer', () => {
		assert.strictEqual(restartNeeded(), false);
		requestRestart();
		assert.strictEqual(restartNeeded(), true);
	});
});
