const assert = require('node:assert/strict');
const sinon = require('sinon');

// Create mocks
const mockLogger = {
	debug: sinon.stub(),
	trace: sinon.stub(),
	error: sinon.stub(),
	warn: sinon.stub(),
};

// Create a more sophisticated mock for Harper's caching behavior
let mockSourcedFrom = null;
let mockCacheEntries = new Map();

const mockTable = {
	get: sinon.stub(),
	put: sinon.stub(),
	sourcedFrom: sinon.stub().callsFake((source) => {
		mockSourcedFrom = source;
	}),
	setTTLExpiration: sinon.stub(),
};

// Helper to create a resource-like object that Harper's caching would return
function createMockResource(data, wasLoadedFromSource = false) {
	return {
		...data,
		wasLoadedFromSource: () => wasLoadedFromSource
	};
}

// Create stubs for easy-ocsp functions
const getCertStatusStub = sinon.stub();
const getCertURLsStub = sinon.stub();

// Helper to compute cache key like the real implementation
const { createHash } = require('node:crypto');
function computeCacheKey(certPem, issuerPem) {
	const cacheData = {
		certPem,
		issuerPem,
		method: 'ocsp',
	};
	const cacheKeyHash = createHash('sha256').update(JSON.stringify(cacheData)).digest('hex');
	return `ocsp:${cacheKeyHash}`;
}

// Store references for later use
const crypto = require('node:crypto');
const loggerModule = require('../../utility/logging/logger.js');
const databases = require('../../resources/databases.js');
let certificateVerification;
let originalX509Certificate;

