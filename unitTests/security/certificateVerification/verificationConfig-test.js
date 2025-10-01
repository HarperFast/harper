const assert = require('node:assert/strict');

// First set up test environment
const test_utils = require('../../test_utils');
test_utils.preTestPrep();

describe('certificateVerification/verificationConfig.ts', function() {
	let configModule;
	let validationModule;

	before(function() {
		// Load the actual verification config module
		configModule = require('../../../security/certificateVerification/verificationConfig.ts');
		// Load validation module for defaults
		validationModule = require('../../../security/certificateVerification/configValidation.ts');
	});

	describe('configuration constants', function() {
		it('should export required constants', function() {
			assert.strictEqual(typeof configModule.CRL_DEFAULT_VALIDITY_PERIOD, 'number');
			assert.strictEqual(typeof configModule.ERROR_CACHE_TTL, 'number');
			assert.strictEqual(typeof configModule.CRL_USER_AGENT, 'string');

			assert.strictEqual(configModule.CRL_DEFAULT_VALIDITY_PERIOD, 604800000); // 7 days
			assert.strictEqual(configModule.ERROR_CACHE_TTL, 300000); // 5 minutes
		});

		it('should export OCSP defaults from validation module', function() {
			assert.ok(validationModule.OCSP_DEFAULTS);
			assert.strictEqual(validationModule.OCSP_DEFAULTS.timeout, 5000);
			assert.strictEqual(validationModule.OCSP_DEFAULTS.cacheTtl, 3600000);
			assert.strictEqual(validationModule.OCSP_DEFAULTS.errorCacheTtl, 300000);
			assert.strictEqual(validationModule.OCSP_DEFAULTS.failureMode, 'fail-closed');
		});

		it('should export CRL defaults from validation module', function() {
			assert.ok(validationModule.CRL_DEFAULTS);
			assert.strictEqual(validationModule.CRL_DEFAULTS.timeout, 10000);
			assert.strictEqual(validationModule.CRL_DEFAULTS.cacheTtl, 86400000);
			assert.strictEqual(validationModule.CRL_DEFAULTS.failureMode, 'fail-closed');
			assert.strictEqual(validationModule.CRL_DEFAULTS.gracePeriod, 86400000);
		});

		it('should generate User-Agent string with version', function() {
			assert.ok(configModule.CRL_USER_AGENT.startsWith('Harper/'));
			assert.ok(configModule.CRL_USER_AGENT.endsWith('CRL-Client'));

			// Test version pattern exists between Harper/ and space
			const versionMatch = configModule.CRL_USER_AGENT.match(/Harper\/([^\s]+)\s/);
			assert.ok(versionMatch);
			assert.ok(versionMatch[1].length > 0); // Has some version string
		});
	});

	describe('cached configuration function', function() {
		it('should export getCachedCertificateVerificationConfig function', function() {
			assert.strictEqual(typeof configModule.getCachedCertificateVerificationConfig, 'function');
		});

		it('should handle falsy mtls configurations', function() {
			assert.strictEqual(configModule.getCachedCertificateVerificationConfig(false), false);
			assert.strictEqual(configModule.getCachedCertificateVerificationConfig(null), false);
			assert.strictEqual(configModule.getCachedCertificateVerificationConfig(undefined), false);
		});

		it('should return false for mtls: true (cert verification disabled by default)', function() {
			const result = configModule.getCachedCertificateVerificationConfig(true);
			assert.strictEqual(result, false); // Defaults to disabled for safe rollout
		});

		it('should handle complex configuration objects', function() {
			// Test with OCSP disabled
			const ocspDisabled = configModule.getCachedCertificateVerificationConfig({
				certificateVerification: {
					ocsp: false
				}
			});
			assert.ok(ocspDisabled);
			assert.ok(ocspDisabled.ocsp);
			assert.strictEqual(ocspDisabled.ocsp.enabled, false);

			// Test with custom OCSP config
			const customOcsp = configModule.getCachedCertificateVerificationConfig({
				certificateVerification: {
					ocsp: {
						timeout: 3000,
						failureMode: 'fail-closed'
					}
				}
			});
			assert.ok(customOcsp.ocsp);
			assert.strictEqual(customOcsp.ocsp.timeout, 3000);
			assert.strictEqual(customOcsp.ocsp.failureMode, 'fail-closed');
		});

		it('should handle CRL configuration', function() {
			// Test with CRL disabled
			const crlDisabled = configModule.getCachedCertificateVerificationConfig({
				certificateVerification: {
					crl: false
				}
			});
			assert.ok(crlDisabled);
			assert.ok(crlDisabled.crl);
			assert.strictEqual(crlDisabled.crl.enabled, false);

			// Test with custom CRL config
			const customCrl = configModule.getCachedCertificateVerificationConfig({
				certificateVerification: {
					crl: {
						timeout: 15000,
						gracePeriod: 43200000,
						failureMode: 'fail-closed'
					}
				}
			});
			assert.ok(customCrl.crl);
			assert.strictEqual(customCrl.crl.timeout, 15000);
			assert.strictEqual(customCrl.crl.gracePeriod, 43200000);
			assert.strictEqual(customCrl.crl.failureMode, 'fail-closed');
		});

		it('should handle edge cases', function() {
			// Test with empty object - defaults to disabled
			const emptyObj = configModule.getCachedCertificateVerificationConfig({});
			assert.strictEqual(emptyObj, false); // No certificateVerification key = disabled

			// Test with explicit false certificateVerification
			const falseVerification = configModule.getCachedCertificateVerificationConfig({
				certificateVerification: false
			});
			assert.strictEqual(falseVerification, false);
		});
	});

	describe('caching behavior', function() {
		it('should cache results for repeated calls', function() {
			// First call should compute result (false - disabled by default)
			const result1 = configModule.getCachedCertificateVerificationConfig(true);
			assert.strictEqual(result1, false);

			// Second call with same value should return same result (cached)
			const result2 = configModule.getCachedCertificateVerificationConfig(true);
			assert.strictEqual(result2, false);

			// Call with different value should return different result
			const result3 = configModule.getCachedCertificateVerificationConfig(false);
			assert.strictEqual(result3, false);
		});

		it('should handle object configurations', function() {
			const configObj = { certificateVerification: true };

			// First call with object
			const result1 = configModule.getCachedCertificateVerificationConfig(configObj);
			assert.ok(result1);
			assert.strictEqual(result1.failureMode, 'fail-closed'); // Default is now fail-closed

			// Second call with same object reference
			const result2 = configModule.getCachedCertificateVerificationConfig(configObj);
			assert.ok(result2);
			assert.strictEqual(result2.failureMode, 'fail-closed');

			// Different object with same content
			const differentObj = { certificateVerification: true };
			const result3 = configModule.getCachedCertificateVerificationConfig(differentObj);
			assert.ok(result3);
			assert.strictEqual(result3.failureMode, 'fail-closed');
		});

		it('should handle complex nested configuration objects', function() {
			// Test with certificateVerification as complex object
			const configObj = configModule.getCachedCertificateVerificationConfig({
				certificateVerification: {
					failureMode: 'fail-closed',
					ocsp: {
						enabled: true,
						timeout: 3000
					},
					crl: false
				}
			});
			assert.ok(configObj);
			assert.strictEqual(configObj.failureMode, 'fail-closed');
		});

		it('should handle invalid config gracefully with fail-safe behavior', function() {
			// Invalid failureMode should return false (disabled) as fail-safe behavior
			const invalidMode = configModule.getCachedCertificateVerificationConfig({
				certificateVerification: {
					failureMode: 'invalid-mode'
				}
			});
			assert.strictEqual(invalidMode, false); // Fail-safe: invalid config = disabled

			// Second call with same invalid config should return false immediately (cached error)
			const secondCall = configModule.getCachedCertificateVerificationConfig({
				certificateVerification: {
					failureMode: 'invalid-mode'
				}
			});
			assert.strictEqual(secondCall, false);
		});

		it('should handle invalid timeout values gracefully', function() {
			// Timeout less than minimum should fail validation
			const invalidTimeout = configModule.getCachedCertificateVerificationConfig({
				certificateVerification: {
					ocsp: {
						timeout: 500 // Less than 1000ms minimum
					}
				}
			});
			assert.strictEqual(invalidTimeout, false); // Fail-safe: invalid config = disabled
		});

		it('should handle invalid cacheTtl values gracefully', function() {
			// CacheTtl less than minimum should fail validation
			const invalidCacheTtl = configModule.getCachedCertificateVerificationConfig({
				certificateVerification: {
					crl: {
						cacheTtl: 100 // Less than 1000ms minimum
					}
				}
			});
			assert.strictEqual(invalidCacheTtl, false); // Fail-safe: invalid config = disabled
		});

		it('should handle invalid errorCacheTtl values gracefully', function() {
			// ErrorCacheTtl less than minimum should fail validation
			const invalidErrorCacheTtl = configModule.getCachedCertificateVerificationConfig({
				certificateVerification: {
					ocsp: {
						errorCacheTtl: 500 // Less than 1000ms minimum
					}
				}
			});
			assert.strictEqual(invalidErrorCacheTtl, false); // Fail-safe: invalid config = disabled
		});

		it('should handle zero cacheTtl values gracefully', function() {
			// Zero cacheTtl should fail validation (minimum is 1000)
			const zeroCacheTtl = configModule.getCachedCertificateVerificationConfig({
				certificateVerification: {
					crl: {
						cacheTtl: 0
					}
				}
			});
			assert.strictEqual(zeroCacheTtl, false); // Fail-safe: invalid config = disabled
		});

		it('should handle negative cacheTtl values gracefully', function() {
			// Negative cacheTtl should fail validation
			const negativeCacheTtl = configModule.getCachedCertificateVerificationConfig({
				certificateVerification: {
					ocsp: {
						cacheTtl: -1000
					}
				}
			});
			assert.strictEqual(negativeCacheTtl, false); // Fail-safe: invalid config = disabled
		});

		it('should accept very large cacheTtl values', function() {
			// Large but valid cacheTtl should be accepted
			const largeCacheTtl = configModule.getCachedCertificateVerificationConfig({
				certificateVerification: {
					crl: {
						cacheTtl: 86400000 * 30 // 30 days
					}
				}
			});
			assert.ok(largeCacheTtl);
			assert.strictEqual(largeCacheTtl.crl.cacheTtl, 86400000 * 30);
		});

		it('should handle invalid gracePeriod values gracefully', function() {
			// Negative gracePeriod should fail validation (minimum is 0)
			const negativeGracePeriod = configModule.getCachedCertificateVerificationConfig({
				certificateVerification: {
					crl: {
						gracePeriod: -1
					}
				}
			});
			assert.strictEqual(negativeGracePeriod, false); // Fail-safe: invalid config = disabled
		});

		it('should accept zero gracePeriod', function() {
			// Zero gracePeriod is valid (no grace period)
			const zeroGracePeriod = configModule.getCachedCertificateVerificationConfig({
				certificateVerification: {
					crl: {
						gracePeriod: 0
					}
				}
			});
			assert.ok(zeroGracePeriod);
			assert.strictEqual(zeroGracePeriod.crl.gracePeriod, 0);
		});
	});

	describe('boolean shorthand config (crl: true, ocsp: true)', function() {
		it('should handle crl: true shorthand with defaults', function() {
			const result = configModule.getCachedCertificateVerificationConfig({
				certificateVerification: {
					crl: true
				}
			});

			assert.ok(result);
			assert.ok(result.crl);
			assert.strictEqual(result.crl.enabled, true);
			// Should have CRL defaults applied
			assert.strictEqual(result.crl.timeout, validationModule.CRL_DEFAULTS.timeout);
			assert.strictEqual(result.crl.cacheTtl, validationModule.CRL_DEFAULTS.cacheTtl);
			assert.strictEqual(result.crl.failureMode, validationModule.CRL_DEFAULTS.failureMode);
			assert.strictEqual(result.crl.gracePeriod, validationModule.CRL_DEFAULTS.gracePeriod);
		});

		it('should handle ocsp: true shorthand with defaults', function() {
			const result = configModule.getCachedCertificateVerificationConfig({
				certificateVerification: {
					ocsp: true
				}
			});

			assert.ok(result);
			assert.ok(result.ocsp);
			assert.strictEqual(result.ocsp.enabled, true);
			// Should have OCSP defaults applied
			assert.strictEqual(result.ocsp.timeout, validationModule.OCSP_DEFAULTS.timeout);
			assert.strictEqual(result.ocsp.cacheTtl, validationModule.OCSP_DEFAULTS.cacheTtl);
			assert.strictEqual(result.ocsp.errorCacheTtl, validationModule.OCSP_DEFAULTS.errorCacheTtl);
			assert.strictEqual(result.ocsp.failureMode, validationModule.OCSP_DEFAULTS.failureMode);
		});

		it('should handle both crl: true and ocsp: true together', function() {
			const result = configModule.getCachedCertificateVerificationConfig({
				certificateVerification: {
					crl: true,
					ocsp: true
				}
			});

			assert.ok(result);
			assert.ok(result.crl);
			assert.ok(result.ocsp);
			assert.strictEqual(result.crl.enabled, true);
			assert.strictEqual(result.ocsp.enabled, true);
			// Both should have their respective defaults
			assert.strictEqual(result.crl.timeout, validationModule.CRL_DEFAULTS.timeout);
			assert.strictEqual(result.ocsp.timeout, validationModule.OCSP_DEFAULTS.timeout);
		});

		it('should handle crl: true with additional overrides', function() {
			const result = configModule.getCachedCertificateVerificationConfig({
				certificateVerification: {
					crl: true,
					failureMode: 'fail-open' // Override global failure mode
				}
			});

			assert.ok(result);
			assert.ok(result.crl);
			assert.strictEqual(result.crl.enabled, true);
			// Should use overridden failure mode
			assert.strictEqual(result.failureMode, 'fail-open');
		});

		it('should handle ocsp: true with additional overrides', function() {
			const result = configModule.getCachedCertificateVerificationConfig({
				certificateVerification: {
					ocsp: true,
					failureMode: 'fail-open'
				}
			});

			assert.ok(result);
			assert.ok(result.ocsp);
			assert.strictEqual(result.ocsp.enabled, true);
			assert.strictEqual(result.failureMode, 'fail-open');
		});
	});
});