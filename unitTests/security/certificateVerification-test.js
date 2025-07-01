const assert = require('node:assert/strict');
const sinon = require('sinon');
const { X509Certificate } = require('node:crypto');

// Create mocks
const mockLogger = {
	debug: sinon.stub(),
	trace: sinon.stub(),
	error: sinon.stub(),
	warn: sinon.stub(),
};

const mockTable = {
	get: sinon.stub(),
	put: sinon.stub(),
};

// Create stub for getCertStatus
const getCertStatusStub = sinon.stub();

// Delete the certificateVerification module from cache to ensure fresh load
const certVerificationPath = require.resolve('../../security/certificateVerification.ts');
delete require.cache[certVerificationPath];

// Stub dependencies before requiring the module
const loggerModule = require('../../utility/logging/logger.js');
const loggerStub = sinon.stub(loggerModule, 'loggerWithTag').returns(mockLogger);

const databases = require('../../resources/databases.js');
const tableStub = sinon.stub(databases, 'table').returns(mockTable);

// Mock easy-ocsp module in require cache
const easyOcspPath = require.resolve('easy-ocsp');
require.cache[easyOcspPath] = {
	id: easyOcspPath,
	filename: easyOcspPath,
	loaded: true,
	exports: {
		getCertStatus: getCertStatusStub
	}
};

// Now load the module after all stubs are in place
const certificateVerification = require('../../security/certificateVerification.ts');

// Restore stubs immediately to prevent affecting other tests
loggerStub.restore();
tableStub.restore();

