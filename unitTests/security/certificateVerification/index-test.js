const assert = require('node:assert/strict');
const sinon = require('sinon');

// First set up test environment
const test_utils = require('../../test_utils');
test_utils.preTestPrep();

describe('certificateVerification/index.ts', function () {
	let indexModule;
	let verificationConfig;
	let crlVerification;
	let ocspVerification;
	let verificationUtils;

	// Stubs for mocking
	let getCachedCertificateVerificationConfigStub;
	let extractCertificateChainStub;
	let extractRevocationUrlsStub;
	let verifyCRLStub;
	let verifyOCSPStub;

	before(function () {
		// Load the modules
		indexModule = require('../../../security/certificateVerification/index.ts');
		verificationConfig = require('../../../security/certificateVerification/verificationConfig.ts');
		crlVerification = require('../../../security/certificateVerification/crlVerification.ts');
		ocspVerification = require('../../../security/certificateVerification/ocspVerification.ts');
		verificationUtils = require('../../../security/certificateVerification/verificationUtils.ts');
	});

	beforeEach(function () {
		// Create stubs for all dependencies
		getCachedCertificateVerificationConfigStub = sinon.stub(
			verificationConfig,
			'getCachedCertificateVerificationConfig'
		);
		extractCertificateChainStub = sinon.stub(verificationUtils, 'extractCertificateChain');
		extractRevocationUrlsStub = sinon.stub(verificationUtils, 'extractRevocationUrls');
		verifyCRLStub = sinon.stub(crlVerification, 'verifyCRL');
		verifyOCSPStub = sinon.stub(ocspVerification, 'verifyOCSP');
	});

	afterEach(function () {
		// Restore all stubs
		sinon.restore();
	});

	describe('module exports', function () {
		it('should export verifyCertificate function', function () {
			assert.strictEqual(typeof indexModule.verifyCertificate, 'function');
		});
	});

	describe('verifyCertificate() orchestration', function () {
		const mockPeerCert = {
			subject: { CN: 'test.example.com' },
			raw: Buffer.from('mock-cert'),
		};

		const mockCertChain = [
			{
				cert: Buffer.from('cert1'),
				issuer: Buffer.from('issuer1'),
			},
			{
				cert: Buffer.from('cert2'),
				issuer: null,
			},
		];

		describe('disabled configuration', function () {
			it('should return disabled status when config is false', async function () {
				getCachedCertificateVerificationConfigStub.returns(false);

				const result = await indexModule.verifyCertificate(mockPeerCert, false);

				assert.deepStrictEqual(result, {
					valid: true,
					status: 'disabled',
					method: 'disabled',
				});

				// Should not attempt any verification
				assert.strictEqual(extractCertificateChainStub.called, false);
			});

			it('should return disabled status when mtlsConfig is null', async function () {
				getCachedCertificateVerificationConfigStub.returns(false);

				const result = await indexModule.verifyCertificate(mockPeerCert, null);

				assert.deepStrictEqual(result, {
					valid: true,
					status: 'disabled',
					method: 'disabled',
				});
			});
		});

		describe('insufficient certificate chain', function () {
			it('should return no-issuer-cert when chain length < 2', async function () {
				getCachedCertificateVerificationConfigStub.returns({
					failureMode: 'fail-closed',
					crl: { enabled: true },
					ocsp: { enabled: true },
				});
				extractCertificateChainStub.returns([{ cert: Buffer.from('cert1'), issuer: null }]);

				const result = await indexModule.verifyCertificate(mockPeerCert, { certificateVerification: true });

				assert.deepStrictEqual(result, {
					valid: true,
					status: 'no-issuer-cert',
					method: 'disabled',
				});

				// Should not attempt verification
				assert.strictEqual(verifyCRLStub.called, false);
				assert.strictEqual(verifyOCSPStub.called, false);
			});

			it('should return no-issuer-cert when first cert has no issuer', async function () {
				getCachedCertificateVerificationConfigStub.returns({
					failureMode: 'fail-closed',
					crl: { enabled: true },
					ocsp: { enabled: true },
				});
				extractCertificateChainStub.returns([
					{ cert: Buffer.from('cert1'), issuer: null },
					{ cert: Buffer.from('cert2'), issuer: null },
				]);

				const result = await indexModule.verifyCertificate(mockPeerCert, { certificateVerification: true });

				assert.strictEqual(result.status, 'no-issuer-cert');
				assert.strictEqual(result.valid, true);
			});
		});

		describe('CRL verification path', function () {
			beforeEach(function () {
				getCachedCertificateVerificationConfigStub.returns({
					failureMode: 'fail-closed',
					crl: { enabled: true, timeout: 10000 },
					ocsp: { enabled: true, timeout: 5000 },
				});
				extractCertificateChainStub.returns(mockCertChain);
			});

			it('should attempt CRL verification when CRL URLs present and enabled', async function () {
				extractRevocationUrlsStub.returns({
					crlUrls: ['http://crl.example.com/ca.crl'],
					ocspUrls: [],
				});
				verifyCRLStub.resolves({ valid: true, status: 'good', method: 'crl' });

				const result = await indexModule.verifyCertificate(mockPeerCert, { certificateVerification: true });

				assert.strictEqual(verifyCRLStub.called, true);
				assert.strictEqual(result.status, 'good');
				assert.strictEqual(result.valid, true);
				assert.strictEqual(result.method, 'crl');
			});

			it('should return immediately on CRL revoked result', async function () {
				extractRevocationUrlsStub.returns({
					crlUrls: ['http://crl.example.com/ca.crl'],
					ocspUrls: ['http://ocsp.example.com'],
				});
				verifyCRLStub.resolves({ valid: false, status: 'revoked', method: 'crl', reason: 'keyCompromise' });

				const result = await indexModule.verifyCertificate(mockPeerCert, { certificateVerification: true });

				assert.strictEqual(result.status, 'revoked');
				assert.strictEqual(result.valid, false);
				assert.strictEqual(result.reason, 'keyCompromise');
				// Should not fall back to OCSP
				assert.strictEqual(verifyOCSPStub.called, false);
			});

			it('should fall back to OCSP when CRL returns unknown', async function () {
				extractRevocationUrlsStub.returns({
					crlUrls: ['http://crl.example.com/ca.crl'],
					ocspUrls: ['http://ocsp.example.com'],
				});
				verifyCRLStub.resolves({ valid: true, status: 'unknown', method: 'crl' });
				verifyOCSPStub.resolves({ valid: true, status: 'good', method: 'ocsp' });

				const result = await indexModule.verifyCertificate(mockPeerCert, { certificateVerification: true });

				assert.strictEqual(verifyCRLStub.called, true);
				assert.strictEqual(verifyOCSPStub.called, true);
				assert.strictEqual(result.status, 'good');
				assert.strictEqual(result.method, 'ocsp');
			});

			it('should skip CRL when disabled in config', async function () {
				getCachedCertificateVerificationConfigStub.returns({
					failureMode: 'fail-closed',
					crl: { enabled: false },
					ocsp: { enabled: true, timeout: 5000 },
				});
				extractRevocationUrlsStub.returns({
					crlUrls: ['http://crl.example.com/ca.crl'],
					ocspUrls: ['http://ocsp.example.com'],
				});
				verifyOCSPStub.resolves({ valid: true, status: 'good', method: 'ocsp' });

				const result = await indexModule.verifyCertificate(mockPeerCert, { certificateVerification: true });

				assert.strictEqual(verifyCRLStub.called, false);
				assert.strictEqual(verifyOCSPStub.called, true);
			});

			it('should skip CRL when no distribution points', async function () {
				extractRevocationUrlsStub.returns({
					crlUrls: [],
					ocspUrls: ['http://ocsp.example.com'],
				});
				verifyOCSPStub.resolves({ valid: true, status: 'good', method: 'ocsp' });

				const result = await indexModule.verifyCertificate(mockPeerCert, { certificateVerification: true });

				assert.strictEqual(verifyCRLStub.called, false);
				assert.strictEqual(verifyOCSPStub.called, true);
			});

			it('should handle CRL verification errors gracefully', async function () {
				extractRevocationUrlsStub.returns({
					crlUrls: ['http://crl.example.com/ca.crl'],
					ocspUrls: ['http://ocsp.example.com'],
				});
				verifyCRLStub.rejects(new Error('CRL download failed'));
				verifyOCSPStub.resolves({ valid: true, status: 'good', method: 'ocsp' });

				const result = await indexModule.verifyCertificate(mockPeerCert, { certificateVerification: true });

				// Should fall back to OCSP after CRL error
				assert.strictEqual(verifyOCSPStub.called, true);
				assert.strictEqual(result.status, 'good');
			});
		});

		describe('OCSP verification path', function () {
			beforeEach(function () {
				getCachedCertificateVerificationConfigStub.returns({
					failureMode: 'fail-closed',
					crl: { enabled: true, timeout: 10000 },
					ocsp: { enabled: true, timeout: 5000 },
				});
				extractCertificateChainStub.returns(mockCertChain);
			});

			it('should attempt OCSP verification when OCSP URLs present and enabled', async function () {
				extractRevocationUrlsStub.returns({
					crlUrls: [],
					ocspUrls: ['http://ocsp.example.com'],
				});
				verifyOCSPStub.resolves({ valid: true, status: 'good', method: 'ocsp' });

				const result = await indexModule.verifyCertificate(mockPeerCert, { certificateVerification: true });

				assert.strictEqual(verifyOCSPStub.called, true);
				assert.strictEqual(result.status, 'good');
				assert.strictEqual(result.valid, true);
			});

			it('should skip OCSP when disabled in config', async function () {
				getCachedCertificateVerificationConfigStub.returns({
					failureMode: 'fail-open',
					crl: { enabled: false },
					ocsp: { enabled: false },
				});
				extractRevocationUrlsStub.returns({
					crlUrls: [],
					ocspUrls: ['http://ocsp.example.com'],
				});

				const result = await indexModule.verifyCertificate(mockPeerCert, { certificateVerification: true });

				assert.strictEqual(verifyOCSPStub.called, false);
				// No verification available with fail-open
				assert.strictEqual(result.valid, true);
				assert.strictEqual(result.status, 'verification-unavailable-allowed');
			});

			it('should skip OCSP when no responder URLs', async function () {
				extractRevocationUrlsStub.returns({
					crlUrls: [],
					ocspUrls: [],
				});

				const result = await indexModule.verifyCertificate(mockPeerCert, { certificateVerification: true });

				assert.strictEqual(verifyOCSPStub.called, false);
			});

			it('should handle OCSP verification errors gracefully', async function () {
				getCachedCertificateVerificationConfigStub.returns({
					failureMode: 'fail-open',
					crl: { enabled: false },
					ocsp: { enabled: true, timeout: 5000 },
				});
				extractRevocationUrlsStub.returns({
					crlUrls: [],
					ocspUrls: ['http://ocsp.example.com'],
				});
				verifyOCSPStub.rejects(new Error('OCSP request failed'));

				const result = await indexModule.verifyCertificate(mockPeerCert, { certificateVerification: true });

				// With fail-open, should allow on error
				assert.strictEqual(result.valid, true);
			});
		});

		describe('failure mode handling', function () {
			beforeEach(function () {
				extractCertificateChainStub.returns(mockCertChain);
				extractRevocationUrlsStub.returns({
					crlUrls: [],
					ocspUrls: [],
				});
			});

			it('should reject when no verification available with fail-closed', async function () {
				getCachedCertificateVerificationConfigStub.returns({
					failureMode: 'fail-closed',
					crl: { enabled: true },
					ocsp: { enabled: true },
				});

				const result = await indexModule.verifyCertificate(mockPeerCert, { certificateVerification: true });

				assert.strictEqual(result.valid, false);
				assert.strictEqual(result.status, 'no-verification-available');
			});

			it('should allow when no verification available with fail-open', async function () {
				getCachedCertificateVerificationConfigStub.returns({
					failureMode: 'fail-open',
					crl: { enabled: true },
					ocsp: { enabled: true },
				});

				const result = await indexModule.verifyCertificate(mockPeerCert, { certificateVerification: true });

				assert.strictEqual(result.valid, true);
				assert.strictEqual(result.status, 'verification-unavailable-allowed');
			});

			it('should reject when all methods fail with fail-closed', async function () {
				getCachedCertificateVerificationConfigStub.returns({
					failureMode: 'fail-closed',
					crl: { enabled: true },
					ocsp: { enabled: true },
				});
				extractRevocationUrlsStub.returns({
					crlUrls: ['http://crl.example.com/ca.crl'],
					ocspUrls: ['http://ocsp.example.com'],
				});
				verifyCRLStub.rejects(new Error('CRL failed'));
				verifyOCSPStub.rejects(new Error('OCSP failed'));

				const result = await indexModule.verifyCertificate(mockPeerCert, { certificateVerification: true });

				assert.strictEqual(result.valid, false);
			});

			it('should allow when all methods fail with fail-open', async function () {
				getCachedCertificateVerificationConfigStub.returns({
					failureMode: 'fail-open',
					crl: { enabled: true },
					ocsp: { enabled: true },
				});
				extractRevocationUrlsStub.returns({
					crlUrls: ['http://crl.example.com/ca.crl'],
					ocspUrls: ['http://ocsp.example.com'],
				});
				verifyCRLStub.rejects(new Error('CRL failed'));
				verifyOCSPStub.rejects(new Error('OCSP failed'));

				const result = await indexModule.verifyCertificate(mockPeerCert, { certificateVerification: true });

				assert.strictEqual(result.valid, true);
			});
		});
	});
});
