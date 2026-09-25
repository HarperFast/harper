'use strict';

// The origin of a replicated deploy_component waits for each peer's answer. That wait is bounded so a peer
// that never answers cannot hold the origin's operation, deployment row and restart forever, but it must
// never be shorter than what a healthy peer is allowed for the same request, or a slow success is reported
// as a failure.

const assert = require('node:assert');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { peerDeployAnswerTimeoutMs } = require('#src/components/operations');
const { componentPreparationBudgetMs } = require('#src/components/Application');
const { DEFAULT_AWAIT_ROW_TIMEOUT_MS } = require('#src/components/deploymentRecorder');
const { RESTART_WAIT_CEILING_MS } = require('#src/components/awaitRestart');

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

describe('peerDeployAnswerTimeoutMs', function () {
	it("covers the peer's payload wait and every extraction and install command at its default allowance", function () {
		const timeoutMs = peerDeployAnswerTimeoutMs({ operation: 'deploy_component', project: 'app' });
		assert.ok(
			timeoutMs >= DEFAULT_AWAIT_ROW_TIMEOUT_MS + 4 * HOUR + 2 * HOUR,
			`${timeoutMs}ms does not cover four extraction commands and two install commands`
		);
		assert.ok(timeoutMs >= DEFAULT_AWAIT_ROW_TIMEOUT_MS + componentPreparationBudgetMs());
	});

	it('scales with install_timeout for both install commands', function () {
		const shorter = peerDeployAnswerTimeoutMs({ install_timeout: 10 * MINUTE });
		const longer = peerDeployAnswerTimeoutMs({ install_timeout: 30 * MINUTE });
		assert.strictEqual(longer - shorter, 2 * 20 * MINUTE);
	});

	it('adds the deployment_timeout payload wait, twice when the peer must also wait for credential references', function () {
		const base = peerDeployAnswerTimeoutMs({ deployment_timeout: 0 });
		assert.strictEqual(peerDeployAnswerTimeoutMs({ deployment_timeout: 5 * MINUTE }) - base, 5 * MINUTE);
		assert.strictEqual(
			peerDeployAnswerTimeoutMs({
				deployment_timeout: 5 * MINUTE,
				credentials: [{ registry: 'https://npm.pkg.github.com', secret: 'deploy.app.npm' }],
			}) - base,
			10 * MINUTE
		);
	});

	it('adds the restart ceiling only when the peer restarts before answering', function () {
		const withoutRestart = peerDeployAnswerTimeoutMs({ restart: false });
		assert.strictEqual(peerDeployAnswerTimeoutMs({ restart: true }) - withoutRestart, RESTART_WAIT_CEILING_MS);
		// A rolling restart is cleared on the replicated request, so peers answer before any restart.
		assert.strictEqual(peerDeployAnswerTimeoutMs({ restart: 'rolling' }), withoutRestart);
	});

	it('reads the numeric strings a JSON or multipart client sends', function () {
		assert.strictEqual(
			peerDeployAnswerTimeoutMs({ deployment_timeout: '300000', install_timeout: '600000' }),
			peerDeployAnswerTimeoutMs({ deployment_timeout: 300000, install_timeout: 600000 })
		);
	});

	it('never exceeds the longest delay a timer can hold', function () {
		assert.strictEqual(peerDeployAnswerTimeoutMs({ install_timeout: 2 ** 40 }), 2 ** 31 - 1);
	});
});
