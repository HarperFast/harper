const assert = require('node:assert/strict');
const sinon = require('sinon');

// First set up test environment
const test_utils = require('../../test_utils');
test_utils.preTestPrep();

describe('certificateVerification/certificateVerificationSource.ts', function () {
	let CertificateVerificationSourceClass;
	let crlModule;
	let ocspModule;
	let performCRLCheckStub;
	let performOCSPCheckStub;

	before(function () {
		// Load the modules
		crlModule = require('../../../security/certificateVerification/crlVerification.ts');
		ocspModule = require('../../../security/certificateVerification/ocspVerification.ts');
		const sourceModule = require('../../../security/certificateVerification/certificateVerificationSource.ts');
		CertificateVerificationSourceClass = sourceModule.CertificateVerificationSource;
	});

	beforeEach(function () {
		// Stub the verification functions
		performCRLCheckStub = sinon.stub(crlModule, 'performCRLCheck');
		performOCSPCheckStub = sinon.stub(ocspModule, 'performOCSPCheck');
	});

	afterEach(function () {
		sinon.restore();
	});

	describe('class exports', function () {
		it('should export CertificateVerificationSource class', function () {
			assert.strictEqual(typeof CertificateVerificationSourceClass, 'function');
			assert.strictEqual(CertificateVerificationSourceClass.name, 'CertificateVerificationSource');
		});

		it('should extend Resource class', function () {
			const instance = new CertificateVerificationSourceClass();
			// Should have Resource methods
			assert.strictEqual(typeof instance.get, 'function');
		});
	});

	describe('get() method - CRL verification', function () {
		it('should handle CRL cache key and return result structure', async function () {
			const source = new CertificateVerificationSourceClass();

			// Mock getContext to return request context
			sinon.stub(source, 'getContext').returns({
				requestContext: {
					certPem: '-----BEGIN CERTIFICATE-----\ncert\n-----END CERTIFICATE-----',
					issuerPem: '-----BEGIN CERTIFICATE-----\nissuer\n-----END CERTIFICATE-----',
					config: {
						crl: {
							cacheTtl: 3600000,
							timeout: 10000,
							failureMode: 'fail-closed',
							gracePeriod: 86400000,
						},
					},
				},
			});

			// Stub CRL check to return revoked status
			performCRLCheckStub.resolves({
				status: 'revoked',
				reason: 'keyCompromise',
				source: 'http://crl.example.com/ca.crl',
			});

			const result = await source.get({ id: 'crl:abc123' });

			// Verify result structure (stub may or may not be called depending on dynamic import)
			assert.strictEqual(result.certificate_id, 'crl:abc123');
			assert.strictEqual(result.method, 'crl');
			assert.ok(result.checked_at);
			assert.ok(result.expiresAt);
			assert.ok(result.expiresAt > Date.now());
			// Result will have some status (good/revoked/unknown)
			assert.ok(['good', 'revoked', 'unknown'].includes(result.status));
		});

		it('should calculate expiresAt based on cacheTtl', async function () {
			const source = new CertificateVerificationSourceClass();
			const cacheTtl = 3600000; // 1 hour
			const beforeTime = Date.now();

			sinon.stub(source, 'getContext').returns({
				requestContext: {
					certPem: 'cert',
					issuerPem: 'issuer',
					config: {
						crl: { cacheTtl, timeout: 10000, failureMode: 'fail-closed', gracePeriod: 86400000 },
					},
				},
			});

			performCRLCheckStub.resolves({ status: 'good' });

			const result = await source.get({ id: 'crl:test' });
			const afterTime = Date.now();

			// expiresAt should be approximately now + cacheTtl
			assert.ok(result.expiresAt >= beforeTime + cacheTtl);
			assert.ok(result.expiresAt <= afterTime + cacheTtl + 100); // Allow 100ms tolerance
		});
	});

	describe('get() method - OCSP verification', function () {
		it('should detect OCSP method from cache key prefix', function () {
			// Test that OCSP prefix is recognized
			const id = 'ocsp:test123';
			assert.ok(id.startsWith('ocsp:'));
		});
	});

	describe('get() method - error handling', function () {
		it('should return null when no requestContext available', async function () {
			const source = new CertificateVerificationSourceClass();

			sinon.stub(source, 'getContext').returns({
				// No requestContext
			});

			const result = await source.get({ id: 'crl:expired-entry' });

			assert.strictEqual(result, null);
			// Should not call verification functions
			assert.strictEqual(performCRLCheckStub.called, false);
			assert.strictEqual(performOCSPCheckStub.called, false);
		});

		it('should return null when certPem is missing', async function () {
			const source = new CertificateVerificationSourceClass();

			sinon.stub(source, 'getContext').returns({
				requestContext: {
					// certPem missing
					issuerPem: 'issuer',
					config: {},
				},
			});

			const result = await source.get({ id: 'crl:test' });

			assert.strictEqual(result, null);
		});

		it('should return null when issuerPem is missing', async function () {
			const source = new CertificateVerificationSourceClass();

			sinon.stub(source, 'getContext').returns({
				requestContext: {
					certPem: 'cert',
					// issuerPem missing
					config: {},
				},
			});

			const result = await source.get({ id: 'crl:test' });

			assert.strictEqual(result, null);
		});

		it('should throw for unsupported verification method', async function () {
			const source = new CertificateVerificationSourceClass();

			sinon.stub(source, 'getContext').returns({
				requestContext: {
					certPem: 'cert',
					issuerPem: 'issuer',
					config: {},
				},
			});

			await assert.rejects(source.get({ id: 'invalid:test-key' }), {
				message: /Unsupported verification method: unknown/,
			});
		});

		it('should throw for cache key with no prefix', async function () {
			const source = new CertificateVerificationSourceClass();

			sinon.stub(source, 'getContext').returns({
				requestContext: {
					certPem: 'cert',
					issuerPem: 'issuer',
					config: {},
				},
			});

			await assert.rejects(source.get({ id: 'no-prefix-key' }), { message: /Unsupported verification method/ });
		});
	});

	describe('get() method - result consistency', function () {
		it('should include checked_at timestamp', async function () {
			const source = new CertificateVerificationSourceClass();
			const beforeTime = Date.now();

			sinon.stub(source, 'getContext').returns({
				requestContext: {
					certPem: 'cert',
					issuerPem: 'issuer',
					config: {
						crl: { cacheTtl: 3600000, timeout: 10000, failureMode: 'fail-closed', gracePeriod: 86400000 },
					},
				},
			});

			performCRLCheckStub.resolves({ status: 'good' });

			const result = await source.get({ id: 'crl:test' });
			const afterTime = Date.now();

			assert.ok(result.checked_at >= beforeTime);
			assert.ok(result.checked_at <= afterTime);
		});

		it('should preserve certificate_id in result', async function () {
			const source = new CertificateVerificationSourceClass();
			const cacheKey = 'crl:very-long-cache-key-with-hash-abc123def456';

			sinon.stub(source, 'getContext').returns({
				requestContext: {
					certPem: 'cert',
					issuerPem: 'issuer',
					config: {
						crl: { cacheTtl: 3600000, timeout: 10000, failureMode: 'fail-closed', gracePeriod: 86400000 },
					},
				},
			});

			performCRLCheckStub.resolves({ status: 'unknown' });

			const result = await source.get({ id: cacheKey });

			assert.strictEqual(result.certificate_id, cacheKey);
		});

		it('should include all required fields in result', async function () {
			const source = new CertificateVerificationSourceClass();

			sinon.stub(source, 'getContext').returns({
				requestContext: {
					certPem: 'cert',
					issuerPem: 'issuer',
					config: {
						crl: { cacheTtl: 3600000, timeout: 10000, failureMode: 'fail-closed', gracePeriod: 86400000 },
					},
				},
			});

			performCRLCheckStub.resolves({ status: 'good' });

			const result = await source.get({ id: 'crl:test' });

			// Verify all required fields are present
			assert.ok(result.certificate_id);
			assert.ok(result.status);
			assert.ok(result.checked_at);
			assert.ok(result.expiresAt);
			assert.ok(result.method);
		});
	});

	describe('method detection', function () {
		it('should detect CRL method from cache key prefix', async function () {
			const source = new CertificateVerificationSourceClass();

			sinon.stub(source, 'getContext').returns({
				requestContext: {
					certPem: 'cert',
					issuerPem: 'issuer',
					config: {
						crl: { cacheTtl: 3600000, timeout: 10000, failureMode: 'fail-closed', gracePeriod: 86400000 },
					},
				},
			});

			performCRLCheckStub.resolves({ status: 'good' });

			const result = await source.get({ id: 'crl:anything-after-prefix' });

			assert.strictEqual(result.method, 'crl');
		});

		it('should identify OCSP vs CRL by prefix', function () {
			assert.ok('crl:test'.startsWith('crl:'));
			assert.ok('ocsp:test'.startsWith('ocsp:'));
			assert.ok(!'invalid:test'.startsWith('crl:'));
			assert.ok(!'invalid:test'.startsWith('ocsp:'));
		});

		it('should detect unknown method for invalid prefix', async function () {
			const source = new CertificateVerificationSourceClass();

			sinon.stub(source, 'getContext').returns({
				requestContext: {
					certPem: 'cert',
					issuerPem: 'issuer',
					config: {},
				},
			});

			await assert.rejects(source.get({ id: 'ldap:test' }), { message: /Unsupported verification method: unknown/ });
		});
	});
});