describe('certificateVerification', function() {
	
	before(function() {
		// Delete the certificateVerification module from cache to ensure fresh load
		const certVerificationPath = require.resolve('../../security/certificateVerification.ts');
		delete require.cache[certVerificationPath];
		
		// Stub dependencies before requiring the module
		sinon.stub(loggerModule, 'loggerWithTag').returns(mockLogger);
		sinon.stub(databases, 'table').returns(mockTable);
		
		// Save original X509Certificate
		originalX509Certificate = crypto.X509Certificate;
		
		// Mock crypto module's X509Certificate
		crypto.X509Certificate = class MockX509Certificate {
			constructor(pem) {
				this.pem = pem;
				this.infoAccess = 'OCSP - URI:http://ocsp.example.com';
			}

			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			checkPrivateKey(_privateKey) {
				// Mock implementation - always return true for testing
				return true;
			}
		};
		
		// Mock easy-ocsp module in require cache
		const easyOcspPath = require.resolve('easy-ocsp');
		require.cache[easyOcspPath] = {
			id: easyOcspPath,
			filename: easyOcspPath,
			loaded: true,
			exports: {
				getCertStatus: getCertStatusStub,
				getCertURLs: getCertURLsStub
			}
		};
		
		// Now load the module after all stubs are in place
		certificateVerification = require('../../security/certificateVerification.ts');
	});
	
	after(function() {
		sinon.restore();
		// Restore original X509Certificate
		crypto.X509Certificate = originalX509Certificate;
		// Clean up require cache manipulation
		const easyOcspPath = require.resolve('easy-ocsp');
		const certVerificationPath = require.resolve('../../security/certificateVerification.ts');
		delete require.cache[easyOcspPath];
		delete require.cache[certVerificationPath];
	});
	
	beforeEach(function () {
		// Reset all stubs
		mockLogger.debug.resetHistory();
		mockLogger.trace.resetHistory();
		mockLogger.error.resetHistory();
		mockLogger.warn.resetHistory();
		mockTable.get.resetHistory();
		mockTable.put.resetHistory();
		mockTable.sourcedFrom.resetHistory();
		mockTable.setTTLExpiration.resetHistory();
		getCertStatusStub.resetHistory();
		getCertURLsStub.resetHistory();
		mockCacheEntries.clear();

		// Set default behaviors
		// Mock Harper's caching behavior with proper concurrent request handling
		const pendingSourceFetches = new Map();

		mockTable.get.callsFake(async (cacheKey, context) => {
			if (mockCacheEntries.has(cacheKey)) {
				// Return cached entry
				return createMockResource(mockCacheEntries.get(cacheKey), false);
			} else if (mockSourcedFrom) {
				// Check if there's already a pending fetch for this key
				if (pendingSourceFetches.has(cacheKey)) {
					// Wait for the existing fetch to complete
					try {
						const data = await pendingSourceFetches.get(cacheKey);
						if (data) {
							return createMockResource(data, true);
						}
						// Source returned null - return null to trigger fail-open
						return null;
						// eslint-disable-next-line sonarjs/no-ignored-exceptions
					} catch (_error) {
						// Source threw an error - return null to trigger fail-open
						return null;
					}
				}

				// Start a new fetch and store the promise
				const fetchPromise = (async () => {
					const source = new mockSourcedFrom();
					source.getId = () => cacheKey;
					// Mock getContext to return the source context with requestContext
					source.getContext = () => ({
						requestContext: context,
					});
					try {
						// Call get with just the id - context comes from getContext()
						const data = await source.get(cacheKey);

						// Handle fail-open logic for OCSP errors based on failureMode
						if (data && data.status === 'unknown' && data.reason === 'ocsp-error') {
							const config = context.config || {};
							const failureMode = config.failureMode || 'fail-open';

							// Always log the error (simulates source logging)
							mockLogger.error('OCSP verification error:', data.reason);

							if (failureMode === 'fail-open') {
								// Return null to trigger fail-open behavior in verifyOCSP
								return null;
							}
							// For fail-closed, fall through to cache the error
						}

						if (data) {
							mockCacheEntries.set(cacheKey, data);
							return data;
						}
						// Source returned null (fail-open), don't cache
						return null;
					} catch (sourceError) {
						// Source threw an error - return null to trigger fail-open
						return null;
					} finally {
						// Clean up the pending fetch
						pendingSourceFetches.delete(cacheKey);
					}
				})();

				pendingSourceFetches.set(cacheKey, fetchPromise);

				try {
					const data = await fetchPromise;
					if (data) {
						return createMockResource(data, true);
					}
					// Source returned null - return null to trigger fail-open
					return null;
					// eslint-disable-next-line sonarjs/no-ignored-exceptions
				} catch (_error) {
					// Source threw an error - return null to trigger fail-open
					return null;
				}
			}
			return null;
		});

		mockTable.put.resolves();
		getCertStatusStub.resolves({ status: 'good' });
		getCertURLsStub.returns({ ocspUrl: 'http://ocsp.example.com', issuerUrl: 'http://issuer.example.com' });
	});

	describe('getCertificateVerificationConfig', function () {
		it('should return false when mtlsConfig is falsy', function () {
			assert.strictEqual(certificateVerification.getCertificateVerificationConfig(null), false);
			assert.strictEqual(certificateVerification.getCertificateVerificationConfig(undefined), false);
			assert.strictEqual(certificateVerification.getCertificateVerificationConfig(false), false);
		});

		it('should return empty object when mtlsConfig is true', function () {
			assert.deepStrictEqual(certificateVerification.getCertificateVerificationConfig(true), {});
		});

		it('should return empty object when certificateVerification is not specified', function () {
			assert.deepStrictEqual(certificateVerification.getCertificateVerificationConfig({}), {});
			assert.deepStrictEqual(certificateVerification.getCertificateVerificationConfig({ someOtherProp: 'value' }), {});
		});

		it('should return false when certificateVerification is false', function () {
			assert.strictEqual(
				certificateVerification.getCertificateVerificationConfig({ certificateVerification: false }),
				false
			);
		});

		it('should return empty object when certificateVerification is true', function () {
			assert.deepStrictEqual(
				certificateVerification.getCertificateVerificationConfig({ certificateVerification: true }),
				{}
			);
		});

		it('should return the config object when certificateVerification is an object', function () {
			const config = { timeout: 10000, cacheTtl: 7200000 };
			assert.deepStrictEqual(
				certificateVerification.getCertificateVerificationConfig({ certificateVerification: config }),
				config
			);
		});
	});

	describe('bufferToPem', function () {
		it('should convert buffer to PEM format with proper line breaks', function () {
			const buffer = Buffer.from(
				'test certificate data that is long enough to span multiple lines when base64 encoded'
			);
			const pem = certificateVerification.bufferToPem(buffer, 'CERTIFICATE');

			assert(pem.startsWith('-----BEGIN CERTIFICATE-----'));
			assert(pem.endsWith('-----END CERTIFICATE-----'));

			const lines = pem.split('\n');
			// First and last lines are headers
			for (let i = 1; i < lines.length - 1; i++) {
				assert(lines[i].length <= 64, `Line ${i} is too long: ${lines[i].length}`);
			}
		});

		it('should handle empty buffer', function () {
			const buffer = Buffer.from('');
			const pem = certificateVerification.bufferToPem(buffer, 'TEST');

			assert.strictEqual(pem, '-----BEGIN TEST-----\n-----END TEST-----');
		});
	});

	describe('extractCertificateChain', function () {
		it('should extract single certificate without issuer', function () {
			const peerCert = {
				raw: Buffer.from('cert1'),
			};

			const chain = certificateVerification.extractCertificateChain(peerCert);

			assert.strictEqual(chain.length, 1);
			assert.deepStrictEqual(chain[0].cert, Buffer.from('cert1'));
			assert.strictEqual(chain[0].issuer, undefined);
		});

		it('should extract certificate with issuer', function () {
			const issuerCert = {
				raw: Buffer.from('issuer'),
			};

			const peerCert = {
				raw: Buffer.from('cert1'),
				issuerCertificate: issuerCert,
			};

			const chain = certificateVerification.extractCertificateChain(peerCert);

			assert.strictEqual(chain.length, 2);
			assert.deepStrictEqual(chain[0].cert, Buffer.from('cert1'));
			assert.deepStrictEqual(chain[0].issuer, Buffer.from('issuer'));
			assert.deepStrictEqual(chain[1].cert, Buffer.from('issuer'));
		});

		it('should handle self-signed certificate', function () {
			const selfSigned = {
				raw: Buffer.from('self-signed'),
			};
			selfSigned.issuerCertificate = selfSigned;

			const chain = certificateVerification.extractCertificateChain(selfSigned);

			assert.strictEqual(chain.length, 1);
			assert.deepStrictEqual(chain[0].cert, Buffer.from('self-signed'));
			assert.strictEqual(chain[0].issuer, undefined);
		});

		it('should extract full certificate chain', function () {
			const rootCert = {
				raw: Buffer.from('root'),
			};

			const intermediateCert = {
				raw: Buffer.from('intermediate'),
				issuerCertificate: rootCert,
			};

			const leafCert = {
				raw: Buffer.from('leaf'),
				issuerCertificate: intermediateCert,
			};

			const chain = certificateVerification.extractCertificateChain(leafCert);

			assert.strictEqual(chain.length, 3);
			assert.deepStrictEqual(chain[0].cert, Buffer.from('leaf'));
			assert.deepStrictEqual(chain[0].issuer, Buffer.from('intermediate'));
			assert.deepStrictEqual(chain[1].cert, Buffer.from('intermediate'));
			assert.deepStrictEqual(chain[1].issuer, Buffer.from('root'));
			assert.deepStrictEqual(chain[2].cert, Buffer.from('root'));
		});

		it('should handle missing raw buffer', function () {
			const peerCert = {
				subject: { CN: 'Test' },
			};

			const chain = certificateVerification.extractCertificateChain(peerCert);

			assert.strictEqual(chain.length, 0);
		});
	});

	describe('verifyCertificate', function () {
		it('should return disabled when verification is disabled', async function () {
			const result = await certificateVerification.verifyCertificate({}, false);

			assert.deepStrictEqual(result, {
				valid: true,
				status: 'disabled',
				method: 'disabled',
			});
		});

		it('should return disabled when mtlsConfig has certificateVerification: false', async function () {
			const result = await certificateVerification.verifyCertificate({}, { certificateVerification: false });

			assert.deepStrictEqual(result, {
				valid: true,
				status: 'disabled',
				method: 'disabled',
			});
		});

		it('should return no-issuer-cert when chain has no issuer', async function () {
			const peerCert = {
				raw: Buffer.from('cert'),
			};

			const result = await certificateVerification.verifyCertificate(peerCert, true);

			assert.deepStrictEqual(result, {
				valid: true,
				status: 'no-issuer-cert',
				method: 'disabled',
			});
		});

		it('should perform OCSP verification when chain is valid', async function () {
			const peerCert = {
				raw: Buffer.from('cert'),
				issuerCertificate: {
					raw: Buffer.from('issuer'),
				},
			};

			const result = await certificateVerification.verifyCertificate(peerCert, true);

			assert.strictEqual(result.valid, true);
			assert.strictEqual(result.status, 'good');
			assert.strictEqual(result.method, 'ocsp');
			assert.strictEqual(result.cached, false);
		});
	});

	describe('verifyOCSP', function () {
		const certPem = '-----BEGIN CERTIFICATE-----\nMIIBkTCB+wIJAKHH...\n-----END CERTIFICATE-----';
		const issuerPem = '-----BEGIN CERTIFICATE-----\nMIIBkTCB+wIJAKHI...\n-----END CERTIFICATE-----';

		it('should return cached result when available', async function () {
			// Pre-populate the cache with an entry
			const cacheKey = computeCacheKey(certPem, issuerPem);

			const cachedEntry = {
				certificate_id: cacheKey,
				status: 'good',
				expiresAt: Date.now() + 3600000,
				method: 'ocsp',
			};

			mockCacheEntries.set(cacheKey, cachedEntry);

			const result = await certificateVerification.verifyOCSP(certPem, issuerPem);

			assert.deepStrictEqual(result, {
				valid: true,
				status: 'good',
				cached: true,
				method: 'ocsp',
			});

			assert(mockTable.get.calledOnce);
			assert(!getCertStatusStub.called);
		});

		it('should perform OCSP check when cache entry is not found', async function () {
			// Cache is empty, so Harper will call the source
			// The source should have been configured during module load

			const result = await certificateVerification.verifyOCSP(certPem, issuerPem);

			assert.strictEqual(result.valid, true);
			assert.strictEqual(result.status, 'good');
			assert.strictEqual(result.cached, false);
			assert(getCertStatusStub.calledOnce);
		});

		it('should handle good certificate status', async function () {
			const result = await certificateVerification.verifyOCSP(certPem, issuerPem);

			assert.strictEqual(result.valid, true);
			assert.strictEqual(result.status, 'good');
			assert.strictEqual(result.method, 'ocsp');

			// With Harper's caching, the source handles caching internally
			// The cache entry should now be in our mock cache
			const cacheKey = computeCacheKey(certPem, issuerPem);
			assert(mockCacheEntries.has(cacheKey));
			const cacheEntry = mockCacheEntries.get(cacheKey);
			assert.strictEqual(cacheEntry.status, 'good');
			assert.strictEqual(cacheEntry.method, 'ocsp');
		});

		it('should handle revoked certificate status', async function () {
			getCertStatusStub.resolves({
				status: 'revoked',
				revocationReason: 'keyCompromise',
			});

			const result = await certificateVerification.verifyOCSP(certPem, issuerPem);

			assert.strictEqual(result.valid, false);
			assert.strictEqual(result.status, 'revoked');
			assert.strictEqual(result.method, 'ocsp');

			// Verify cache was updated with reason
			const cacheKey = computeCacheKey(certPem, issuerPem);
			assert(mockCacheEntries.has(cacheKey));
			const cacheEntry = mockCacheEntries.get(cacheKey);
			assert.strictEqual(cacheEntry.status, 'revoked');
			assert.strictEqual(cacheEntry.reason, 'keyCompromise');
		});

		it('should handle unknown certificate status', async function () {
			getCertStatusStub.resolves({ status: 'unknown' });

			const result = await certificateVerification.verifyOCSP(certPem, issuerPem);

			assert.strictEqual(result.valid, false);
			assert.strictEqual(result.status, 'unknown');
		});

		it('should convert buffers to PEM format', async function () {
			const certBuffer = Buffer.from('cert-data');
			const issuerBuffer = Buffer.from('issuer-data');

			const result = await certificateVerification.verifyOCSP(certBuffer, issuerBuffer);

			assert.strictEqual(result.valid, true);
			assert.strictEqual(result.status, 'good');

			// Verify buffers were converted by checking the OCSP call
			assert(getCertStatusStub.called);
			const callArgs = getCertStatusStub.firstCall.args;
			assert(callArgs[0].includes('-----BEGIN CERTIFICATE-----'));
			assert(callArgs[1].ca.includes('-----BEGIN CERTIFICATE-----'));
		});

		it('should respect custom timeout', async function () {
			this.timeout(3000);
			const customTimeout = 100;

			// Simulate timeout by making getCertStatus never resolve within the timeout
			getCertStatusStub.callsFake(() => new Promise((resolve) => setTimeout(() => resolve({ status: 'good' }), 200)));

			const result = await certificateVerification.verifyOCSP(certPem, issuerPem, {
				timeout: customTimeout,
				failureMode: 'fail-closed',
			});

			// With Harper caching, timeout errors result in 'unknown' status
			assert.strictEqual(result.valid, false);
			assert.strictEqual(result.status, 'unknown');
			assert(mockLogger.error.called);
		});

		it('should respect custom cache TTL', async function () {
			const customTtl = 7200000; // 2 hours

			await certificateVerification.verifyOCSP(certPem, issuerPem, { cacheTtl: customTtl });

			// With Harper caching, TTL is handled in the source
			const cacheKey = computeCacheKey(certPem, issuerPem);
			assert(mockCacheEntries.has(cacheKey));
			const cacheEntry = mockCacheEntries.get(cacheKey);
			const expectedExpiry = Date.now() + customTtl;
			assert(Math.abs(cacheEntry.expiresAt - expectedExpiry) < 1000);
		});

		it('should respect custom error cache TTL', async function () {
			const customErrorTtl = 60000; // 1 minute
			getCertStatusStub.rejects(new Error('Network error'));

			await certificateVerification.verifyOCSP(certPem, issuerPem, {
				failureMode: 'fail-closed',
				errorCacheTtl: customErrorTtl
			});

			// Check that error was cached with custom TTL
			const cacheKey = computeCacheKey(certPem, issuerPem);
			assert(mockCacheEntries.has(cacheKey));
			const cacheEntry = mockCacheEntries.get(cacheKey);
			const expectedExpiry = Date.now() + customErrorTtl;
			assert(Math.abs(cacheEntry.expiresAt - expectedExpiry) < 1000);
		});

		it('should fail-open by default on errors', async function () {
			getCertStatusStub.rejects(new Error('Network error'));

			const result = await certificateVerification.verifyOCSP(certPem, issuerPem);

			assert.strictEqual(result.valid, true);
			assert.strictEqual(result.status, 'error-allowed');
			assert.strictEqual(result.method, 'ocsp');
			assert(mockLogger.error.called);
			assert(mockLogger.warn.called);
		});

		it('should fail-closed when configured', async function () {
			getCertStatusStub.rejects(new Error('Network error'));

			const result = await certificateVerification.verifyOCSP(certPem, issuerPem, { failureMode: 'fail-closed' });

			// With Harper caching, fail-closed returns an 'unknown' status from source
			assert.strictEqual(result.valid, false);
			assert.strictEqual(result.status, 'unknown');
			assert.strictEqual(result.method, 'ocsp');
			assert(mockLogger.error.called);
		});

		it('should handle OCSP check timeout', async function () {
			getCertStatusStub.callsFake(() => new Promise(() => {})); // Never resolves

			const result = await certificateVerification.verifyOCSP(certPem, issuerPem, {
				timeout: 100,
				failureMode: 'fail-closed',
			});

			// With fail-closed, timeout returns 'unknown' status
			assert.strictEqual(result.valid, false);
			assert.strictEqual(result.status, 'unknown');
			assert(mockLogger.error.called);
		});

		describe('race condition prevention', function () {
			const certPem = '-----BEGIN CERTIFICATE-----\nMIIBkTCB+wIJAKHH...\n-----END CERTIFICATE-----';
			const issuerPem = '-----BEGIN CERTIFICATE-----\nMIIBkTCB+wIJAKHI...\n-----END CERTIFICATE-----';

			it('should prevent duplicate OCSP requests for the same certificate', async function () {
				// Make getCertStatus take 50ms to resolve
				getCertStatusStub.callsFake(() => new Promise((resolve) => setTimeout(() => resolve({ status: 'good' }), 50)));

				// Start 5 concurrent verification requests for the same certificate
				const promises = [];
				for (let i = 0; i < 5; i++) {
					promises.push(certificateVerification.verifyOCSP(certPem, issuerPem));
				}

				// Wait for all requests to complete
				const results = await Promise.all(promises);

				// All should have the same result
				results.forEach((result) => {
					assert.strictEqual(result.valid, true);
					assert.strictEqual(result.status, 'good');
				});

				// Harper's caching automatically handles race conditions
				// Only one OCSP check should be performed
				// Note: table.get is called once per concurrent request
				assert.strictEqual(getCertStatusStub.callCount, 1);
				assert.strictEqual(mockTable.get.callCount, 5);
			});

			it('should handle errors in concurrent requests correctly', async function () {
				// Reset stubs and cache to ensure clean state
				getCertStatusStub.reset();
				mockCacheEntries.clear();

				// Make getCertStatus fail after 50ms
				getCertStatusStub.callsFake(
					() => new Promise((_, reject) => setTimeout(() => reject(new Error('Network error')), 50))
				);

				// Start 3 concurrent verification requests (default fail-open)
				const promises = [];
				for (let i = 0; i < 3; i++) {
					promises.push(certificateVerification.verifyOCSP(certPem, issuerPem));
				}

				// All should get the same error result (fail-open)
				const results = await Promise.all(promises);
				results.forEach((result) => {
					assert.strictEqual(result.valid, true);
					assert.strictEqual(result.status, 'error-allowed');
				});

				// Only one OCSP attempt should be made
				assert.strictEqual(getCertStatusStub.callCount, 1);
				// Multiple table.get calls but only one source fetch
				assert.strictEqual(mockTable.get.callCount, 3);
			});

			it('should allow new requests after the pending request completes', async function () {
				// First request
				getCertStatusStub.onFirstCall().resolves({ status: 'good' });
				const result1 = await certificateVerification.verifyOCSP(certPem, issuerPem);
				assert.strictEqual(result1.status, 'good');
				assert.strictEqual(result1.cached, false); // Loaded from source
				assert.strictEqual(getCertStatusStub.callCount, 1);

				// Second request should use cache
				const result2 = await certificateVerification.verifyOCSP(certPem, issuerPem);
				assert.strictEqual(result2.status, 'good');
				assert.strictEqual(result2.cached, true);
				assert.strictEqual(getCertStatusStub.callCount, 1); // No new OCSP request
			});
		});
	});
	
	describe('error handling', function() {
		it('should handle table.get errors gracefully', async function() {
			// Override the default mock behavior to throw an error
			mockTable.get.rejects(new Error('Database error'));
			
			const result = await certificateVerification.verifyOCSP('cert', 'issuer');
			
			// Table.get error causes the whole function to fail-open
			assert.strictEqual(result.valid, true);
			assert.strictEqual(result.status, 'error-allowed');
			assert(mockLogger.error.called);
		});
		
		it('should handle source errors gracefully in fail-open mode', async function() {
			// Reset stubs to clear default behavior
			getCertStatusStub.reset();
			mockCacheEntries.clear();
			
			// Make the OCSP check fail
			getCertStatusStub.rejects(new Error('OCSP server error'));
			
			const result = await certificateVerification.verifyOCSP('cert', 'issuer');
			
			// Source error with fail-open returns null, causing fail-open behavior
			assert.strictEqual(result.valid, true);
			assert.strictEqual(result.status, 'error-allowed');
			assert(mockLogger.error.called);
			assert(mockLogger.warn.called);
		});
		
		it('should handle malformed OCSP responses', async function() {
			// Clear the default stub behavior
			getCertStatusStub.reset();
			getCertStatusStub.resolves({ status: 'invalid-status' });

			const result = await certificateVerification.verifyOCSP('cert', 'issuer');

			assert.strictEqual(result.valid, false);
			assert.strictEqual(result.status, 'unknown');
			assert.strictEqual(result.cached, false);
			assert.strictEqual(result.method, 'ocsp');
		});

		it('should handle certificates without OCSP URLs', async function() {
			// Reset stubs to clear default behavior
			getCertURLsStub.reset();
			getCertStatusStub.reset();
			mockCacheEntries.clear();

			// Mock getCertURLs to throw error for no OCSP URL
			getCertURLsStub.throws(new Error('Certificate does not contain OCSP url'));

			const certPem = '-----BEGIN CERTIFICATE-----\nY2VydA==\n-----END CERTIFICATE-----';
			const issuerPem = '-----BEGIN CERTIFICATE-----\naXNzdWVy\n-----END CERTIFICATE-----';
			// Use fail-closed to prevent fail-open behavior in this error handling test
			const result = await certificateVerification.verifyOCSP(certPem, issuerPem, { failureMode: 'fail-closed' });

			// Should return unknown status with no-ocsp-url reason
			assert.strictEqual(result.valid, false);
			assert.strictEqual(result.status, 'unknown');
			assert.strictEqual(result.cached, false);
			assert.strictEqual(result.method, 'ocsp');

			// getCertStatus should not be called since we detected no OCSP URL
			assert(!getCertStatusStub.called);
			assert(getCertURLsStub.calledOnce);

			// Should have cached the result
			const cacheKey = computeCacheKey(certPem, issuerPem);
			assert(mockCacheEntries.has(cacheKey));
			const cacheEntry = mockCacheEntries.get(cacheKey);
			assert.strictEqual(cacheEntry.status, 'unknown');
			assert.strictEqual(cacheEntry.reason, 'no-ocsp-url');
		});

		it('should handle AbortError (timeout) from OCSP library', async function() {
			// Reset stubs to clear default behavior
			getCertURLsStub.reset();
			getCertStatusStub.reset();
			mockCacheEntries.clear();

			// Mock getCertURLs to succeed, then getCertStatus to throw AbortError
			getCertURLsStub.returns({ ocspUrl: 'http://ocsp.example.com', issuerUrl: 'http://issuer.example.com' });
			const abortError = new DOMException('The operation was aborted', 'AbortError');
			getCertStatusStub.throws(abortError);

			const certPem = '-----BEGIN CERTIFICATE-----\nY2VydA==\n-----END CERTIFICATE-----';
			const issuerPem = '-----BEGIN CERTIFICATE-----\naXNzdWVy\n-----END CERTIFICATE-----';
			// Use fail-closed to prevent fail-open behavior in this error handling test
			const result = await certificateVerification.verifyOCSP(certPem, issuerPem, { failureMode: 'fail-closed' });

			// Should return unknown status with timeout reason
			assert.strictEqual(result.valid, false);
			assert.strictEqual(result.status, 'unknown');
			assert.strictEqual(result.cached, false);
			assert.strictEqual(result.method, 'ocsp');

			// Both functions should have been called
			assert(getCertURLsStub.calledOnce);
			assert(getCertStatusStub.calledOnce);

			// Should have cached the result
			const cacheKey = computeCacheKey(certPem, issuerPem);
			assert(mockCacheEntries.has(cacheKey));
			const cacheEntry = mockCacheEntries.get(cacheKey);
			assert.strictEqual(cacheEntry.status, 'unknown');
			assert.strictEqual(cacheEntry.reason, 'timeout');
		});

		it('should handle other OCSP library errors generically', async function() {
			// Reset stubs to clear default behavior
			getCertURLsStub.reset();
			getCertStatusStub.reset();
			mockCacheEntries.clear();

			// Mock getCertURLs to succeed, then getCertStatus to throw generic error
			getCertURLsStub.returns({ ocspUrl: 'http://ocsp.example.com', issuerUrl: 'http://issuer.example.com' });
			getCertStatusStub.throws(new Error('Some other OCSP error'));

			const certPem = '-----BEGIN CERTIFICATE-----\nY2VydA==\n-----END CERTIFICATE-----';
			const issuerPem = '-----BEGIN CERTIFICATE-----\naXNzdWVy\n-----END CERTIFICATE-----';
			// Use fail-closed to prevent fail-open behavior in this error handling test
			const result = await certificateVerification.verifyOCSP(certPem, issuerPem, { failureMode: 'fail-closed' });

			// Should return unknown status with ocsp-error reason
			assert.strictEqual(result.valid, false);
			assert.strictEqual(result.status, 'unknown');
			assert.strictEqual(result.cached, false);
			assert.strictEqual(result.method, 'ocsp');

			// Both functions should have been called
			assert(getCertURLsStub.calledOnce);
			assert(getCertStatusStub.calledOnce);

			// Should have cached the result
			const cacheKey = computeCacheKey(certPem, issuerPem);
			assert(mockCacheEntries.has(cacheKey));
			const cacheEntry = mockCacheEntries.get(cacheKey);
			assert.strictEqual(cacheEntry.status, 'unknown');
			assert.strictEqual(cacheEntry.reason, 'ocsp-error');
		});
	});
	
	describe('setCertificateCacheTTL', function() {
		it('should call setTTLExpiration on the cache table', function() {
			const ttlConfig = {
				expiration: 3600, // 1 hour
				eviction: 7200, // 2 hours
				scanInterval: 300 // 5 minutes
			};
			
			certificateVerification.setCertificateCacheTTL(ttlConfig);
			
			assert(mockTable.setTTLExpiration.calledOnce);
			assert(mockTable.setTTLExpiration.calledWith(ttlConfig));
		});
	});
});