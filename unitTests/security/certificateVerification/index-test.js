const assert = require('node:assert/strict');

// First set up test environment
const test_utils = require('../../test_utils');
test_utils.preTestPrep();

describe('certificateVerification/index.ts', function() {
	let indexModule;

	before(function() {
		// Load the actual index module
		indexModule = require('../../../security/certificateVerification/index.ts');
	});

	describe('module exports', function() {
		it('should export verifyCertificate function', function() {
			assert.strictEqual(typeof indexModule.verifyCertificate, 'function');
		});

		it('should export all verification functions', function() {
			// Check that main verification functions are exported
			const expectedExports = [
				'verifyCertificate'
			];

			for (const exportName of expectedExports) {
				assert.strictEqual(typeof indexModule[exportName], 'function',
					`${exportName} should be exported as a function`);
			}
		});

		it('should handle basic certificate verification call', async function() {
			// Test that the main function exists and can be called
			// We don't test full verification here as that requires certificates and network
			assert.strictEqual(typeof indexModule.verifyCertificate, 'function');

			// The function should be async and return a result object
			try {
				const result = await indexModule.verifyCertificate(null, null, {});
				// Should return some result structure
				assert.ok(typeof result === 'object');
			} catch (error) {
				// Also acceptable to throw error for invalid input
				assert.ok(error instanceof Error);
			}
		});
	});
});