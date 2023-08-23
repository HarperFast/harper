'use strict';

const chai = require('chai');
const { expect } = chai;
const bulkDeleteValidator = require('../../validation/bulkDeleteValidator');

describe('Test bulkDeleteValidator module', () => {
	it('Test table required returned', () => {
		const test_del_obj = {
			schema: 'dev',
			date: '2021-01-25T23:05:27.464',
		};
		const result = bulkDeleteValidator(test_del_obj, 'date');
		expect(result.message).to.equal("'table' is required");
	});

	it('Test date required returned', () => {
		const test_del_obj = {
			schema: 'dev',
			table: 'dog',
		};
		const result = bulkDeleteValidator(test_del_obj, 'date');
		expect(result.message).to.equal("'date' is required");
	});

	it('Test invalid date returned', () => {
		const test_del_obj = {
			schema: 'dev',
			table: 'dog',
			date: 1598290282817,
		};
		const result = bulkDeleteValidator(test_del_obj, 'date');
		expect(result.message).to.equal("'date' must be a valid date");
	});

	it('Test timestamp required returned', () => {
		const test_del_obj = {
			schema: 'dev',
			table: 'dog',
		};
		const result = bulkDeleteValidator(test_del_obj, 'timestamp');
		expect(result.message).to.equal("'timestamp' is required");
	});

	it('Test invalid timestamp returned', () => {
		const test_del_obj = {
			schema: 'dev',
			table: 'dog',
			timestamp: '2021-01-25T23:05:27.464',
		};
		const result = bulkDeleteValidator(test_del_obj, 'timestamp');
		expect(result.message).to.equal("'timestamp' is invalid");
	});
});