describe('certificateVerification', function() {
	
	before(function() {
		// Re-stub inside the test suite
		sinon.stub(loggerModule, 'loggerWithTag').returns(mockLogger);
		sinon.stub(databases, 'table').returns(mockTable);
	});
	
	after(function() {
		sinon.restore();
		// Clean up require cache manipulation
		delete require.cache[easyOcspPath];
		delete require.cache[certVerificationPath];
	});
	
	beforeEach(function() {
		// Reset all stubs
		mockLogger.debug.resetHistory();
		mockLogger.trace.resetHistory();
		mockLogger.error.resetHistory();
		mockLogger.warn.resetHistory();
		mockTable.get.resetHistory();
		mockTable.put.resetHistory();
		getCertStatusStub.resetHistory();
		
		// Set default behaviors
		mockTable.get.resolves(undefined);
		mockTable.put.resolves();
		getCertStatusStub.resolves({ status: 'good' });
	});
	
	describe('getCertificateVerificationConfig', function() {
		it('should return false when mtlsConfig is falsy', function() {
			assert.strictEqual(certificateVerification.getCertificateVerificationConfig(null), false);
			assert.strictEqual(certificateVerification.getCertificateVerificationConfig(undefined), false);
			assert.strictEqual(certificateVerification.getCertificateVerificationConfig(false), false);
		});
		
		it('should return empty object when mtlsConfig is true', function() {
			assert.deepStrictEqual(certificateVerification.getCertificateVerificationConfig(true), {});
		});
		
		it('should return empty object when certificateVerification is not specified', function() {
			assert.deepStrictEqual(certificateVerification.getCertificateVerificationConfig({}), {});
			assert.deepStrictEqual(certificateVerification.getCertificateVerificationConfig({ someOtherProp: 'value' }), {});
		});
		
		it('should return false when certificateVerification is false', function() {
			assert.strictEqual(certificateVerification.getCertificateVerificationConfig({ certificateVerification: false }), false);
		});
		
		it('should return empty object when certificateVerification is true', function() {
			assert.deepStrictEqual(
				certificateVerification.getCertificateVerificationConfig({ certificateVerification: true }), 
				{}
			);
		});
		
		it('should return the config object when certificateVerification is an object', function() {
			const config = { timeout: 10000, cacheTtl: 7200000 };
			assert.deepStrictEqual(
				certificateVerification.getCertificateVerificationConfig({ certificateVerification: config }), 
				config
			);
		});
	});
	
	describe('bufferToPem', function() {
		it('should convert buffer to PEM format with proper line breaks', function() {
			const buffer = Buffer.from('test certificate data that is long enough to span multiple lines when base64 encoded');
			const pem = certificateVerification.bufferToPem(buffer, 'CERTIFICATE');
			
			assert(pem.startsWith('-----BEGIN CERTIFICATE-----'));
			assert(pem.endsWith('-----END CERTIFICATE-----'));
			
			const lines = pem.split('\n');
			// First and last lines are headers
			for (let i = 1; i < lines.length - 1; i++) {
				assert(lines[i].length <= 64, `Line ${i} is too long: ${lines[i].length}`);
			}
		});
		
		it('should handle empty buffer', function() {
			const buffer = Buffer.from('');
			const pem = certificateVerification.bufferToPem(buffer, 'TEST');
			
			assert.strictEqual(pem, '-----BEGIN TEST-----\n-----END TEST-----');
		});
	});
	
	describe('getCacheKey', function() {
		it('should generate cache key from valid certificate', function() {
			// Mock a valid certificate
			const certPem = '-----BEGIN CERTIFICATE-----\nMIIBkTCB+wIJAKHH...\n-----END CERTIFICATE-----';
			
			// Temporarily mock X509Certificate constructor to avoid parsing errors
			const mockCert = {
				serialNumber: '123456',
				issuer: 'CN=Test Issuer',
			};
			
			const OriginalX509 = global.X509Certificate || X509Certificate;
			global.X509Certificate = class MockX509Certificate {
				constructor() {
					this.serialNumber = mockCert.serialNumber;
					this.issuer = mockCert.issuer;
				}
			};
			
			try {
				const key = certificateVerification.getCacheKey(certPem);
				
				assert(typeof key === 'string');
				assert.strictEqual(key.length, 16);
				assert(/^[a-f0-9]{16}$/.test(key));
			} finally {
				global.X509Certificate = OriginalX509;
			}
		});
		
		it('should use fallback hash when certificate parsing fails', function() {
			const invalidCert = 'not a valid certificate';
			const key = certificateVerification.getCacheKey(invalidCert);
			
			assert(typeof key === 'string');
			assert.strictEqual(key.length, 16);
			assert(/^[a-f0-9]{16}$/.test(key));
			
			// Verify logger was called
			assert(mockLogger.trace.called);
		});
		
		it('should generate consistent keys for the same certificate', function() {
			const certPem = '-----BEGIN CERTIFICATE-----\nMIIBkTCB+wIJAKHH...\n-----END CERTIFICATE-----';
			const key1 = certificateVerification.getCacheKey(certPem);
			const key2 = certificateVerification.getCacheKey(certPem);
			
			assert.strictEqual(key1, key2);
		});
	});
	
	describe('extractCertificateChain', function() {
		it('should extract single certificate without issuer', function() {
			const peerCert = {
				raw: Buffer.from('cert1'),
			};
			
			const chain = certificateVerification.extractCertificateChain(peerCert);
			
			assert.strictEqual(chain.length, 1);
			assert.deepStrictEqual(chain[0].cert, Buffer.from('cert1'));
			assert.strictEqual(chain[0].issuer, undefined);
		});
		
		it('should extract certificate with issuer', function() {
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
		
		it('should handle self-signed certificate', function() {
			const selfSigned = {
				raw: Buffer.from('self-signed'),
			};
			selfSigned.issuerCertificate = selfSigned;
			
			const chain = certificateVerification.extractCertificateChain(selfSigned);
			
			assert.strictEqual(chain.length, 1);
			assert.deepStrictEqual(chain[0].cert, Buffer.from('self-signed'));
			assert.strictEqual(chain[0].issuer, undefined);
		});
		
		it('should extract full certificate chain', function() {
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
		
		it('should handle missing raw buffer', function() {
			const peerCert = {
				subject: { CN: 'Test' },
			};
			
			const chain = certificateVerification.extractCertificateChain(peerCert);
			
			assert.strictEqual(chain.length, 0);
		});
	});
	
	describe('verifyCertificate', function() {
		it('should return disabled when verification is disabled', async function() {
			const result = await certificateVerification.verifyCertificate({}, false);
			
			assert.deepStrictEqual(result, {
				valid: true,
				status: 'disabled',
				method: 'disabled',
			});
		});
		
		it('should return disabled when mtlsConfig has certificateVerification: false', async function() {
			const result = await certificateVerification.verifyCertificate({}, { certificateVerification: false });
			
			assert.deepStrictEqual(result, {
				valid: true,
				status: 'disabled',
				method: 'disabled',
			});
		});
		
		it('should return insufficient-chain when chain is too short', async function() {
			const peerCert = {
				raw: Buffer.from('cert'),
			};
			
			const result = await certificateVerification.verifyCertificate(peerCert, true);
			
			assert.deepStrictEqual(result, {
				valid: true,
				status: 'insufficient-chain',
				method: 'disabled',
			});
		});
		
		it('should perform OCSP verification when chain is valid', async function() {
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
	
	describe('verifyOCSP', function() {
		const certPem = '-----BEGIN CERTIFICATE-----\nMIIBkTCB+wIJAKHH...\n-----END CERTIFICATE-----';
		const issuerPem = '-----BEGIN CERTIFICATE-----\nMIIBkTCB+wIJAKHI...\n-----END CERTIFICATE-----';
		
		it('should return cached result when available', async function() {
			const cachedEntry = {
				certificate_id: 'test-key',
				status: 'good',
				expiresAt: Date.now() + 3600000,
				method: 'ocsp',
			};
			
			mockTable.get.resolves(cachedEntry);
			
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
		
		it('should perform OCSP check when cache entry is not found', async function() {
			// With built-in expiration, expired entries are automatically removed
			// So we simulate this by returning undefined
			mockTable.get.resolves(undefined);
			
			const result = await certificateVerification.verifyOCSP(certPem, issuerPem);
			
			assert.strictEqual(result.valid, true);
			assert.strictEqual(result.status, 'good');
			assert.strictEqual(result.cached, false);
			assert(getCertStatusStub.calledOnce);
		});
		
		it('should handle good certificate status', async function() {
			const result = await certificateVerification.verifyOCSP(certPem, issuerPem);
			
			assert.strictEqual(result.valid, true);
			assert.strictEqual(result.status, 'good');
			assert.strictEqual(result.method, 'ocsp');
			
			// Verify cache was updated
			assert(mockTable.put.calledOnce);
			const cacheEntry = mockTable.put.firstCall.args[1];
			assert.strictEqual(cacheEntry.status, 'good');
			assert.strictEqual(cacheEntry.method, 'ocsp');
		});
		
		it('should handle revoked certificate status', async function() {
			getCertStatusStub.resolves({ 
				status: 'revoked',
				revocationReason: 'keyCompromise',
			});
			
			const result = await certificateVerification.verifyOCSP(certPem, issuerPem);
			
			assert.strictEqual(result.valid, false);
			assert.strictEqual(result.status, 'revoked');
			assert.strictEqual(result.method, 'ocsp');
			
			// Verify cache was updated with reason
			const cacheEntry = mockTable.put.firstCall.args[1];
			assert.strictEqual(cacheEntry.status, 'revoked');
			assert.strictEqual(cacheEntry.reason, 'keyCompromise');
		});
		
		it('should handle unknown certificate status', async function() {
			getCertStatusStub.resolves({ status: 'unknown' });
			
			const result = await certificateVerification.verifyOCSP(certPem, issuerPem);
			
			assert.strictEqual(result.valid, false);
			assert.strictEqual(result.status, 'unknown');
		});
		
		it('should convert buffers to PEM format', async function() {
			const certBuffer = Buffer.from('cert-data');
			const issuerBuffer = Buffer.from('issuer-data');
			
			const result = await certificateVerification.verifyOCSP(certBuffer, issuerBuffer);
			
			assert.strictEqual(result.valid, true);
			assert.strictEqual(result.status, 'good');
			
			// Verify buffers were converted
			const callArgs = getCertStatusStub.firstCall.args;
			assert(callArgs[0].includes('-----BEGIN CERTIFICATE-----'));
			assert(callArgs[1].ca.includes('-----BEGIN CERTIFICATE-----'));
		});
		
		it('should respect custom timeout', async function() {
			this.timeout(3000);
			const customTimeout = 100;
			
			// Simulate timeout by making getCertStatus never resolve within the timeout
			getCertStatusStub.callsFake(() => new Promise(resolve => 
				setTimeout(() => resolve({ status: 'good' }), 200)
			));
			
			const result = await certificateVerification.verifyOCSP(certPem, issuerPem, { timeout: customTimeout, failureMode: 'fail-closed' });
			
			assert.strictEqual(result.valid, false);
			assert.strictEqual(result.status, 'error');
			assert.strictEqual(result.error, 'OCSP timeout');
			assert(mockLogger.error.called);
		});
		
		it('should respect custom cache TTL', async function() {
			const customTtl = 7200000; // 2 hours
			
			await certificateVerification.verifyOCSP(certPem, issuerPem, { cacheTtl: customTtl });
			
			const cacheEntry = mockTable.put.firstCall.args[1];
			const expectedExpiry = Date.now() + customTtl;
			assert(Math.abs(cacheEntry.expiresAt - expectedExpiry) < 1000);
		});
		
		it('should fail-open by default on errors', async function() {
			getCertStatusStub.rejects(new Error('Network error'));
			
			const result = await certificateVerification.verifyOCSP(certPem, issuerPem);
			
			assert.strictEqual(result.valid, true);
			assert.strictEqual(result.status, 'error-allowed');
			assert.strictEqual(result.method, 'ocsp');
			assert(mockLogger.error.called);
			assert(mockLogger.warn.called);
		});
		
		it('should fail-closed when configured', async function() {
			getCertStatusStub.rejects(new Error('Network error'));
			
			const result = await certificateVerification.verifyOCSP(certPem, issuerPem, { failureMode: 'fail-closed' });
			
			assert.strictEqual(result.valid, false);
			assert.strictEqual(result.status, 'error');
			assert.strictEqual(result.error, 'Network error');
			assert.strictEqual(result.method, 'ocsp');
			assert(mockLogger.error.called);
			assert(!mockLogger.warn.called);
		});
		
		it('should handle OCSP check timeout', async function() {
			getCertStatusStub.callsFake(() => new Promise(() => {})); // Never resolves
			
			const result = await certificateVerification.verifyOCSP(certPem, issuerPem, { timeout: 100, failureMode: 'fail-closed' });
			
			assert.strictEqual(result.valid, false);
			assert.strictEqual(result.status, 'error');
			assert(mockLogger.error.called);
		});
		
		describe('race condition prevention', function() {
			const certPem = '-----BEGIN CERTIFICATE-----\nMIIBkTCB+wIJAKHH...\n-----END CERTIFICATE-----';
			const issuerPem = '-----BEGIN CERTIFICATE-----\nMIIBkTCB+wIJAKHI...\n-----END CERTIFICATE-----';
			
			it('should prevent duplicate OCSP requests for the same certificate', async function() {
			// Make getCertStatus take 50ms to resolve
			getCertStatusStub.callsFake(() => new Promise(resolve => 
				setTimeout(() => resolve({ status: 'good' }), 50)
			));
			
			// Start 5 concurrent verification requests for the same certificate
			const promises = [];
			for (let i = 0; i < 5; i++) {
				promises.push(certificateVerification.verifyOCSP(certPem, issuerPem));
			}
			
			// Wait for all requests to complete
			const results = await Promise.all(promises);
			
			// All should have the same result
			results.forEach(result => {
				assert.strictEqual(result.valid, true);
				assert.strictEqual(result.status, 'good');
			});
			
			// But getCertStatus should only be called once
			assert.strictEqual(getCertStatusStub.callCount, 1);
			
			// And the cache should have been updated only once
			assert.strictEqual(mockTable.put.callCount, 1);
		});
		
		it('should handle errors in concurrent requests correctly', async function() {
			// Make getCertStatus fail after 50ms
			getCertStatusStub.callsFake(() => new Promise((_, reject) => 
				setTimeout(() => reject(new Error('Network error')), 50)
			));
			
			// Start 3 concurrent verification requests
			const promises = [];
			for (let i = 0; i < 3; i++) {
				promises.push(certificateVerification.verifyOCSP(certPem, issuerPem));
			}
			
			// All should get the same error result (fail-open)
			const results = await Promise.all(promises);
			results.forEach(result => {
				assert.strictEqual(result.valid, true);
				assert.strictEqual(result.status, 'error-allowed');
			});
			
			// getCertStatus should only be called once
			assert.strictEqual(getCertStatusStub.callCount, 1);
		});
		
		it('should allow new requests after the pending request completes', async function() {
			// First request
			getCertStatusStub.onFirstCall().resolves({ status: 'good' });
			const result1 = await certificateVerification.verifyOCSP(certPem, issuerPem);
			assert.strictEqual(result1.status, 'good');
			assert.strictEqual(getCertStatusStub.callCount, 1);
			
			// Clear cache to force another OCSP check
			mockTable.get.resolves(undefined);
			
			// Second request should trigger a new OCSP check
			getCertStatusStub.onSecondCall().resolves({ status: 'revoked', revocationReason: 'keyCompromise' });
			const result2 = await certificateVerification.verifyOCSP(certPem, issuerPem);
			assert.strictEqual(result2.status, 'revoked');
			assert.strictEqual(getCertStatusStub.callCount, 2);
			});
		});
	});
	
	describe('error handling', function() {
		it('should handle table.get errors gracefully', async function() {
			mockTable.get.rejects(new Error('Database error'));
			
			const result = await certificateVerification.verifyOCSP('cert', 'issuer');
			
			// Table.get error causes the whole function to fail-open
			assert.strictEqual(result.valid, true);
			assert.strictEqual(result.status, 'error-allowed');
			assert(mockLogger.error.called);
		});
		
		it('should handle table.put errors gracefully', async function() {
			mockTable.put.rejects(new Error('Database error'));
			
			const result = await certificateVerification.verifyOCSP('cert', 'issuer');
			
			// Table.put error causes the whole function to fail-open
			assert.strictEqual(result.valid, true);
			assert.strictEqual(result.status, 'error-allowed');
			assert(mockLogger.error.called);
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
	});
});