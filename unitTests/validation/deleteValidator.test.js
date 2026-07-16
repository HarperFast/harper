'use strict';

const assert = require('node:assert');
const deleteValidator = require('#src/validation/deleteValidator').default;

describe('Test deleteValidator module', () => {
	it('Test table required returned', () => {
		const test_del_obj = {
			schema: 'unit',
			hash_values: ['1a', 1, '3vs'],
		};
		const result = deleteValidator(test_del_obj);
		assert.strictEqual(result.message, "'table' is required");
	});

	it('Test hash_values required returned', () => {
		const test_del_obj = {
			schema: 'unit',
			table: 'test',
		};
		const result = deleteValidator(test_del_obj);
		assert.strictEqual(result.message, "'hash_values' is required");
	});

	it('Test hash_values invalid returned', () => {
		const test_del_obj = {
			schema: 'unit',
			table: 'test',
			hash_values: '1abc',
		};
		const result = deleteValidator(test_del_obj);
		assert.strictEqual(result.message, "'hash_values' must be an array");
	});

	it('Test null in hash_values rejected (would wipe the table -- studio#1199)', () => {
		const test_del_obj = {
			schema: 'unit',
			table: 'test',
			hash_values: [1, null, '3vs'],
		};
		const result = deleteValidator(test_del_obj);
		assert.strictEqual(result.message, "'hash_values[1]' must not contain null");
	});

	it('Test null in ids rejected (names the ids field, not hash_values)', () => {
		const test_del_obj = {
			schema: 'unit',
			table: 'test',
			ids: [null],
			hash_values: [1],
		};
		const result = deleteValidator(test_del_obj);
		assert.strictEqual(result.message, "'ids[0]' must not contain null");
	});

	it('Test valid string and number hash_values pass', () => {
		const test_del_obj = {
			schema: 'unit',
			table: 'test',
			hash_values: ['1a', 1, '3vs'],
		};
		const result = deleteValidator(test_del_obj);
		assert.strictEqual(result, undefined);
	});
});
