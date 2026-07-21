'use strict';

// Validators for the two-phase deploy operations. Uses node:assert (not chai) and loads only
// operationsValidation (Joi + config helpers), so it runs without the private agent dependency that
// componentLoader pulls in.

const assert = require('node:assert');
const validator = require('#js/components/operationsValidation');

// validateBySchema returns a truthy validation error when invalid, undefined when valid.
const ok = (result) => assert.strictEqual(result, undefined, `expected valid, got: ${result && result.message}`);
const rejected = (result) => assert.ok(result, 'expected a validation error');

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

describe('deployComponentValidator two-phase props (activate / deployment_id / flags)', () => {
	it('accepts activate: false (stage-and-stop)', () => {
		ok(validator.deployComponentValidator({ project: 'my_app', activate: false }));
	});

	it('accepts a deployment_id (activate an existing stage)', () => {
		ok(
			validator.deployComponentValidator({ project: 'my_app', deployment_id: '41faded8-6cf5-4a2a-95f8-863e7ea498fa' })
		);
	});

	it('rejects a path-traversal deployment_id (it becomes a staging-dir path segment)', () => {
		for (const bad of ['../evil', 'a/b', 'dep/../..', '.', '..']) {
			rejected(validator.deployComponentValidator({ project: 'my_app', deployment_id: bad }));
		}
	});

	it('accepts revert_on_failure: true', () => {
		ok(validator.deployComponentValidator({ project: 'my_app', package: 'npm:x', revert_on_failure: true }));
	});

	it('accepts two_phase: false (legacy opt-out) and true', () => {
		ok(validator.deployComponentValidator({ project: 'my_app', package: 'npm:x', two_phase: false }));
		ok(validator.deployComponentValidator({ project: 'my_app', package: 'npm:x', two_phase: true }));
	});

	it('rejects a non-boolean two_phase', () => {
		rejected(validator.deployComponentValidator({ project: 'my_app', package: 'npm:x', two_phase: 'yes' }));
	});
});
