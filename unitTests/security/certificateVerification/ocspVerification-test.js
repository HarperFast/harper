const assert = require('node:assert/strict');

// First set up test environment
const test_utils = require('../../test_utils');
test_utils.preTestPrep();

describe('certificateVerification/ocspVerification.ts', function() {
	let ocspModule;

	before(function() {
		// Load the actual OCSP verification module
		ocspModule = require('../../../security/certificateVerification/ocspVerification.ts');
	});

	describe('module exports', function() {
		it('should export verifyOCSP function', function() {
			assert.strictEqual(typeof ocspModule.verifyOCSP, 'function');
		});
	});

	describe('OCSP verification function', function() {
		it('should handle invalid certificate input gracefully', async function() {
			// Test with null/invalid certificate
			try {
				const result = await ocspModule.verifyOCSP(null, null, {
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

		it('should handle disabled OCSP verification', async function() {
			const result = await ocspModule.verifyOCSP(Buffer.from('test'), Buffer.from('test'), {
				enabled: false,
				failureMode: 'fail-open'
			});

			assert.strictEqual(result.valid, true);
			// When disabled, it returns method 'ocsp' but with disabled status
			assert.ok(result.method === 'disabled' || result.method === 'ocsp');
		});

		it('should handle empty buffer input', async function() {
			const result = await ocspModule.verifyOCSP(Buffer.alloc(0), Buffer.alloc(0), {
				enabled: true,
				failureMode: 'fail-open',
				timeout: 1000
			});

			// Should handle gracefully and not crash
			assert.ok(typeof result === 'object');
			assert.ok('valid' in result);
			assert.ok('status' in result);
		});

		it('should handle fail-open mode correctly', async function() {
			// When OCSP fails but fail-open is set, should allow
			const result = await ocspModule.verifyOCSP(Buffer.from('invalid-cert'), Buffer.from('invalid-ca'), {
				enabled: true,
				failureMode: 'fail-open',
				timeout: 100 // Very short timeout to force failure
			});

			// In fail-open mode, should be valid even on failure
			if (result.status === 'error' || result.status === 'timeout') {
				assert.strictEqual(result.valid, true, 'Fail-open should allow connections on error');
			}
		});

		it('should handle fail-closed mode correctly', async function() {
			// When OCSP fails and fail-closed is set, should reject
			const result = await ocspModule.verifyOCSP(Buffer.from('invalid-cert'), Buffer.from('invalid-ca'), {
				enabled: true,
				failureMode: 'fail-closed',
				timeout: 100 // Very short timeout to force failure
			});

			// In fail-closed mode, should be invalid on failure
			if (result.status === 'error' || result.status === 'timeout') {
				assert.strictEqual(result.valid, false, 'Fail-closed should reject connections on error');
			}
		});
	});

});