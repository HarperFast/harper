const assert = require('node:assert/strict');
const sinon = require('sinon');
const rewire = require('rewire');

// First set up test environment
const testUtils = require('../../testUtils.js');
testUtils.preTestPrep();

describe('certificateVerification/ocspVerification.ts', function () {
	let ocspModule;

	before(function () {
		// Load the actual OCSP verification module
		ocspModule = require('#src/security/certificateVerification/ocspVerification');
	});

	describe('module exports', function () {
		it('should export verifyOCSP function', function () {
			assert.strictEqual(typeof ocspModule.verifyOCSP, 'function');
		});

		it('should export performOCSPCheck function', function () {
			assert.strictEqual(typeof ocspModule.performOCSPCheck, 'function');
		});
	});

	describe('verifyOCSP() main API', function () {
		it('should handle disabled OCSP verification', async function () {
			const result = await ocspModule.verifyOCSP(Buffer.from('test'), Buffer.from('test'), {
				enabled: false,
				failureMode: 'fail-open',
			});

			assert.strictEqual(result.valid, true);
			assert.strictEqual(result.method, 'disabled');
			assert.strictEqual(result.status, 'disabled');
		});

		it('should return result structure with valid field', async function () {
			const result = await ocspModule.verifyOCSP(Buffer.from('test'), Buffer.from('test'), {
				enabled: false,
				failureMode: 'fail-open',
			});

			// Result should have required fields
			assert.ok(typeof result.valid === 'boolean');
			assert.ok(typeof result.method === 'string');
			assert.ok(result.status !== undefined);
		});

		it('should convert Buffer to PEM format for processing', async function () {
			const certBuffer = Buffer.from('test-cert-data');
			const issuerBuffer = Buffer.from('test-issuer-data');

			const result = await ocspModule.verifyOCSP(certBuffer, issuerBuffer, {
				enabled: true,
				failureMode: 'fail-open',
				timeout: 5000,
				cacheTtl: 3600000,
				errorCacheTtl: 300000,
			});

			// Should successfully convert buffers and process
			assert.ok(result);
			assert.strictEqual(typeof result.valid, 'boolean');
		});

		it('should handle fail-closed mode correctly', async function () {
			// Invalid cert will cause some result (error, unknown, etc)
			const result = await ocspModule.verifyOCSP(Buffer.from('invalid'), Buffer.from('invalid'), {
				enabled: true,
				failureMode: 'fail-closed',
				timeout: 5000,
				cacheTtl: 3600000,
				errorCacheTtl: 300000,
			});

			// In fail-closed mode, errors should result in valid: false
			// But cache might return 'unknown' which also results in valid: false
			assert.ok(typeof result.valid === 'boolean');
			assert.strictEqual(result.method, 'ocsp');
			// If status is error, should be invalid
			if (result.status === 'error') {
				assert.strictEqual(result.valid, false);
			}
		});

		it('should handle fail-open mode correctly', async function () {
			// Invalid cert will cause some result
			const result = await ocspModule.verifyOCSP(Buffer.from('invalid'), Buffer.from('invalid'), {
				enabled: true,
				failureMode: 'fail-open',
				timeout: 5000,
				cacheTtl: 3600000,
				errorCacheTtl: 300000,
			});

			// In fail-open mode, should always allow (valid: true) on errors
			assert.ok(typeof result.valid === 'boolean');
			assert.strictEqual(result.method, 'ocsp');
			// If status is error-allowed, should be valid
			if (result.status === 'error-allowed') {
				assert.strictEqual(result.valid, true);
			}
		});

		it('should handle config with all optional fields', async function () {
			const fullConfig = {
				enabled: true,
				failureMode: 'fail-closed',
				timeout: 10000,
				cacheTtl: 7200000,
				errorCacheTtl: 600000,
			};

			const result = await ocspModule.verifyOCSP(Buffer.from('cert'), Buffer.from('issuer'), fullConfig);

			assert.ok(result);
			assert.strictEqual(typeof result.valid, 'boolean');
		});

		it('should handle minimal config with defaults', async function () {
			const minimalConfig = {
				enabled: true,
				failureMode: 'fail-open',
			};

			const result = await ocspModule.verifyOCSP(Buffer.from('cert'), Buffer.from('issuer'), minimalConfig);

			assert.ok(result);
			assert.strictEqual(typeof result.valid, 'boolean');
		});

		it('should return cached field in result', async function () {
			const result = await ocspModule.verifyOCSP(Buffer.from('cert'), Buffer.from('issuer'), {
				enabled: true,
				failureMode: 'fail-open',
				timeout: 5000,
				cacheTtl: 3600000,
				errorCacheTtl: 300000,
			});

			// Result can have cached field (true/false/undefined depending on whether cache was hit)
			assert.ok(result);
			if ('cached' in result) {
				assert.ok(typeof result.cached === 'boolean');
			}
		});

		it('should handle provided OCSP URLs', async function () {
			const providedUrls = ['http://ocsp.example.com'];

			const result = await ocspModule.verifyOCSP(
				Buffer.from('cert'),
				Buffer.from('issuer'),
				{
					enabled: true,
					failureMode: 'fail-open',
					timeout: 5000,
					cacheTtl: 3600000,
					errorCacheTtl: 300000,
				},
				providedUrls
			);

			// Should accept provided URLs
			assert.ok(result);
			assert.strictEqual(typeof result.valid, 'boolean');
		});

		it('should handle empty OCSP URLs array', async function () {
			const result = await ocspModule.verifyOCSP(
				Buffer.from('cert'),
				Buffer.from('issuer'),
				{
					enabled: true,
					failureMode: 'fail-open',
					timeout: 5000,
					cacheTtl: 3600000,
					errorCacheTtl: 300000,
				},
				[] // Empty array
			);

			assert.ok(result);
			assert.strictEqual(typeof result.valid, 'boolean');
		});

		it('should handle null certificate input gracefully', async function () {
			try {
				const result = await ocspModule.verifyOCSP(null, null, {
					enabled: true,
					timeout: 1000,
					failureMode: 'fail-open',
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

		it('should handle empty buffer input', async function () {
			const result = await ocspModule.verifyOCSP(Buffer.alloc(0), Buffer.alloc(0), {
				enabled: true,
				failureMode: 'fail-open',
				timeout: 1000,
			});

			// Should handle gracefully and not crash
			assert.ok(typeof result === 'object');
			assert.ok('valid' in result);
			assert.ok('status' in result);
		});

		it('should handle very short timeout', async function () {
			const result = await ocspModule.verifyOCSP(Buffer.from('cert'), Buffer.from('issuer'), {
				enabled: true,
				failureMode: 'fail-open',
				timeout: 1, // Very short timeout
			});

			// Should handle timeout gracefully
			assert.ok(result);
			assert.strictEqual(typeof result.valid, 'boolean');
		});
	});

	describe('performOCSPCheck() error handling', function () {
		it('should handle generic OCSP errors', async function () {
			// Invalid cert will cause OCSP error
			const result = await ocspModule.performOCSPCheck('invalid', 'invalid', { timeout: 5000 });

			assert.strictEqual(result.status, 'unknown');
			assert.strictEqual(result.reason, 'ocsp-error');
		});

		it('should return result with status field', async function () {
			const result = await ocspModule.performOCSPCheck('invalid', 'invalid', { timeout: 1 });

			// Should return structured result even on error
			assert.ok(typeof result === 'object');
			assert.ok('status' in result);
			assert.strictEqual(result.status, 'unknown');
		});
	});

	// easy-ocsp exports are non-configurable, so sinon.stub won't work.
	// rewire replaces the compiled module's internal easy_ocsp_1 binding instead.
	describe('performOCSPCheck() with mocked getCertStatus', function () {
		const OCSP_MODULE_PATH = '#src/security/certificateVerification/ocspVerification';
		let rewiredModule;
		let getCertStatusStub;

		beforeEach(function () {
			getCertStatusStub = sinon.stub();
			rewiredModule = rewire(OCSP_MODULE_PATH);
			rewiredModule.__set__('easy_ocsp_1', { getCertStatus: getCertStatusStub });
		});

		it('should return good status for a valid certificate', async function () {
			getCertStatusStub.resolves({ status: 'good' });

			const result = await rewiredModule.performOCSPCheck('cert-pem', 'issuer-pem', { timeout: 5000 });

			assert.deepStrictEqual(result, { status: 'good' });
		});

		it('should return revoked status with reason', async function () {
			getCertStatusStub.resolves({
				status: 'revoked',
				revocationReason: 'keyCompromise',
			});

			const result = await rewiredModule.performOCSPCheck('cert-pem', 'issuer-pem', { timeout: 5000 });

			assert.strictEqual(result.status, 'revoked');
			assert.strictEqual(result.reason, 'keyCompromise');
		});

		it('should return revoked with unspecified reason when none given', async function () {
			getCertStatusStub.resolves({
				status: 'revoked',
				revocationReason: undefined,
			});

			const result = await rewiredModule.performOCSPCheck('cert-pem', 'issuer-pem', { timeout: 5000 });

			assert.strictEqual(result.status, 'revoked');
			assert.strictEqual(result.reason, 'unspecified');
		});

		it('should return unknown status for unknown certificate status', async function () {
			getCertStatusStub.resolves({ status: 'unknown' });

			const result = await rewiredModule.performOCSPCheck('cert-pem', 'issuer-pem', { timeout: 5000 });

			assert.deepStrictEqual(result, { status: 'unknown', reason: 'unknown-status' });
		});

		it('should return timeout reason for AbortError', async function () {
			const abortError = new Error('The operation was aborted');
			abortError.name = 'AbortError';
			getCertStatusStub.rejects(abortError);

			const result = await rewiredModule.performOCSPCheck('cert-pem', 'issuer-pem', { timeout: 1 });

			assert.deepStrictEqual(result, { status: 'unknown', reason: 'timeout' });
		});

		it('should return ocsp-error reason for non-abort failures', async function () {
			getCertStatusStub.rejects(new Error('Network error'));

			const result = await rewiredModule.performOCSPCheck('cert-pem', 'issuer-pem', { timeout: 5000 });

			assert.deepStrictEqual(result, { status: 'unknown', reason: 'ocsp-error' });
		});

		it('should pass timeout to getCertStatus', async function () {
			getCertStatusStub.resolves({ status: 'good' });

			await rewiredModule.performOCSPCheck('cert-pem', 'issuer-pem', { timeout: 3000 });

			assert.ok(getCertStatusStub.calledOnce);
			assert.strictEqual(getCertStatusStub.firstCall.args[1].timeout, 3000);
		});

		it('should pass first provided OCSP URL to getCertStatus', async function () {
			getCertStatusStub.resolves({ status: 'good' });
			// eslint-disable-next-line sonarjs/no-clear-text-protocols
			const ocspUrls = ['http://ocsp.example.com/check'];

			await rewiredModule.performOCSPCheck('cert-pem', 'issuer-pem', { timeout: 5000 }, ocspUrls);

			assert.ok(getCertStatusStub.calledOnce);
			assert.strictEqual(getCertStatusStub.firstCall.args[1].ocspUrl, 'http://ocsp.example.com/check');
		});

		it('should not include ocspUrl when no URLs provided', async function () {
			getCertStatusStub.resolves({ status: 'good' });

			await rewiredModule.performOCSPCheck('cert-pem', 'issuer-pem', { timeout: 5000 });

			assert.ok(getCertStatusStub.calledOnce);
			assert.strictEqual(getCertStatusStub.firstCall.args[1].ocspUrl, undefined);
		});
	});

	describe('verifyOCSP() with mocked cache table', function () {
		const OCSP_MODULE_PATH = '#src/security/certificateVerification/ocspVerification';
		let sandbox;
		let freshOcspModule;
		let verificationUtils;

		beforeEach(function () {
			sandbox = sinon.createSandbox();
			// Clear the cached module so certCacheTable is reset to undefined
			delete require.cache[require.resolve(OCSP_MODULE_PATH)];
			verificationUtils = require('#src/security/certificateVerification/verificationUtils');
		});

		afterEach(function () {
			sandbox.restore();
			delete require.cache[require.resolve(OCSP_MODULE_PATH)];
		});

		function makeMockTable(entry, wasFromSource) {
			return {
				get: sandbox
					.stub()
					.resolves(entry ? Object.assign({}, entry, { wasLoadedFromSource: () => wasFromSource }) : null),
				sourcedFrom: sandbox.stub(),
			};
		}

		it('should return valid:true with good status on a cache hit', async function () {
			const mockTable = makeMockTable({ status: 'good', method: 'ocsp' }, false);
			sandbox.stub(verificationUtils, 'getCertificateCacheTable').returns(mockTable);
			freshOcspModule = require(OCSP_MODULE_PATH);

			const result = await freshOcspModule.verifyOCSP(Buffer.from('cert'), Buffer.from('issuer'), {
				enabled: true,
				failureMode: 'fail-open',
			});

			assert.strictEqual(result.valid, true);
			assert.strictEqual(result.status, 'good');
			assert.strictEqual(result.cached, true);
			assert.strictEqual(result.method, 'ocsp');
		});

		it('should return valid:false with revoked status on a cache hit', async function () {
			const mockTable = makeMockTable({ status: 'revoked', method: 'ocsp' }, false);
			sandbox.stub(verificationUtils, 'getCertificateCacheTable').returns(mockTable);
			freshOcspModule = require(OCSP_MODULE_PATH);

			const result = await freshOcspModule.verifyOCSP(Buffer.from('cert'), Buffer.from('issuer'), {
				enabled: true,
				failureMode: 'fail-closed',
			});

			assert.strictEqual(result.valid, false);
			assert.strictEqual(result.status, 'revoked');
			assert.strictEqual(result.cached, true);
			assert.strictEqual(result.method, 'ocsp');
		});

		it('should mark cached:false when entry was loaded from source (cache miss)', async function () {
			const mockTable = makeMockTable({ status: 'good', method: 'ocsp' }, true);
			sandbox.stub(verificationUtils, 'getCertificateCacheTable').returns(mockTable);
			freshOcspModule = require(OCSP_MODULE_PATH);

			const result = await freshOcspModule.verifyOCSP(Buffer.from('cert'), Buffer.from('issuer'), {
				enabled: true,
				failureMode: 'fail-open',
			});

			assert.strictEqual(result.cached, false);
		});

		it('should return error with valid:false in fail-closed when cache returns null', async function () {
			const mockTable = makeMockTable(null, false);
			sandbox.stub(verificationUtils, 'getCertificateCacheTable').returns(mockTable);
			freshOcspModule = require(OCSP_MODULE_PATH);

			const result = await freshOcspModule.verifyOCSP(Buffer.from('cert'), Buffer.from('issuer'), {
				enabled: true,
				failureMode: 'fail-closed',
			});

			assert.strictEqual(result.valid, false);
			assert.strictEqual(result.status, 'error');
			assert.strictEqual(result.method, 'ocsp');
		});

		it('should return error-allowed with valid:true in fail-open when cache returns null', async function () {
			const mockTable = makeMockTable(null, false);
			sandbox.stub(verificationUtils, 'getCertificateCacheTable').returns(mockTable);
			freshOcspModule = require(OCSP_MODULE_PATH);

			const result = await freshOcspModule.verifyOCSP(Buffer.from('cert'), Buffer.from('issuer'), {
				enabled: true,
				failureMode: 'fail-open',
			});

			assert.strictEqual(result.valid, true);
			assert.strictEqual(result.status, 'error-allowed');
		});

		it('should pass certPem, issuerPem, and ocspUrls context to cache get()', async function () {
			const mockTable = makeMockTable({ status: 'good', method: 'ocsp' }, false);
			sandbox.stub(verificationUtils, 'getCertificateCacheTable').returns(mockTable);
			freshOcspModule = require(OCSP_MODULE_PATH);

			// eslint-disable-next-line sonarjs/no-clear-text-protocols
			const ocspUrls = ['http://ocsp.example.com'];
			await freshOcspModule.verifyOCSP(
				Buffer.from('cert'),
				Buffer.from('issuer'),
				{
					enabled: true,
					failureMode: 'fail-open',
				},
				ocspUrls
			);

			assert.ok(mockTable.get.calledOnce);
			const context = mockTable.get.firstCall.args[1];
			assert.ok(typeof context.certPem === 'string');
			assert.ok(typeof context.issuerPem === 'string');
			assert.deepStrictEqual(context.ocspUrls, ocspUrls);
		});
	});
});
