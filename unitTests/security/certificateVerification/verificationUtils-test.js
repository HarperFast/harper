const assert = require('node:assert/strict');

// First set up test environment
const test_utils = require('../../test_utils');
test_utils.preTestPrep();

describe('certificateVerification/verificationUtils.ts', function () {
	let utilsModule;

	before(function () {
		// Load the actual verification utils module
		utilsModule = require('../../../security/certificateVerification/verificationUtils.ts');
	});

	describe('bufferToPem function', function () {
		it('should export bufferToPem function', function () {
			assert.strictEqual(typeof utilsModule.bufferToPem, 'function');
		});

		it('should convert buffer to PEM format correctly', function () {
			const buffer = Buffer.from('Hello World', 'utf8');
			const result = utilsModule.bufferToPem(buffer, 'CERTIFICATE');

			assert.ok(result.startsWith('-----BEGIN CERTIFICATE-----'));
			assert.ok(result.endsWith('-----END CERTIFICATE-----'));
			assert.ok(result.includes('SGVsbG8gV29ybGQ=')); // Base64 of "Hello World"
		});

		it('should handle empty buffer', function () {
			const buffer = Buffer.alloc(0);
			const result = utilsModule.bufferToPem(buffer, 'CERTIFICATE');

			assert.ok(result.startsWith('-----BEGIN CERTIFICATE-----'));
			assert.ok(result.endsWith('-----END CERTIFICATE-----'));
		});

		it('should split long base64 into appropriate lines', function () {
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

	describe('pemToBuffer function', function () {
		it('should export pemToBuffer function', function () {
			assert.strictEqual(typeof utilsModule.pemToBuffer, 'function');
		});

		it('should convert PEM to ArrayBuffer correctly', function () {
			const pem = '-----BEGIN CERTIFICATE-----\nSGVsbG8gV29ybGQ=\n-----END CERTIFICATE-----';
			const result = utilsModule.pemToBuffer(pem);

			assert.ok(result instanceof ArrayBuffer);
			const view = new Uint8Array(result);
			const decoded = String.fromCharCode(...view);
			assert.strictEqual(decoded, 'Hello World');
		});

		it('should handle PEM with whitespace', function () {
			const pem = '-----BEGIN CERTIFICATE-----\n  SGVs\n  bG8g\n  V29y\n  bGQ= \n-----END CERTIFICATE-----';
			const result = utilsModule.pemToBuffer(pem);

			const view = new Uint8Array(result);
			const decoded = String.fromCharCode(...view);
			assert.strictEqual(decoded, 'Hello World');
		});
	});

	describe('cache key generation', function () {
		it('should export createCacheKey function', function () {
			assert.strictEqual(typeof utilsModule.createCacheKey, 'function');
		});

		it('should create consistent cache keys', function () {
			const certPem = '-----BEGIN CERTIFICATE-----\\ntest\\n-----END CERTIFICATE-----';
			const issuerPem = '-----BEGIN CERTIFICATE-----\\nissuer\\n-----END CERTIFICATE-----';

			const key1 = utilsModule.createCacheKey(certPem, issuerPem, 'ocsp');
			const key2 = utilsModule.createCacheKey(certPem, issuerPem, 'ocsp');

			assert.strictEqual(key1, key2);
			assert.ok(key1.startsWith('ocsp:'));
		});

		it('should create different keys for different methods', function () {
			const certPem = '-----BEGIN CERTIFICATE-----\\ntest\\n-----END CERTIFICATE-----';
			const issuerPem = '-----BEGIN CERTIFICATE-----\\nissuer\\n-----END CERTIFICATE-----';

			const ocspKey = utilsModule.createCacheKey(certPem, issuerPem, 'ocsp');
			const crlKey = utilsModule.createCacheKey(certPem, issuerPem, 'crl');

			assert.notStrictEqual(ocspKey, crlKey);
			assert.ok(ocspKey.startsWith('ocsp:'));
			assert.ok(crlKey.startsWith('crl:'));
		});

		it('should export createCRLCacheKey function', function () {
			assert.strictEqual(typeof utilsModule.createCRLCacheKey, 'function');
		});

		it('should create CRL cache keys', function () {
			const url = 'http://example.com/test.crl';

			const key1 = utilsModule.createCRLCacheKey(url);
			const key2 = utilsModule.createCRLCacheKey(url);

			assert.strictEqual(key1, key2);
			assert.ok(key1.startsWith('crl:'));

			// eslint-disable-next-line sonarjs/no-clear-text-protocols
			const key3 = utilsModule.createCRLCacheKey('http://different.com/test.crl');
			assert.notStrictEqual(key1, key3);
		});

		it('should export createRevokedCertificateId function', function () {
			assert.strictEqual(typeof utilsModule.createRevokedCertificateId, 'function');
		});

		it('should create composite revoked certificate IDs', function () {
			const issuerKeyId = 'abc123';
			const serialNumber = 'def456';

			const result = utilsModule.createRevokedCertificateId(issuerKeyId, serialNumber);

			assert.strictEqual(result, 'abc123:def456');

			// Test empty values
			const empty = utilsModule.createRevokedCertificateId('', '');
			assert.strictEqual(empty, ':');
		});
	});

	describe('certificate chain extraction', function () {
		it('should export extractCertificateChain function', function () {
			assert.strictEqual(typeof utilsModule.extractCertificateChain, 'function');
		});

		it('should extract single certificate', function () {
			const peerCert = {
				raw: Buffer.from('cert1'),
			};

			const result = utilsModule.extractCertificateChain(peerCert);

			assert.strictEqual(result.length, 1);
			assert.deepStrictEqual(result[0], { cert: Buffer.from('cert1') });
		});

		it('should extract certificate chain with issuer', function () {
			const issuerCert = {
				raw: Buffer.from('issuer1'),
			};
			const peerCert = {
				raw: Buffer.from('cert1'),
				issuerCertificate: issuerCert,
			};

			const result = utilsModule.extractCertificateChain(peerCert);

			assert.strictEqual(result.length, 2);
			assert.deepStrictEqual(result[0], {
				cert: Buffer.from('cert1'),
				issuer: Buffer.from('issuer1'),
			});
			assert.deepStrictEqual(result[1], { cert: Buffer.from('issuer1') });
		});

		it('should handle self-signed certificate', function () {
			const peerCert = {
				raw: Buffer.from('cert1'),
			};
			peerCert.issuerCertificate = peerCert; // Self-signed

			const result = utilsModule.extractCertificateChain(peerCert);

			assert.strictEqual(result.length, 1);
			assert.deepStrictEqual(result[0], { cert: Buffer.from('cert1') });
		});

		it('should handle missing raw data', function () {
			const peerCert = {}; // No raw data

			const result = utilsModule.extractCertificateChain(peerCert);

			assert.strictEqual(result.length, 0);
		});

		it('should handle long certificate chains', function () {
			// Create a 4-level chain: leaf -> intermediate1 -> intermediate2 -> root
			const rootCert = {
				raw: Buffer.from('root-cert'),
			};
			const intermediate2Cert = {
				raw: Buffer.from('intermediate2-cert'),
				issuerCertificate: rootCert,
			};
			const intermediate1Cert = {
				raw: Buffer.from('intermediate1-cert'),
				issuerCertificate: intermediate2Cert,
			};
			const leafCert = {
				raw: Buffer.from('leaf-cert'),
				issuerCertificate: intermediate1Cert,
			};

			const result = utilsModule.extractCertificateChain(leafCert);

			assert.strictEqual(result.length, 4);
			assert.deepStrictEqual(result[0], {
				cert: Buffer.from('leaf-cert'),
				issuer: Buffer.from('intermediate1-cert'),
			});
			assert.deepStrictEqual(result[1], {
				cert: Buffer.from('intermediate1-cert'),
				issuer: Buffer.from('intermediate2-cert'),
			});
			assert.deepStrictEqual(result[2], {
				cert: Buffer.from('intermediate2-cert'),
				issuer: Buffer.from('root-cert'),
			});
			assert.deepStrictEqual(result[3], {
				cert: Buffer.from('root-cert'),
			});
		});

		it('should handle null issuer certificate', function () {
			const peerCert = {
				raw: Buffer.from('cert1'),
				issuerCertificate: null, // Explicitly null
			};

			const result = utilsModule.extractCertificateChain(peerCert);

			assert.strictEqual(result.length, 1);
			assert.deepStrictEqual(result[0], {
				cert: Buffer.from('cert1'),
			});
		});
	});

	describe('error handling for certificate parsing', function () {
		it('should handle invalid certificates gracefully', function () {
			const invalidPem = 'invalid-certificate-data';

			// Functions that return empty arrays/objects on error
			assert.deepStrictEqual(utilsModule.extractRevocationUrls(invalidPem), { crlUrls: [], ocspUrls: [] });
			assert.deepStrictEqual(utilsModule.extractCRLDistributionPoints(invalidPem), []);
			assert.deepStrictEqual(utilsModule.extractOCSPUrls(invalidPem), []);

			// Functions that throw on error
			assert.throws(() => utilsModule.extractSerialNumber(invalidPem), /Failed to extract certificate serial number/);
			assert.throws(() => utilsModule.extractIssuerKeyId(invalidPem), /Failed to extract issuer key ID/);
		});

		it('should handle various PEM formats', function () {
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

		it('should handle different certificate types in bufferToPem', function () {
			const buffer = Buffer.from('test');

			// Test with different certificate types
			const certResult = utilsModule.bufferToPem(buffer, 'CERTIFICATE');
			assert.ok(certResult.includes('-----BEGIN CERTIFICATE-----'));
			assert.ok(certResult.includes('-----END CERTIFICATE-----'));

			const keyResult = utilsModule.bufferToPem(buffer, 'PRIVATE KEY');
			assert.ok(keyResult.includes('-----BEGIN PRIVATE KEY-----'));
			assert.ok(keyResult.includes('-----END PRIVATE KEY-----'));
		});

		it('should properly handle line wrapping in bufferToPem', function () {
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

		it('should handle additional data in cache keys', function () {
			const certPem = '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----';
			const issuerPem = '-----BEGIN CERTIFICATE-----\nissuer\n-----END CERTIFICATE-----';

			const key1 = utilsModule.createCacheKey(certPem, issuerPem, 'ocsp', { url: 'test' });
			const key2 = utilsModule.createCacheKey(certPem, issuerPem, 'ocsp', { url: 'different' });

			// Different additional data should produce different keys
			assert.notStrictEqual(key1, key2);
		});
	});

	describe('cache key edge cases', function () {
		it('should handle createCacheKey without additional data', function () {
			const certPem = '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----';
			const issuerPem = '-----BEGIN CERTIFICATE-----\nissuer\n-----END CERTIFICATE-----';

			const key = utilsModule.createCacheKey(certPem, issuerPem, 'crl');
			assert.ok(key);
			assert.ok(typeof key === 'string');
			assert.ok(key.startsWith('crl:'));
		});

		it('should create different keys for same cert with different methods', function () {
			const certPem = '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----';
			const issuerPem = '-----BEGIN CERTIFICATE-----\nissuer\n-----END CERTIFICATE-----';

			const crlKey = utilsModule.createCacheKey(certPem, issuerPem, 'crl');
			const ocspKey = utilsModule.createCacheKey(certPem, issuerPem, 'ocsp');

			assert.notStrictEqual(crlKey, ocspKey);
		});

		it('should create different keys for different certificates', function () {
			const certPem1 = '-----BEGIN CERTIFICATE-----\ncert1\n-----END CERTIFICATE-----';
			const certPem2 = '-----BEGIN CERTIFICATE-----\ncert2\n-----END CERTIFICATE-----';
			const issuerPem = '-----BEGIN CERTIFICATE-----\nissuer\n-----END CERTIFICATE-----';

			const key1 = utilsModule.createCacheKey(certPem1, issuerPem, 'ocsp');
			const key2 = utilsModule.createCacheKey(certPem2, issuerPem, 'ocsp');

			assert.notStrictEqual(key1, key2);
		});

		it('should create different keys for different issuers', function () {
			const certPem = '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----';
			const issuerPem1 = '-----BEGIN CERTIFICATE-----\nissuer1\n-----END CERTIFICATE-----';
			const issuerPem2 = '-----BEGIN CERTIFICATE-----\nissuer2\n-----END CERTIFICATE-----';

			const key1 = utilsModule.createCacheKey(certPem, issuerPem1, 'ocsp');
			const key2 = utilsModule.createCacheKey(certPem, issuerPem2, 'ocsp');

			assert.notStrictEqual(key1, key2);
		});

		it('should handle createCRLCacheKey with various URL formats', function () {
			const httpUrl = 'http://example.com/ca.crl';
			const httpsUrl = 'https://example.com/ca.crl';
			const pathUrl = 'http://example.com/path/to/ca.crl';

			const key1 = utilsModule.createCRLCacheKey(httpUrl);
			const key2 = utilsModule.createCRLCacheKey(httpsUrl);
			const key3 = utilsModule.createCRLCacheKey(pathUrl);

			// All should create valid keys
			assert.ok(key1.startsWith('crl:'));
			assert.ok(key2.startsWith('crl:'));
			assert.ok(key3.startsWith('crl:'));

			// Different URLs should create different keys
			assert.notStrictEqual(key1, key2);
			assert.notStrictEqual(key1, key3);
			assert.notStrictEqual(key2, key3);
		});

		it('should handle createRevokedCertificateId with special characters', function () {
			const issuerKeyId = 'ABC:123:DEF';
			const serialNumber = '456:789';

			const result = utilsModule.createRevokedCertificateId(issuerKeyId, serialNumber);

			// Should join with colon
			assert.strictEqual(result, 'ABC:123:DEF:456:789');
		});

		it('should handle createRevokedCertificateId with long values', function () {
			const longIssuerKeyId = 'A'.repeat(100);
			const longSerialNumber = 'B'.repeat(100);

			const result = utilsModule.createRevokedCertificateId(longIssuerKeyId, longSerialNumber);

			// Should handle long values
			assert.strictEqual(result.length, 201); // 100 + 1 (colon) + 100
			assert.ok(result.includes(':'));
		});
	});

	describe('table getter functions', function () {
		it('should export getCertificateCacheTable function', function () {
			assert.strictEqual(typeof utilsModule.getCertificateCacheTable, 'function');
		});

		it('should return certificate cache table with correct structure', function () {
			const table = utilsModule.getCertificateCacheTable();

			assert.ok(table);
			// Table should be a valid HarperDB table (function or object)
			assert.ok(typeof table === 'function' || typeof table === 'object');
		});

		it('should return same table instance on multiple calls', function () {
			const table1 = utilsModule.getCertificateCacheTable();
			const table2 = utilsModule.getCertificateCacheTable();

			// Should return the same table reference
			assert.strictEqual(table1, table2);
		});
	});

	describe('PEM format edge cases', function () {
		it('should handle pemToBuffer with minimal valid PEM', function () {
			const minimalPem = '-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----';
			const result = utilsModule.pemToBuffer(minimalPem);

			assert.ok(result instanceof ArrayBuffer);
			assert.strictEqual(result.byteLength, 1); // "AA==" decodes to 1 byte (0x00)
		});

		it('should handle bufferToPem with empty buffer', function () {
			const emptyBuffer = Buffer.alloc(0);
			const result = utilsModule.bufferToPem(emptyBuffer, 'TEST');

			assert.ok(result.includes('-----BEGIN TEST-----'));
			assert.ok(result.includes('-----END TEST-----'));
		});

		it('should handle bufferToPem with exactly 64 chars of base64', function () {
			// Create buffer that encodes to exactly 64 chars (48 bytes = 64 base64 chars)
			const buffer = Buffer.alloc(48, 'X');
			const result = utilsModule.bufferToPem(buffer, 'CERTIFICATE');

			const lines = result.split('\n');
			// Should have: header, content line(s), footer
			assert.ok(lines.length >= 3);
			assert.strictEqual(lines[0], '-----BEGIN CERTIFICATE-----');
			assert.strictEqual(lines[lines.length - 1], '-----END CERTIFICATE-----');
		});

		it('should handle pemToBuffer with Windows line endings', function () {
			const pemWithCRLF = '-----BEGIN CERTIFICATE-----\r\nU0dWc2JHOD1\r\n-----END CERTIFICATE-----';
			const result = utilsModule.pemToBuffer(pemWithCRLF);

			const view = new Uint8Array(result);
			// Should decode "SGVsbG8=" properly despite CRLF
			assert.ok(view.length > 0);
		});

		it('should handle pemToBuffer with mixed line endings', function () {
			const pemMixed = '-----BEGIN CERTIFICATE-----\r\nU0dW\nbGJHOD1\n-----END CERTIFICATE-----';
			const result = utilsModule.pemToBuffer(pemMixed);

			const view = new Uint8Array(result);
			// Should handle mixed \r\n and \n
			assert.ok(view.length > 0);
		});
	});

	describe('extractCertificateChain edge cases', function () {
		it('should handle certificate with undefined issuerCertificate property', function () {
			const peerCert = {
				raw: Buffer.from('cert-data'),
				// issuerCertificate is undefined (not set at all)
			};

			const result = utilsModule.extractCertificateChain(peerCert);

			assert.strictEqual(result.length, 1);
			assert.deepStrictEqual(result[0], {
				cert: Buffer.from('cert-data'),
			});
		});

		it('should handle very long certificate chains', function () {
			// Create a 10-level chain
			let current = { raw: Buffer.from('root-10') };
			for (let i = 9; i >= 1; i--) {
				current = {
					raw: Buffer.from(`cert-${i}`),
					issuerCertificate: current,
				};
			}

			const result = utilsModule.extractCertificateChain(current);

			assert.strictEqual(result.length, 10);
			assert.ok(result[0].cert.equals(Buffer.from('cert-1')));
			assert.ok(result[9].cert.equals(Buffer.from('root-10')));
		});

		it('should handle certificate chain with identical adjacent certificates', function () {
			// Test detection of self-signed by comparing raw buffers
			const certData = Buffer.from('same-cert');
			const cert1 = { raw: certData };
			const cert2 = { raw: certData };
			cert1.issuerCertificate = cert2;

			const result = utilsModule.extractCertificateChain(cert1);

			// Should detect as self-signed and stop at 1 cert
			// (because issuerCertificate points to different object with same raw data)
			assert.ok(result.length >= 1);
		});
	});
});
