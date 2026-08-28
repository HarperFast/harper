'use strict';

const assert = require('node:assert');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { internal, statusForComponent, STATUS } = require('#src/components/status/index');

// Deploy pre-flight validation loads the CANDIDATE's code under the real component's name, so a candidate
// that throws marks the live component ERROR. Validation then rejects and the previous version keeps
// serving — the status has to go back, or a healthy component reports as broken for as long as it runs.
describe('component status restore after throwaway validation', () => {
	const registry = internal.componentStatusRegistry;

	it('puts a previous status back, message and level intact', () => {
		statusForComponent('restore-probe').healthy('All components loaded successfully');
		const before = registry.getStatus('restore-probe');

		// What a rejected candidate load leaves behind.
		statusForComponent('restore-probe').error(new Error('candidate threw at load'));
		assert.strictEqual(registry.getStatus('restore-probe').status, STATUS.ERROR);

		registry.restoreStatus('restore-probe', before);

		const after = registry.getStatus('restore-probe');
		assert.strictEqual(after.status, STATUS.HEALTHY, 'the live component is healthy again');
		assert.strictEqual(after.message, 'All components loaded successfully', 'and keeps its original message');
	});

	it('restores plugin-scoped keys too, not just the bare component name', () => {
		// Nested loads report under scoped keys. Restoring only `web` left a candidate's plugin-scoped ERROR
		// behind, so the component reported unhealthy through a plugin that never went live.
		statusForComponent('ns-probe').healthy('All components loaded successfully');
		statusForComponent('ns-probe.api').healthy('plugin ready');
		const before = registry.snapshotNamespace('ns-probe');

		statusForComponent('ns-probe.api').error(new Error('candidate plugin threw'));
		statusForComponent('ns-probe.newly-added').error(new Error('only the candidate had this'));

		registry.restoreNamespace('ns-probe', before);

		assert.strictEqual(registry.getStatus('ns-probe.api').status, STATUS.HEALTHY, 'the plugin is healthy again');
		assert.strictEqual(
			registry.getStatus('ns-probe.newly-added'),
			undefined,
			'and a key only the candidate introduced is gone'
		);
		assert.strictEqual(registry.getStatus('ns-probe').status, STATUS.HEALTHY);
	});

	it('removes the entry when there was no status before', () => {
		assert.strictEqual(registry.getStatus('never-seen'), undefined, 'precondition: unknown component');
		statusForComponent('never-seen').error(new Error('candidate threw at load'));
		assert.ok(registry.getStatus('never-seen'), 'the validation load wrote one');

		registry.restoreStatus('never-seen', undefined);

		assert.strictEqual(
			registry.getStatus('never-seen'),
			undefined,
			'a first-ever deploy that fails validation leaves no status behind'
		);
	});
});
