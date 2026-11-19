const {
	requestRestart,
	requestRestartAfterDeploy,
	restartNeeded,
	resetRestartNeeded,
} = require('#src/components/requestRestart');
const assert = require('node:assert');

describe('requestRestart', () => {
	beforeEach(() => {
		// The buffer is process-wide and legitimately set by earlier suites: Scope
		// requests a restart when a watched config block or file is removed, and
		// fixture teardown in other test files deletes watched harperdb-config.yaml
		// files on chokidar's delayed unlink timer — sometimes several tests later.
		// This test's contract is the false→true transition, not that no prior test
		// ever requested a restart (same entry-reset convention as Scope.test.js).
		resetRestartNeeded();
	});

	it('should update the shared buffer', () => {
		assert.strictEqual(restartNeeded(), false);
		requestRestart();
		assert.strictEqual(restartNeeded(), true);
	});

	it('requests a restart when a deploy changes application isolation', () => {
		assert.strictEqual(requestRestartAfterDeploy(false, false, false, true), true);
		assert.strictEqual(restartNeeded(), true);

		resetRestartNeeded();
		assert.strictEqual(requestRestartAfterDeploy(false, false, true, false), true);
		assert.strictEqual(restartNeeded(), true);
	});

	it('keeps the existing new-component and package-metadata rules', () => {
		assert.strictEqual(requestRestartAfterDeploy(false, false, true, true), false);
		assert.strictEqual(restartNeeded(), false);
		assert.strictEqual(requestRestartAfterDeploy(true, false, false, false), true);

		resetRestartNeeded();
		assert.strictEqual(requestRestartAfterDeploy(false, true, false, false), true);
	});
});
