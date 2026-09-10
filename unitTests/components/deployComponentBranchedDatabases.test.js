'use strict';

const assert = require('node:assert');
const validator = require('#js/components/operationsValidation');

// deployComponentValidator returns undefined when valid and an Error when invalid.
const valid = (res) => res === undefined;

describe('deployComponentValidator branchedDatabases (harper#643)', () => {
	const base = { project: 'myapp', package: 'x' };

	it('accepts an array of database names', () => {
		assert.ok(valid(validator.deployComponentValidator({ ...base, branchedDatabases: ['data'] })));
	});

	it('accepts `true`', () => {
		assert.ok(valid(validator.deployComponentValidator({ ...base, branchedDatabases: true })));
	});

	it('accepts an absent declaration', () => {
		assert.ok(valid(validator.deployComponentValidator(base)));
	});

	it('rejects a shape that is neither an array nor `true`, with the reason from assertBranchedDatabases', () => {
		const error = validator.deployComponentValidator({ ...base, branchedDatabases: 'data' });
		assert.ok(error);
		assert.match(error.message, /expected an array or true/);
	});

	it('rejects branching the system database, with the reason from assertBranchedDatabases', () => {
		const error = validator.deployComponentValidator({ ...base, branchedDatabases: ['system'] });
		assert.ok(error);
		assert.match(error.message, /'system' database cannot be branched/);
	});
});
