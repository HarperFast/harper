'use strict';

const assert = require('node:assert');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { internal, statusForComponent, STATUS } = require('#src/components/status/index');
const { runWithDeployValidationGuard } = require('#src/server/serverHelpers/deployValidationState');

// Deploy pre-flight validation loads the CANDIDATE's code under the real component's name, so a candidate
// that throws would mark the live component ERROR. Its writes are diverted into the guard's throwaway sink
// rather than written and reverted, because the live component keeps serving through that window.
describe('component status during throwaway validation', () => {
	const registry = internal.componentStatusRegistry;

	it('leaves the live status untouched when a candidate fails to load', async () => {
		statusForComponent('restore-probe').healthy('All components loaded successfully');

		await runWithDeployValidationGuard(async () => {
			statusForComponent('restore-probe').error('candidate threw at load');
		});

		const after = registry.getStatus('restore-probe');
		assert.strictEqual(after.status, STATUS.HEALTHY, 'the live component is still healthy');
		assert.strictEqual(after.message, 'All components loaded successfully', 'and keeps its original message');
	});

	it('diverts plugin-scoped keys too, not just the bare component name', async () => {
		// Nested loads report under scoped keys, so a candidate's plugin-scoped ERROR would otherwise make
		// the component report unhealthy through a plugin that never went live.
		statusForComponent('ns-probe').healthy('All components loaded successfully');
		statusForComponent('ns-probe.api').healthy('plugin ready');

		await runWithDeployValidationGuard(async () => {
			statusForComponent('ns-probe.api').error('candidate plugin threw');
			statusForComponent('ns-probe.newly-added').error('only the candidate had this');
		});

		assert.strictEqual(registry.getStatus('ns-probe.api').status, STATUS.HEALTHY, 'the plugin is still healthy');
		assert.strictEqual(
			registry.getStatus('ns-probe.newly-added'),
			undefined,
			'and a key only the candidate introduced never reached the live registry'
		);
		assert.strictEqual(registry.getStatus('ns-probe').status, STATUS.HEALTHY);
	});

	it('writes no status at all for a first-ever deploy that fails validation', async () => {
		assert.strictEqual(registry.getStatus('never-seen'), undefined, 'precondition: unknown component');

		await runWithDeployValidationGuard(async () => {
			statusForComponent('never-seen').error('candidate threw at load');
		});

		assert.strictEqual(registry.getStatus('never-seen'), undefined, 'nothing is left behind');
	});

	it('keeps a genuine report the LIVE component makes while a validation is in flight', async () => {
		// The reason this is a sink rather than a snapshot restored afterwards. `statusForComponent()` is a
		// public API the live component's own runtime code may call at any time — a health check, a reconnect
		// handler — and it keeps serving throughout the window. Reverting a snapshot would silently discard
		// that report, and an edge-triggered reporter would never re-send it.
		statusForComponent('live-probe').healthy('serving');
		// Scheduled BEFORE the deploy starts, exactly like a health-check timer or socket callback the live
		// component installed when it loaded, so it runs in the outer async context rather than the
		// validation's. Awaited from inside the guard so it definitely fires during the window.
		const liveReport = new Promise((resolve) => {
			setImmediate(() => {
				statusForComponent('live-probe').error('database connection lost');
				resolve();
			});
		});

		await runWithDeployValidationGuard(async () => {
			statusForComponent('live-probe').error('candidate threw at load');
			// THE assertion that discriminates. Checking only the final state below would pass on last-write-
			// wins alone, since the live write is scheduled to land second either way. `getAllStatuses()`
			// answers from the live map — `getStatus()` deliberately answers from the sink in here — so this
			// is what actually observes whether the candidate's write escaped.
			const liveDuringValidation = registry.getAllStatuses().get('live-probe');
			assert.strictEqual(
				liveDuringValidation.status,
				STATUS.HEALTHY,
				"the candidate's write never reached the live registry"
			);
			assert.strictEqual(liveDuringValidation.message, 'serving');
			await liveReport;
		});

		const after = registry.getStatus('live-probe');
		assert.strictEqual(after.status, STATUS.ERROR, "the live component's own report survived");
		assert.strictEqual(
			after.message,
			'database connection lost',
			"and it is the live report that is recorded, not the candidate's"
		);
	});

	it('shows a candidate its own writes, never the live object', async () => {
		statusForComponent('read-probe').healthy('serving');

		await runWithDeployValidationGuard(async () => {
			statusForComponent('read-probe').warning('candidate is degraded');
			assert.strictEqual(
				registry.getStatus('read-probe').status,
				STATUS.WARNING,
				'the candidate reads back what it just wrote, not the live value'
			);
			// The returned object is mutable, so handing back the live one would let candidate code edit the
			// serving component's status in place and bypass the diversion entirely.
			registry.getStatus('read-probe').markHealthy('mutated in place by candidate code');
		});

		const after = registry.getStatus('read-probe');
		assert.strictEqual(after.status, STATUS.HEALTHY);
		assert.strictEqual(after.message, 'serving', 'the live status was never mutated');
	});

	it('hands a validation a detached error it cannot mutate back into the live status', async () => {
		const cause = new Error('socket closed');
		const live = new Error('database connection lost');
		live.cause = cause;
		live.code = 'ECONNRESET';
		live.detail = { host: 'db-1', port: 5432 };
		statusForComponent('error-probe').error('database connection lost', live);

		await runWithDeployValidationGuard(async () => {
			const seen = registry.getStatus('error-probe').error;
			assert.notStrictEqual(seen, live, 'the live Error object itself is never handed out');
			assert.strictEqual(seen.message, 'database connection lost', 'but it reads the same');
			assert.strictEqual(seen.code, 'ECONNRESET', 'including its own properties');
			// Reachable through the public statusForComponent(...).get() path, so a candidate could otherwise
			// edit the serving component's own error object.
			seen.message = 'mutated by candidate code';
			seen.code = 'MUTATED';
			// Nested state too: an object property copied by reference would leave a mutable handle into the
			// live error after all.
			seen.detail.host = 'mutated';
		});

		assert.strictEqual(registry.getStatus('error-probe').error.message, 'database connection lost');
		assert.strictEqual(registry.getStatus('error-probe').error.code, 'ECONNRESET');
		assert.strictEqual(registry.getStatus('error-probe').error.detail.host, 'db-1', 'nested state survived too');
		assert.strictEqual(live.cause, cause, 'and the live error still holds its own cause');
	});
});
