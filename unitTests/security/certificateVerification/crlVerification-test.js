const assert = require('node:assert/strict');

// First set up test environment
const test_utils = require('../../test_utils');
test_utils.preTestPrep();

describe('certificateVerification/crlVerification.ts', function() {
	let crlModule;

	before(function() {
		// Load the actual CRL verification module
		crlModule = require('../../../security/certificateVerification/crlVerification.ts');
	});

	describe('module exports', function() {
		it('should export verifyCRL function', function() {
			assert.strictEqual(typeof crlModule.verifyCRL, 'function');
		});
	});

	describe('CRL verification function', function() {
		it('should handle invalid certificate input gracefully', async function() {
			// Test with null/invalid certificate
			try {
				const result = await crlModule.verifyCRL(null, null, {
					enabled: true,
					timeout: 1000,
					failureMode: 'fail-open'
				});

				// Should return some result structure
				assert.ok(typeof result === 'object');
				assert.ok('valid' in result);
				assert.ok('status' in result);
			} catch (error) {
				// Also acceptable to throw error for invalid input
				assert.ok(error instanceof Error);
			}
		});

		it('should handle disabled CRL verification', async function() {
			const result = await crlModule.verifyCRL(Buffer.from('test'), Buffer.from('test'), {
				enabled: false,
				failureMode: 'fail-open'
			});

			assert.strictEqual(result.valid, true);
			// When disabled, it returns method 'crl' but with disabled status
			assert.ok(result.method === 'disabled' || result.method === 'crl');
		});

		it('should handle empty buffer input', async function() {
			const result = await crlModule.verifyCRL(Buffer.alloc(0), Buffer.alloc(0), {
				enabled: true,
				failureMode: 'fail-open',
				timeout: 1000
			});

			// Should handle gracefully and not crash
			assert.ok(typeof result === 'object');
			assert.ok('valid' in result);
			assert.ok('status' in result);
		});
	});

});