'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const searchValidator = require('#src/validation/searchValidator').default;
const { getDatabases } = require('#src/resources/databases');

/**
 *  Unit tests for validation/searchValidator.ts
 */
describe('Test searchValidator module', () => {
	before(() => {
		getDatabases().searchValidatorTest = {
			test: {
				attributes: [{ attribute: 'id' }, { attribute: 'name' }],
			},
		};
	});

	after(() => {
		delete getDatabases().searchValidatorTest;
	});

	it('names an unknown attribute once when search_by_value names it as both the search attribute and a get_attributes entry', () => {
		const result = searchValidator(
			{
				schema: 'searchValidatorTest',
				table: 'test',
				attribute: 'bogus',
				value: 'x',
				get_attributes: ['bogus'],
			},
			'value'
		);

		assert.ok(result instanceof Error);
		assert.strictEqual(result.message, "unknown attribute 'bogus'");
	});

	it('names an unknown attribute once when search_by_conditions names it as both a get_attributes entry and a condition', () => {
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

	it('names an unknown attribute once when two conditions both name it', () => {
		const result = searchValidator(
			{
				schema: 'searchValidatorTest',
				table: 'test',
				operator: 'or',
				conditions: [
					{ attribute: 'bogus', comparator: 'equals', value: 'x' },
					{ attribute: 'bogus', comparator: 'equals', value: 'y' },
				],
			},
			'conditions'
		);

		assert.ok(result instanceof Error);
		assert.strictEqual(result.message, "unknown attribute 'bogus'");
	});

	it('dedupes two structurally-equal but distinct unknown object attribute specifiers', () => {
		const result = searchValidator(
			{
				schema: 'searchValidatorTest',
				table: 'test',
				attribute: 'id',
				value: 'x',
				get_attributes: [
					{ attribute: 'bogus', as: 'alias' },
					{ attribute: 'bogus', as: 'alias' },
				],
			},
			'value'
		);

		assert.ok(result instanceof Error);
		assert.strictEqual(result.message, "unknown attribute '[object Object]'");
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
