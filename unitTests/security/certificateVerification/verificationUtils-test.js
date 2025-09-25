const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

// First set up test environment
const test_utils = require('../../test_utils');
test_utils.preTestPrep();

describe('certificateVerification/verificationUtils.ts', function() {
	let utilsModule;

	before(function() {
		// Load the actual verification utils module
		utilsModule = require('../../../security/certificateVerification/verificationUtils.ts');
	});

	describe('bufferToPem function', function() {
		it('should export bufferToPem function', function() {
			assert.strictEqual(typeof utilsModule.bufferToPem, 'function');
		});

		it('should convert buffer to PEM format correctly', function() {
			const buffer = Buffer.from('Hello World', 'utf8');
			const result = utilsModule.bufferToPem(buffer, 'CERTIFICATE');

			assert.ok(result.startsWith('-----BEGIN CERTIFICATE-----'));
			assert.ok(result.endsWith('-----END CERTIFICATE-----'));
			assert.ok(result.includes('SGVsbG8gV29ybGQ=')); // Base64 of "Hello World"
		});

		it('should handle empty buffer', function() {
			const buffer = Buffer.alloc(0);
			const result = utilsModule.bufferToPem(buffer, 'CERTIFICATE');

			assert.ok(result.startsWith('-----BEGIN CERTIFICATE-----'));
			assert.ok(result.endsWith('-----END CERTIFICATE-----'));
		});

		it('should split long base64 into appropriate lines', function() {
			const buffer = Buffer.alloc(100, 'A'); // 100 bytes of 'A'
			const result = utilsModule.bufferToPem(buffer, 'CERTIFICATE');

			const lines = result.split('\n');
			// Should have header, multiple content lines, and footer
			assert.ok(lines.length > 3);

			// Should start and end with proper headers
			assert.strictEqual(lines[0], '-----BEGIN CERTIFICATE-----');
			assert.strictEqual(lines[lines.length - 1], '-----END CERTIFICATE-----');
		});
	});

	describe('pemToBuffer function', function() {
		it('should export pemToBuffer function', function() {
			assert.strictEqual(typeof utilsModule.pemToBuffer, 'function');
		});

		it('should convert PEM to ArrayBuffer correctly', function() {
			const pem = '-----BEGIN CERTIFICATE-----\nSGVsbG8gV29ybGQ=\n-----END CERTIFICATE-----';
			const result = utilsModule.pemToBuffer(pem);

			assert.ok(result instanceof ArrayBuffer);
			const view = new Uint8Array(result);
			const decoded = String.fromCharCode(...view);
			assert.strictEqual(decoded, 'Hello World');
		});

		it('should handle PEM with whitespace', function() {
			const pem = '-----BEGIN CERTIFICATE-----\n  SGVs\n  bG8g\n  V29y\n  bGQ= \n-----END CERTIFICATE-----';
			const result = utilsModule.pemToBuffer(pem);

			const view = new Uint8Array(result);
			const decoded = String.fromCharCode(...view);
			assert.strictEqual(decoded, 'Hello World');
		});
	});

	describe('cache key generation', function() {
		it('should export createCacheKey function', function() {
			assert.strictEqual(typeof utilsModule.createCacheKey, 'function');
		});

		it('should create consistent cache keys', function() {
			const certPem = '-----BEGIN CERTIFICATE-----\\ntest\\n-----END CERTIFICATE-----';
			const issuerPem = '-----BEGIN CERTIFICATE-----\\nissuer\\n-----END CERTIFICATE-----';

			const key1 = utilsModule.createCacheKey(certPem, issuerPem, 'ocsp');
			const key2 = utilsModule.createCacheKey(certPem, issuerPem, 'ocsp');

			assert.strictEqual(key1, key2);
			assert.ok(key1.startsWith('ocsp:'));
		});

		it('should create different keys for different methods', function() {
			const certPem = '-----BEGIN CERTIFICATE-----\\ntest\\n-----END CERTIFICATE-----';
			const issuerPem = '-----BEGIN CERTIFICATE-----\\nissuer\\n-----END CERTIFICATE-----';

			const ocspKey = utilsModule.createCacheKey(certPem, issuerPem, 'ocsp');
			const crlKey = utilsModule.createCacheKey(certPem, issuerPem, 'crl');

			assert.notStrictEqual(ocspKey, crlKey);
			assert.ok(ocspKey.startsWith('ocsp:'));
			assert.ok(crlKey.startsWith('crl:'));
		});

		it('should export createCRLCacheKey function', function() {
			assert.strictEqual(typeof utilsModule.createCRLCacheKey, 'function');
		});

		it('should create CRL cache keys', function() {
			const url = 'http://example.com/test.crl';

			const key1 = utilsModule.createCRLCacheKey(url);
			const key2 = utilsModule.createCRLCacheKey(url);

			assert.strictEqual(key1, key2);
			assert.ok(key1.startsWith('crl:'));

			const key3 = utilsModule.createCRLCacheKey('http://different.com/test.crl');
			assert.notStrictEqual(key1, key3);
		});

		it('should export createRevokedCertificateId function', function() {
			assert.strictEqual(typeof utilsModule.createRevokedCertificateId, 'function');
		});

		it('should create composite revoked certificate IDs', function() {
			const issuerKeyId = 'abc123';
			const serialNumber = 'def456';

			const result = utilsModule.createRevokedCertificateId(issuerKeyId, serialNumber);

			assert.strictEqual(result, 'abc123:def456');

			// Test empty values
			const empty = utilsModule.createRevokedCertificateId('', '');
			assert.strictEqual(empty, ':');
		});
	});

	describe('certificate chain extraction', function() {
		it('should export extractCertificateChain function', function() {
			assert.strictEqual(typeof utilsModule.extractCertificateChain, 'function');
		});

		it('should extract single certificate', function() {
			const peerCert = {
				raw: Buffer.from('cert1')
			};

			const result = utilsModule.extractCertificateChain(peerCert);

			assert.strictEqual(result.length, 1);
			assert.deepStrictEqual(result[0], { cert: Buffer.from('cert1') });
		});

		it('should extract certificate chain with issuer', function() {
			const issuerCert = {
				raw: Buffer.from('issuer1')
			};
			const peerCert = {
				raw: Buffer.from('cert1'),
				issuerCertificate: issuerCert
			};

			const result = utilsModule.extractCertificateChain(peerCert);

			assert.strictEqual(result.length, 2);
			assert.deepStrictEqual(result[0], {
				cert: Buffer.from('cert1'),
				issuer: Buffer.from('issuer1')
			});
			assert.deepStrictEqual(result[1], { cert: Buffer.from('issuer1') });
		});

		it('should handle self-signed certificate', function() {
			const peerCert = {
				raw: Buffer.from('cert1')
			};
			peerCert.issuerCertificate = peerCert; // Self-signed

			const result = utilsModule.extractCertificateChain(peerCert);

			assert.strictEqual(result.length, 1);
			assert.deepStrictEqual(result[0], { cert: Buffer.from('cert1') });
		});

		it('should handle missing raw data', function() {
			const peerCert = {}; // No raw data

			const result = utilsModule.extractCertificateChain(peerCert);

			assert.strictEqual(result.length, 0);
		});

		it('should handle long certificate chains', function() {
			// Create a 4-level chain: leaf -> intermediate1 -> intermediate2 -> root
			const rootCert = {
				raw: Buffer.from('root-cert')
			};
			const intermediate2Cert = {
				raw: Buffer.from('intermediate2-cert'),
				issuerCertificate: rootCert
			};
			const intermediate1Cert = {
				raw: Buffer.from('intermediate1-cert'),
				issuerCertificate: intermediate2Cert
			};
			const leafCert = {
				raw: Buffer.from('leaf-cert'),
				issuerCertificate: intermediate1Cert
			};

			const result = utilsModule.extractCertificateChain(leafCert);

			assert.strictEqual(result.length, 4);
			assert.deepStrictEqual(result[0], {
				cert: Buffer.from('leaf-cert'),
				issuer: Buffer.from('intermediate1-cert')
			});
			assert.deepStrictEqual(result[1], {
				cert: Buffer.from('intermediate1-cert'),
				issuer: Buffer.from('intermediate2-cert')
			});
			assert.deepStrictEqual(result[2], {
				cert: Buffer.from('intermediate2-cert'),
				issuer: Buffer.from('root-cert')
			});
			assert.deepStrictEqual(result[3], {
				cert: Buffer.from('root-cert')
			});
		});

		it('should handle null issuer certificate', function() {
			const peerCert = {
				raw: Buffer.from('cert1'),
				issuerCertificate: null // Explicitly null
			};

			const result = utilsModule.extractCertificateChain(peerCert);

			assert.strictEqual(result.length, 1);
			assert.deepStrictEqual(result[0], {
				cert: Buffer.from('cert1')
			});
		});
	});

	describe('error handling for certificate parsing', function() {
		it('should handle invalid certificates gracefully', function() {
			const invalidPem = 'invalid-certificate-data';

			// Functions that return empty arrays/objects on error
			assert.deepStrictEqual(utilsModule.extractRevocationUrls(invalidPem), { crlUrls: [], ocspUrls: [] });
			assert.deepStrictEqual(utilsModule.extractCRLDistributionPoints(invalidPem), []);
			assert.deepStrictEqual(utilsModule.extractOCSPUrls(invalidPem), []);

			// Functions that throw on error
			assert.throws(() => utilsModule.extractSerialNumber(invalidPem), /Failed to extract certificate serial number/);
			assert.throws(() => utilsModule.extractIssuerKeyId(invalidPem), /Failed to extract issuer key ID/);
		});

		it('should handle various PEM formats', function() {
			// Test with different line endings
			const pemWithCRLF = '-----BEGIN CERTIFICATE-----\r\nSGVsbG8=\r\n-----END CERTIFICATE-----';
			const result1 = utilsModule.pemToBuffer(pemWithCRLF);
			const view1 = new Uint8Array(result1);
			assert.strictEqual(String.fromCharCode(...view1), 'Hello');

			// Test with extra whitespace
			const pemWithSpaces = '  -----BEGIN CERTIFICATE-----  \n  SGVsbG8=  \n  -----END CERTIFICATE-----  ';
			const result2 = utilsModule.pemToBuffer(pemWithSpaces);
			const view2 = new Uint8Array(result2);
			assert.strictEqual(String.fromCharCode(...view2), 'Hello');
		});

		it('should handle different certificate types in bufferToPem', function() {
			const buffer = Buffer.from('test');

			// Test with different certificate types
			const certResult = utilsModule.bufferToPem(buffer, 'CERTIFICATE');
			assert.ok(certResult.includes('-----BEGIN CERTIFICATE-----'));
			assert.ok(certResult.includes('-----END CERTIFICATE-----'));

			const keyResult = utilsModule.bufferToPem(buffer, 'PRIVATE KEY');
			assert.ok(keyResult.includes('-----BEGIN PRIVATE KEY-----'));
			assert.ok(keyResult.includes('-----END PRIVATE KEY-----'));
		});

		it('should properly handle line wrapping in bufferToPem', function() {
			// Create buffer that will result in >64 char base64
			const longBuffer = Buffer.alloc(100, 'A'); // 100 bytes will create long base64
			const result = utilsModule.bufferToPem(longBuffer, 'CERTIFICATE');

			const lines = result.split('\n');
			// Should have header + multiple content lines + footer
			assert.ok(lines.length > 3);

			// All content lines (except possibly the last) should be <= 64 chars
			for (let i = 1; i < lines.length - 1; i++) {
				if (lines[i] !== '-----END CERTIFICATE-----') {
					assert.ok(lines[i].length <= 64, `Line ${i} too long: ${lines[i].length} chars`);
				}
			}
		});

		it('should handle additional data in cache keys', function() {
			const certPem = '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----';
			const issuerPem = '-----BEGIN CERTIFICATE-----\nissuer\n-----END CERTIFICATE-----';

			const key1 = utilsModule.createCacheKey(certPem, issuerPem, 'ocsp', { url: 'test' });
			const key2 = utilsModule.createCacheKey(certPem, issuerPem, 'ocsp', { url: 'different' });

			// Different additional data should produce different keys
			assert.notStrictEqual(key1, key2);
		});
	});
});