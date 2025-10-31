import { requestRestart, restartNeeded } from '@/components/requestRestart';
import assert from 'node:assert/strict';
import { cleanupTestSandbox, createTestSandbox } from '../testUtils';

describe('requestRestart', () => {
	before(createTestSandbox);
	after(cleanupTestSandbox);

	it('should update the shared buffer', () => {
		assert.strictEqual(restartNeeded(), false);
		requestRestart();
		assert.strictEqual(restartNeeded(), true);
	});
});
