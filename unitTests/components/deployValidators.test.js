'use strict';

const assert = require('node:assert');
const validator = require('#js/components/operationsValidation');

const invalid = (result) => assert.ok(result, 'expected a validation error');

describe('deployComponentValidator', () => {
	it('rejects retry-unsafe automatic rollback', () => {
		invalid(validator.deployComponentValidator({ project: 'my_app', revert_on_failure: true }));
	});

	it('rejects the removed staged-deploy contract fields instead of ignoring them', () => {
		// The schema allows unknown keys, so dropping these from it would have left a caller still sending
		// the (never-released) staged contract silently getting a full deploy — `activate: false` ignored,
		// the opposite of the intent. They fail fast and name the follow-on instead.
		invalid(validator.deployComponentValidator({ project: 'my_app', activate: false }));
		invalid(validator.deployComponentValidator({ project: 'my_app', two_phase: true }));
		invalid(validator.deployComponentValidator({ project: 'my_app', two_phase: false }));
		invalid(
			validator.deployComponentValidator({ project: 'my_app', deployment_id: '41faded8-6cf5-4a2a-95f8-863e7ea498fa' })
		);
		invalid(validator.deployComponentValidator({ project: 'my_app', _phase: 'stage' }));
	});

	it('rejects the caller-supplied internal deployment marker', () => {
		invalid(validator.deployComponentValidator({ project: 'my_app', _deploymentId: 'x' }));
	});

	it('preserves routing validation', () => {
		invalid(validator.deployComponentValidator({ project: 'my_app', package: 'npm:x', urlPath: '/a/./b' }));
		invalid(validator.deployComponentValidator({ project: 'my_app', package: 'npm:x', urlPath: '/a/../b' }));
	});
});
