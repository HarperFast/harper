'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const sinon = require('sinon');
const searchValidator = require('#src/validation/searchValidator').default;
const { getDatabases } = require('#src/resources/databases');
const common_utils = require('#src/utility/common_utils');

/**
 *  Unit tests for validation/searchValidator.ts
 */
describe('Test searchValidator module', () => {
	let check_global_schema_table_stub;

	before(() => {
		check_global_schema_table_stub = sinon.stub(common_utils, 'checkGlobalSchemaTable').returns(undefined);
		getDatabases().searchValidatorTest = {
			test: {
				attributes: [{ attribute: 'id' }, { attribute: 'name' }],
			},
		};
	});

	after(() => {
		check_global_schema_table_stub.restore();
	});

	it('names an unknown attribute once when it appears as both the search attribute and a condition attribute', () => {
		const result = searchValidator(
			{
				schema: 'searchValidatorTest',
				table: 'test',
				operator: 'and',
				get_attributes: ['bogus'],
				conditions: [{ attribute: 'bogus', comparator: 'equals', value: 'x' }],
			},
			'conditions'
		);

		assert.ok(result instanceof Error);
		assert.strictEqual(result.message, "unknown attribute 'bogus'");
	});

	it('still lists multiple distinct unknown attributes', () => {
		const result = searchValidator(
			{
				schema: 'searchValidatorTest',
				table: 'test',
				attribute: 'bogus1',
				value: 'x',
				get_attributes: ['bogus2'],
			},
			'value'
		);

		assert.ok(result instanceof Error);
		assert.strictEqual(result.message, "unknown attribute 'bogus2 and bogus1'");
	});

	it('passes when all attributes are known', () => {
		const result = searchValidator(
			{
				schema: 'searchValidatorTest',
				table: 'test',
				attribute: 'id',
				value: 'x',
				get_attributes: ['name'],
			},
			'value'
		);

		assert.strictEqual(result, undefined);
	});
});
