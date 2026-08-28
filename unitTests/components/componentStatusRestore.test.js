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
