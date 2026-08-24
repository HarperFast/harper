'use strict';

const assert = require('node:assert');
const validator = require('#js/components/operationsValidation');

const invalid = (result) => assert.ok(result, 'expected a validation error');

describe('deployComponentValidator', () => {
	it('rejects retry-unsafe automatic rollback', () => {
		invalid(validator.deployComponentValidator({ project: 'my_app', revert_on_failure: true }));
	});

	it('rejects the caller-supplied internal deployment marker', () => {
		invalid(validator.deployComponentValidator({ project: 'my_app', _deploymentId: 'x' }));
	});

	it('preserves routing validation', () => {
		invalid(validator.deployComponentValidator({ project: 'my_app', package: 'npm:x', urlPath: '/a/./b' }));
		invalid(validator.deployComponentValidator({ project: 'my_app', package: 'npm:x', urlPath: '/a/../b' }));
	});
});
