import { requestRestart, restartNeeded } from '@/components/requestRestart';
import assert from 'node:assert/strict';

describe('requestRestart', () => {
	it('should update the shared buffer', () => {
		assert.strictEqual(restartNeeded(), false);
		requestRestart();
		assert.strictEqual(restartNeeded(), true);
	});
});
