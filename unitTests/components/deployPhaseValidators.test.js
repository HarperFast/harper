'use strict';

// Validators for the two-phase deploy operations. Uses node:assert (not chai) and loads only
// operationsValidation (Joi + config helpers), so it runs without the private agent dependency that
// componentLoader pulls in.

const assert = require('node:assert');
const validator = require('#js/components/operationsValidation');

// validateBySchema returns a truthy validation error when invalid, undefined when valid.
const ok = (result) => assert.strictEqual(result, undefined, `expected valid, got: ${result && result.message}`);
const rejected = (result) => assert.ok(result, 'expected a validation error');

describe('stageComponentValidator', () => {
	it('accepts a project-only request', () => {
		ok(validator.stageComponentValidator({ project: 'my_app' }));
	});

	it('accepts a package deploy with install options', () => {
		ok(
			validator.stageComponentValidator({
				project: 'my_app',
				package: 'npm:@org/thing',
				install_command: 'npm ci',
				install_timeout: 60000,
				install_allow_scripts: false,
				deployment_timeout: 120000,
			})
		);
	});

	it('requires a project', () => {
		rejected(validator.stageComponentValidator({ package: 'npm:@org/thing' }));
	});

	it('rejects an invalid project name', () => {
		rejected(validator.stageComponentValidator({ project: 'bad/name' }));
	});

	it('rejects a urlPath containing ".."', () => {
		rejected(validator.stageComponentValidator({ project: 'my_app', package: 'npm:x', urlPath: '/a/../b' }));
	});
});

describe('activateComponentValidator', () => {
	it('accepts a project + deployment_id', () => {
		ok(validator.activateComponentValidator({ project: 'my_app', deployment_id: 'abc-123' }));
	});

	it('accepts a rolling restart', () => {
		ok(validator.activateComponentValidator({ project: 'my_app', deployment_id: 'abc-123', restart: 'rolling' }));
	});

	it('accepts a boolean restart and ignore_replication_errors', () => {
		ok(
			validator.activateComponentValidator({
				project: 'my_app',
				deployment_id: 'abc-123',
				restart: true,
				ignore_replication_errors: true,
			})
		);
	});

	it('requires a project', () => {
		rejected(validator.activateComponentValidator({ deployment_id: 'abc-123' }));
	});

	it('rejects an invalid restart value', () => {
		rejected(validator.activateComponentValidator({ project: 'my_app', restart: 'sideways' }));
	});
});

describe('revertComponentValidator', () => {
	it('accepts a project-only revert', () => {
		ok(validator.revertComponentValidator({ project: 'my_app' }));
	});

	it('accepts a deployment_id, restart, and ignore_replication_errors', () => {
		ok(
			validator.revertComponentValidator({
				project: 'my_app',
				deployment_id: 'abc-123',
				restart: 'rolling',
				ignore_replication_errors: true,
			})
		);
	});

	it('requires a project', () => {
		rejected(validator.revertComponentValidator({ deployment_id: 'abc-123' }));
	});

	it('rejects an invalid restart value', () => {
		rejected(validator.revertComponentValidator({ project: 'my_app', restart: 'sideways' }));
	});
});

describe('deployComponentValidator two_phase + revert_on_failure flags', () => {
	it('accepts revert_on_failure: true', () => {
		ok(validator.deployComponentValidator({ project: 'my_app', package: 'npm:x', revert_on_failure: true }));
	});

	it('accepts two_phase: false (legacy opt-out)', () => {
		ok(validator.deployComponentValidator({ project: 'my_app', package: 'npm:x', two_phase: false }));
	});

	it('accepts two_phase: true', () => {
		ok(validator.deployComponentValidator({ project: 'my_app', package: 'npm:x', two_phase: true }));
	});

	it('rejects a non-boolean two_phase', () => {
		rejected(validator.deployComponentValidator({ project: 'my_app', package: 'npm:x', two_phase: 'yes' }));
	});
});
