'use strict';

const assert = require('node:assert/strict');
const validator = require('#js/components/operationsValidation');

const valid = (result) => assert.equal(result, undefined, `expected valid, got: ${result?.message}`);
const invalid = (result) => assert.ok(result, 'expected a validation error');

describe('deployComponentValidator two-phase controls', () => {
	it('accepts stage-and-stop and UUID activation', () => {
		valid(validator.deployComponentValidator({ project: 'my_app', activate: false }));
		valid(
			validator.deployComponentValidator({
				project: 'my_app',
				deployment_id: '41faded8-6cf5-4a2a-95f8-863e7ea498fa',
			})
		);
	});

	it('requires deployment_id to be a UUID and rejects path traversal', () => {
		for (const deploymentId of ['abc-123', '../evil', 'dep/../..', '.', '..']) {
			invalid(validator.deployComponentValidator({ project: 'my_app', deployment_id: deploymentId }));
		}
	});

	it('rejects caller-controlled internal phase markers', () => {
		invalid(validator.deployComponentValidator({ project: 'my_app', _deploymentId: 'x' }));
		invalid(validator.deployComponentValidator({ project: 'my_app', _phase: 'stage' }));
	});

	it('rejects retry-unsafe automatic rollback', () => {
		invalid(validator.deployComponentValidator({ project: 'my_app', revert_on_failure: true }));
	});

	it('preserves routing validation', () => {
		invalid(validator.deployComponentValidator({ project: 'my_app', package: 'npm:x', urlPath: '/a/./b' }));
		invalid(validator.deployComponentValidator({ project: 'my_app', package: 'npm:x', urlPath: '/a/../b' }));
	});
});

describe('componentDeployPhaseValidator', () => {
	const validPhase = {
		phase: 'stage',
		deployment_id: '41faded8-6cf5-4a2a-95f8-863e7ea498fa',
		project: 'my_app',
		activation_spec: { project: 'my_app' },
	};

	it('accepts a bounded internal phase request', () => {
		valid(validator.componentDeployPhaseValidator(validPhase));
	});

	it('rejects invalid phases, project traversal, and non-UUID ids', () => {
		invalid(validator.componentDeployPhaseValidator({ ...validPhase, phase: 'deploy' }));
		invalid(validator.componentDeployPhaseValidator({ ...validPhase, project: '../escape' }));
		invalid(validator.componentDeployPhaseValidator({ ...validPhase, deployment_id: '../../escape' }));
	});
});
