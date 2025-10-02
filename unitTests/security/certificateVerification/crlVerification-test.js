const assert = require('node:assert/strict');
const sinon = require('sinon');

// First set up test environment
const test_utils = require('../../test_utils');
test_utils.preTestPrep();

describe('certificateVerification/crlVerification.ts', function () {
	let crlModule;
	let verificationUtils;

	// Stubs
	let extractCRLDistributionPointsStub;
	let extractSerialNumberStub;
	let extractIssuerKeyIdStub;

	before(function () {
		// Load the actual CRL verification module
		crlModule = require('../../../security/certificateVerification/crlVerification.ts');
		verificationUtils = require('../../../security/certificateVerification/verificationUtils.ts');
	});

	beforeEach(async function () {
		// Stub utility functions
		extractCRLDistributionPointsStub = sinon.stub(verificationUtils, 'extractCRLDistributionPoints');
		extractSerialNumberStub = sinon.stub(verificationUtils, 'extractSerialNumber');
		extractIssuerKeyIdStub = sinon.stub(verificationUtils, 'extractIssuerKeyId');

		// Clear certificate cache to prevent test pollution
		try {
			const certCacheTable = verificationUtils.getCertificateCacheTable();
			const entries = certCacheTable.get({});
			for await (const entry of entries) {
				try {
					await certCacheTable.delete(entry.certificate_id);
					// eslint-disable-next-line sonarjs/no-ignored-exceptions
				} catch (e) {
					// Ignore delete errors
				}
			}
			// eslint-disable-next-line sonarjs/no-ignored-exceptions
		} catch (e) {
			// Ignore if cache doesn't exist yet
		}
	});

	afterEach(function () {
		sinon.restore();
	});

	describe('module exports', function () {
		it('should export verifyCRL function', function () {
			assert.strictEqual(typeof crlModule.verifyCRL, 'function');
		});

		it('should export performCRLCheck function', function () {
			assert.strictEqual(typeof crlModule.performCRLCheck, 'function');
		});
	});

	describe('verifyCRL() main API', function () {
		it('should handle disabled CRL verification', async function () {
			const result = await crlModule.verifyCRL(Buffer.from('test'), Buffer.from('test'), {
				enabled: false,
				failureMode: 'fail-open',
			});

			assert.strictEqual(result.valid, true);
			assert.strictEqual(result.method, 'disabled');
		});

		it('should return result structure with valid field', async function () {
			const result = await crlModule.verifyCRL(Buffer.from('test'), Buffer.from('test'), {
				enabled: false,
				failureMode: 'fail-open',
			});

			// Result should have required fields
			assert.ok(typeof result.valid === 'boolean');
			assert.ok(typeof result.method === 'string');
			assert.ok(result.status !== undefined);
		});

		it('should handle no CRL distribution points gracefully', async function () {
			// Create a mock certificate that will have no CRL distribution points
			extractCRLDistributionPointsStub.returns([]);

			const certBuffer = Buffer.from('-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----');
			const issuerBuffer = Buffer.from('-----BEGIN CERTIFICATE-----\nissuer\n-----END CERTIFICATE-----');

			const result = await crlModule.verifyCRL(certBuffer, issuerBuffer, {
				enabled: true,
				failureMode: 'fail-closed',
				timeout: 10000,
				cacheTtl: 86400000,
				gracePeriod: 86400000,
			});

			// Should return valid when no CRL distribution points
			assert.strictEqual(result.valid, true);
			assert.strictEqual(result.status, 'no-crl-distribution-points');
			assert.strictEqual(result.method, 'crl');
		});

		it('should use provided CRL URLs instead of extracting', async function () {
			// Provide URLs directly - extraction should not be called
			const certBuffer = Buffer.from('test-cert');
			const issuerBuffer = Buffer.from('test-issuer');
			const providedUrls = ['http://crl.example.com/ca.crl'];

			const result = await crlModule.verifyCRL(
				certBuffer,
				issuerBuffer,
				{
					enabled: true,
					failureMode: 'fail-open',
					timeout: 10000,
					cacheTtl: 86400000,
					gracePeriod: 86400000,
				},
				providedUrls
			);

			// Extraction should not be called when URLs provided
			assert.strictEqual(extractCRLDistributionPointsStub.called, false);

			// Result should be valid with some status
			assert.ok(typeof result.valid === 'boolean');
			assert.ok(result.status);
			assert.strictEqual(result.method, 'crl');
		});

		it('should convert Buffer to PEM format for processing', async function () {
			extractCRLDistributionPointsStub.returns([]);

			const certBuffer = Buffer.from('test-cert-data');
			const issuerBuffer = Buffer.from('test-issuer-data');

			const result = await crlModule.verifyCRL(certBuffer, issuerBuffer, {
				enabled: true,
				failureMode: 'fail-open',
				timeout: 10000,
				cacheTtl: 86400000,
				gracePeriod: 86400000,
			});

			// Should successfully convert buffers and process
			assert.ok(result);
			assert.strictEqual(typeof result.valid, 'boolean');
		});

		it('should handle config with all optional fields', async function () {
			extractCRLDistributionPointsStub.returns([]);

			const fullConfig = {
				enabled: true,
				failureMode: 'fail-closed',
				timeout: 15000,
				cacheTtl: 7200000,
				gracePeriod: 43200000,
			};

			const result = await crlModule.verifyCRL(Buffer.from('cert'), Buffer.from('issuer'), fullConfig);

			assert.ok(result);
			assert.strictEqual(typeof result.valid, 'boolean');
		});

		it('should handle minimal config with defaults', async function () {
			extractCRLDistributionPointsStub.returns([]);

			const minimalConfig = {
				enabled: true,
				failureMode: 'fail-open',
			};

			const result = await crlModule.verifyCRL(Buffer.from('cert'), Buffer.from('issuer'), minimalConfig);

			assert.ok(result);
			assert.strictEqual(typeof result.valid, 'boolean');
		});

		it('should return cached field in result', async function () {
			extractCRLDistributionPointsStub.returns([]);

			const result = await crlModule.verifyCRL(Buffer.from('cert'), Buffer.from('issuer'), {
				enabled: true,
				failureMode: 'fail-open',
				timeout: 10000,
				cacheTtl: 86400000,
				gracePeriod: 86400000,
			});

			// Result can have cached field (true/false/undefined depending on whether cache was hit)
			assert.ok(result);
			if ('cached' in result) {
				assert.ok(typeof result.cached === 'boolean');
			}
		});
	});

	describe('CRL signature verification', function () {
		it('should reject invalid CRL signatures in fail-closed mode', async function () {
			// This test verifies that invalid CRL signatures are rejected in fail-closed mode
			const pkijs = require('pkijs');

			// Use unique URL to avoid cache pollution from other tests
			const uniqueUrl = `http://test-invalid-sig-fail-closed-${Date.now()}.example.com/ca.crl`;

			// Mock distribution points
			extractCRLDistributionPointsStub.returns([uniqueUrl]);

			// Create a mock CRL with invalid signature
			const mockCRL = {
				verify: sinon.stub().resolves(false), // Invalid signature
				thisUpdate: { value: new Date() },
				nextUpdate: { value: new Date(Date.now() + 86400000) },
				revokedCertificates: [],
			};

			// Mock CertificateRevocationList.fromBER to return our mock
			const fromBERStub = sinon.stub(pkijs.CertificateRevocationList, 'fromBER').returns(mockCRL);

			// Mock Certificate.fromBER for issuer cert
			const mockIssuerCert = {
				issuer: { typesAndValues: [] },
			};
			const certFromBERStub = sinon.stub(pkijs.Certificate, 'fromBER').returns(mockIssuerCert);

			// Mock fetch to return CRL data
			// eslint-disable-next-line no-undef
			const originalFetch = globalThis.fetch;
			// eslint-disable-next-line no-undef
			globalThis.fetch = sinon.stub().resolves({
				ok: true,
				status: 200,
				arrayBuffer: async () => new ArrayBuffer(8),
			});

			const config = {
				enabled: true,
				gracePeriod: 86400000,
				failureMode: 'fail-closed',
				timeout: 10000,
				cacheTtl: 86400000,
			};

			// Use unique cert/issuer to avoid cache pollution from other tests
			const certBuffer = Buffer.from(`test-cert-fail-closed-${Date.now()}`);
			const issuerBuffer = Buffer.from(`test-issuer-fail-closed-${Date.now()}`);

			try {
				// Test at verifyCRL level (public API) - signature failure should cause rejection in fail-closed mode
				const result = await crlModule.verifyCRL(certBuffer, issuerBuffer, config);

				// In fail-closed mode, invalid signature should result in valid: false
				assert.strictEqual(
					result.valid,
					false,
					'Certificate should be rejected with invalid CRL signature in fail-closed mode'
				);
				// Status could be 'error', 'unknown', or 'revoked' (if cache pollution from other tests)
				// The key assertion is that valid: false
			} finally {
				fromBERStub.restore();
				certFromBERStub.restore();
				// eslint-disable-next-line no-undef
				globalThis.fetch = originalFetch;
			}
		});

		it('should reject invalid CRL signatures in fail-open mode', async function () {
			// This test verifies the critical behavior: invalid signatures ALWAYS fail,
			// regardless of fail-open/fail-closed mode
			const pkijs = require('pkijs');

			// Use unique URL to avoid cache pollution from other tests
			const uniqueUrl = `http://test-invalid-sig-fail-open-${Date.now()}.example.com/ca.crl`;

			extractCRLDistributionPointsStub.returns([uniqueUrl]);

			// Create a mock CRL with invalid signature
			const mockCRL = {
				verify: sinon.stub().resolves(false), // Invalid signature
				thisUpdate: { value: new Date() },
				nextUpdate: { value: new Date(Date.now() + 86400000) },
				revokedCertificates: [],
			};

			const fromBERStub = sinon.stub(pkijs.CertificateRevocationList, 'fromBER').returns(mockCRL);

			const mockIssuerCert = {
				issuer: { typesAndValues: [] },
			};
			const certFromBERStub = sinon.stub(pkijs.Certificate, 'fromBER').returns(mockIssuerCert);

			// Mock fetch to return CRL data
			// eslint-disable-next-line no-undef
			const originalFetch = globalThis.fetch;
			// eslint-disable-next-line no-undef
			globalThis.fetch = sinon.stub().resolves({
				ok: true,
				status: 200,
				arrayBuffer: async () => new ArrayBuffer(8),
			});

			const config = {
				enabled: true,
				gracePeriod: 86400000,
				failureMode: 'fail-open', // NOTE: fail-open mode
				timeout: 10000,
				cacheTtl: 86400000,
			};

			// Use unique cert/issuer to avoid cache pollution from other tests
			const certBuffer = Buffer.from(`test-cert-fail-open-${Date.now()}`);
			const issuerBuffer = Buffer.from(`test-issuer-fail-open-${Date.now()}`);

			try {
				// Test at verifyCRL level - in fail-open mode, invalid signature should STILL cause rejection
				const result = await crlModule.verifyCRL(certBuffer, issuerBuffer, config);

				// Even in fail-open mode, invalid signature (security failure) should result in valid: false
				assert.strictEqual(
					result.valid,
					false,
					'Certificate should be rejected with invalid CRL signature even in fail-open mode (security failure)'
				);
				// Status could be 'error', 'unknown', or 'revoked' (if cache pollution from other tests)
				// The key assertion is that valid: false even in fail-open mode
			} finally {
				fromBERStub.restore();
				certFromBERStub.restore();
				// eslint-disable-next-line no-undef
				globalThis.fetch = originalFetch;
			}
		});
	});

	describe('performCRLCheck() core logic', function () {
		const mockConfig = {
			gracePeriod: 86400000, // 24 hours
			failureMode: 'fail-closed',
			timeout: 10000,
			cacheTtl: 86400000,
		};

		const certPem = '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----';
		const issuerPem = '-----BEGIN CERTIFICATE-----\nissuer\n-----END CERTIFICATE-----';

		describe('no CRL distribution points', function () {
			it('should return good status when no distribution points extracted', async function () {
				extractCRLDistributionPointsStub.returns([]);

				const result = await crlModule.performCRLCheck(certPem, issuerPem, mockConfig);

				assert.deepStrictEqual(result, { status: 'good' });
			});

			it('should use provided CRL URLs instead of extracting from cert', async function () {
				// Stub returns empty, but we provide URLs directly
				extractCRLDistributionPointsStub.returns([]);
				const providedUrls = ['http://provided.example.com/ca.crl'];

				extractSerialNumberStub.returns('SERIAL123');
				extractIssuerKeyIdStub.returns('ISSUER456');

				// Will lookup in DB (returns null in test env) and check freshness (will fail with no CRL data)
				const result = await crlModule.performCRLCheck(certPem, issuerPem, mockConfig, providedUrls);

				// Should not have called extract function when URLs provided
				assert.strictEqual(extractCRLDistributionPointsStub.called, false);

				// Result will be 'unknown' because CRL download will fail (no real CRL server)
				// But we've verified the provided URLs path is taken
				assert.ok(['unknown', 'good'].includes(result.status));
			});
		});

		describe('utility function extraction', function () {
			it('should extract serial number and issuer key for composite ID', async function () {
				extractCRLDistributionPointsStub.returns(['http://crl.example.com/ca.crl']);
				extractSerialNumberStub.returns('ABC123');
				extractIssuerKeyIdStub.returns('ISSUER789');

				// This will fail to find cert in DB, then fail to download CRL
				// But we've verified extraction functions are called
				await crlModule.performCRLCheck(certPem, issuerPem, mockConfig);

				assert.strictEqual(extractSerialNumberStub.calledOnce, true);
				assert.strictEqual(extractSerialNumberStub.calledWith(certPem), true);
				assert.strictEqual(extractIssuerKeyIdStub.calledOnce, true);
				assert.strictEqual(extractIssuerKeyIdStub.calledWith(issuerPem), true);
			});

			it('should throw when extraction functions fail', async function () {
				extractCRLDistributionPointsStub.returns(['http://crl.example.com/ca.crl']);
				extractSerialNumberStub.throws(new Error('Invalid certificate format'));

				// Extraction errors are not caught - they bubble up
				await assert.rejects(crlModule.performCRLCheck(certPem, issuerPem, mockConfig), {
					message: 'Invalid certificate format',
				});
			});
		});
	});
});
