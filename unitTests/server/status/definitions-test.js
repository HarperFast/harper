'use strict';

const assert = require('node:assert/strict');
const {
	STATUS_DEFINITIONS,
	STATUS_IDS,
	DEFAULT_STATUS_ID
} = require('../../../server/status/definitions');

describe('server.status.definitions', function () {
	describe('constants', function () {
		it('should export STATUS_DEFINITIONS with correct structure', function () {
			assert.ok(STATUS_DEFINITIONS);
			assert.ok(STATUS_DEFINITIONS.primary);
			assert.ok(STATUS_DEFINITIONS.maintenance);
			assert.ok(STATUS_DEFINITIONS.availability);
			
			// Check structure
			assert.strictEqual(STATUS_DEFINITIONS.primary.allowedValues, null);
			assert.strictEqual(STATUS_DEFINITIONS.maintenance.allowedValues, null);
			assert.deepStrictEqual(STATUS_DEFINITIONS.availability.allowedValues, ['Available', 'Unavailable']);
		});

		it('should export STATUS_IDS with all status types', function () {
			assert.deepStrictEqual(STATUS_IDS, ['primary', 'maintenance', 'availability']);
		});

		it('should export DEFAULT_STATUS_ID as primary', function () {
			assert.strictEqual(DEFAULT_STATUS_ID, 'primary');
		});
	});



	describe('exported constants structure', function () {
		it('should ensure STATUS_IDS contains all keys from STATUS_DEFINITIONS', function () {
			const definitionKeys = Object.keys(STATUS_DEFINITIONS);
			assert.deepStrictEqual(STATUS_IDS, definitionKeys);
		});

		it('should validate the structure of exported constants', function () {
			// Verify STATUS_DEFINITIONS structure
			assert.strictEqual(typeof STATUS_DEFINITIONS, 'object');
			assert.strictEqual(Object.keys(STATUS_DEFINITIONS).length, 3);
			
			// Verify each status definition has the expected structure
			Object.entries(STATUS_DEFINITIONS).forEach(([key, value]) => {
				assert.ok(value.hasOwnProperty('allowedValues'), `${key} should have allowedValues property`);
				assert.ok(
					value.allowedValues === null || Array.isArray(value.allowedValues),
					`${key}.allowedValues should be null or an array`
				);
			});
			
			// Verify STATUS_IDS is an array
			assert.ok(Array.isArray(STATUS_IDS));
			assert.strictEqual(STATUS_IDS.length, 3);
			
			// Verify DEFAULT_STATUS_ID is a valid status ID
			assert.ok(STATUS_IDS.includes(DEFAULT_STATUS_ID));
		});
	});
});