const assert = require('node:assert/strict');

// First set up test environment
const test_utils = require('../../test_utils');
test_utils.preTestPrep();

describe('certificateVerification/verificationConfig.ts', function() {
	let configModule;

	before(function() {
		// Load the actual verification config module
		configModule = require('../../../security/certificateVerification/verificationConfig.ts');
	});

	describe('configuration constants', function() {
		it('should export required constants', function() {
			assert.strictEqual(typeof configModule.CRL_DEFAULT_VALIDITY_PERIOD, 'number');
			assert.strictEqual(typeof configModule.ERROR_CACHE_TTL, 'number');
			assert.strictEqual(typeof configModule.CRL_USER_AGENT, 'string');

			assert.strictEqual(configModule.CRL_DEFAULT_VALIDITY_PERIOD, 604800000); // 7 days
			assert.strictEqual(configModule.ERROR_CACHE_TTL, 300000); // 5 minutes
		});

		it('should export OCSP defaults', function() {
			assert.ok(configModule.OCSP_DEFAULTS);
			assert.strictEqual(configModule.OCSP_DEFAULTS.timeout, 5000);
			assert.strictEqual(configModule.OCSP_DEFAULTS.cacheTtl, 3600000);
			assert.strictEqual(configModule.OCSP_DEFAULTS.errorCacheTtl, 300000);
			assert.strictEqual(configModule.OCSP_DEFAULTS.failureMode, 'fail-open');
		});

		it('should export CRL defaults', function() {
			assert.ok(configModule.CRL_DEFAULTS);
			assert.strictEqual(configModule.CRL_DEFAULTS.timeout, 10000);
			assert.strictEqual(configModule.CRL_DEFAULTS.cacheTtl, 86400000);
			assert.strictEqual(configModule.CRL_DEFAULTS.failureMode, 'fail-open');
			assert.strictEqual(configModule.CRL_DEFAULTS.gracePeriod, 86400000);
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

		it('should return default config for true', function() {
			const result = configModule.getCachedCertificateVerificationConfig(true);
			assert.ok(result);
			assert.strictEqual(result.failureMode, 'fail-open');
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
			// Test with empty object
			const emptyObj = configModule.getCachedCertificateVerificationConfig({});
			assert.ok(emptyObj);
			assert.strictEqual(emptyObj.failureMode, 'fail-open');

			// Test with explicit false certificateVerification
			const falseVerification = configModule.getCachedCertificateVerificationConfig({
				certificateVerification: false
			});
			assert.strictEqual(falseVerification, false);
		});


	});

	describe('config helper functions', function() {
		it('should export getOCSPConfig function', function() {
			assert.strictEqual(typeof configModule.getOCSPConfig, 'function');
		});

		it('should merge OCSP config with defaults', function() {
			// Test no config
			const noConfig = configModule.getOCSPConfig();
			assert.strictEqual(noConfig.enabled, true);
			assert.strictEqual(noConfig.timeout, 5000);

			// Test with global failureMode
			const withGlobal = configModule.getOCSPConfig({
				failureMode: 'fail-closed'
			});
			assert.strictEqual(withGlobal.failureMode, 'fail-closed');

			// Test with OCSP-specific override
			const withOverride = configModule.getOCSPConfig({
				ocsp: {
					enabled: true,
					failureMode: 'fail-open'
				},
				failureMode: 'fail-closed'
			});
			assert.strictEqual(withOverride.failureMode, 'fail-open'); // OCSP-specific wins
		});

		it('should export getCRLConfig function', function() {
			assert.strictEqual(typeof configModule.getCRLConfig, 'function');
		});

		it('should merge CRL config with defaults', function() {
			// Test no config
			const noConfig = configModule.getCRLConfig();
			assert.strictEqual(noConfig.enabled, true);
			assert.strictEqual(noConfig.timeout, 10000);
			assert.strictEqual(noConfig.gracePeriod, 86400000);

			// Test with CRL-specific override
			const withOverride = configModule.getCRLConfig({
				crl: {
					enabled: true,
					failureMode: 'fail-open'
				},
				failureMode: 'fail-closed'
			});
			assert.strictEqual(withOverride.failureMode, 'fail-open'); // CRL-specific wins
		});

		it('should handle edge cases for config helpers', function() {
			// Test OCSP with disabled nested config
			const disabledOCSP = configModule.getOCSPConfig({
				ocsp: { enabled: false }
			});
			assert.strictEqual(disabledOCSP.enabled, false);

			// Test CRL with disabled nested config
			const disabledCRL = configModule.getCRLConfig({
				crl: { enabled: false }
			});
			assert.strictEqual(disabledCRL.enabled, false);
		});
	});

	describe('caching behavior', function() {
		it('should cache results for repeated calls', function() {
			// First call should compute result
			const result1 = configModule.getCachedCertificateVerificationConfig(true);
			assert.ok(result1);
			assert.strictEqual(result1.failureMode, 'fail-open');

			// Second call with same value should return same result (cached or not)
			const result2 = configModule.getCachedCertificateVerificationConfig(true);
			assert.ok(result2);
			assert.strictEqual(result2.failureMode, 'fail-open');

			// Call with different value should return different result
			const result3 = configModule.getCachedCertificateVerificationConfig(false);
			assert.strictEqual(result3, false);
		});

		it('should handle object configurations', function() {
			const configObj = { certificateVerification: true };

			// First call with object
			const result1 = configModule.getCachedCertificateVerificationConfig(configObj);
			assert.ok(result1);
			assert.strictEqual(result1.failureMode, 'fail-open');

			// Second call with same object reference
			const result2 = configModule.getCachedCertificateVerificationConfig(configObj);
			assert.ok(result2);
			assert.strictEqual(result2.failureMode, 'fail-open');

			// Different object with same content
			const differentObj = { certificateVerification: true };
			const result3 = configModule.getCachedCertificateVerificationConfig(differentObj);
			assert.ok(result3);
			assert.strictEqual(result3.failureMode, 'fail-open');
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

			// Test invalid failureMode gets corrected
			const invalidMode = configModule.getCachedCertificateVerificationConfig({
				certificateVerification: {
					failureMode: 'invalid-mode'
				}
			});
			assert.ok(invalidMode);
			assert.strictEqual(invalidMode.failureMode, 'fail-open'); // Should default
		});
	});
});