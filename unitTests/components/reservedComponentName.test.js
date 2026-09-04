'use strict';

const assert = require('node:assert');
const validator = require('#js/components/operationsValidation');
const { isReservedComponentName } = require('#src/utility/componentNames');

// The validators return undefined when valid and an Error when invalid.
describe('reserved component names', () => {
	it("reserves 'sql', the root config key that configures the SQL engine", () => {
		assert.ok(isReservedComponentName('sql'));
		assert.ok(!isReservedComponentName('sql-tools'));
		assert.ok(!isReservedComponentName('mysql'));
	});

	it('add_component refuses to create a project under a reserved name', () => {
		const error = validator.addComponentValidator({ project: 'sql' });
		assert.ok(error);
		assert.match(error.message, /Component name 'sql' is reserved/);
	});

	it('add_component does not refuse a name that merely contains a reserved one', () => {
		const error = validator.addComponentValidator({ project: 'sql-tools' });
		// The project may still be rejected for existing already; only the reservation is under test.
		if (error) assert.doesNotMatch(error.message, /is reserved/);
	});

	it('set_component_file refuses to bring a reserved-name project into existence', () => {
		const error = validator.setComponentFileValidator({ project: 'sql', file: 'resources.js', payload: '' });
		assert.ok(error);
		assert.match(error.message, /Component name 'sql' is reserved/);
	});

	it('deploy_component refuses a reserved name, with or without force', () => {
		for (const request of [
			{ project: 'sql', package: '@org/sql-app' },
			{ project: 'sql', package: '@org/sql-app', force: true },
		]) {
			const error = validator.deployComponentValidator(request);
			assert.ok(error);
			assert.match(error.message, /Component name 'sql' is reserved/);
		}
	});
});
