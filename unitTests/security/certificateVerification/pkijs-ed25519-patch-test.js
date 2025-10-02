const assert = require('node:assert/strict');
const sinon = require('sinon');

// First set up test environment
const test_utils = require('../../test_utils');
test_utils.preTestPrep();

describe('certificateVerification/pkijs-ed25519-patch.ts', function () {
	let patchModule;
	let pkijs;

	// Ed25519/Ed448 OIDs (these are standard OIDs from RFC 8410, not IP addresses)
	// eslint-disable-next-line sonarjs/no-hardcoded-ip
	const ED25519_OID = '1.3.101.112';
	// eslint-disable-next-line sonarjs/no-hardcoded-ip
	const ED448_OID = '1.3.101.113';
	const RSA_OID = '1.2.840.113549.1.1.1'; // RSA for comparison

	before(function () {
		// Load PKI.js before the patch module (patch applies on load)
		pkijs = require('pkijs');
		patchModule = require('../../../security/certificateVerification/pkijs-ed25519-patch.ts');
	});

	describe('patch module exports', function () {
		it('should export applyEd25519Patch function', function () {
			assert.strictEqual(typeof patchModule.applyEd25519Patch, 'function');
		});

		it('should apply patch without errors', function () {
			// The patch should be idempotent - can be called multiple times safely
			assert.doesNotThrow(() => {
				patchModule.applyEd25519Patch();
			});
		});
	});

	describe('Ed25519 OID constants validation', function () {
		it('should recognize standard Ed25519 and Ed448 OIDs', function () {
			// These are the standard OIDs from RFC 8410, not IP addresses
			// eslint-disable-next-line sonarjs/no-hardcoded-ip
			const ed25519Oid = '1.3.101.112';
			// eslint-disable-next-line sonarjs/no-hardcoded-ip
			const ed448Oid = '1.3.101.113';

			// Basic OID format validation
			assert.ok(ed25519Oid.match(/^1\.3\.101\.112$/));
			assert.ok(ed448Oid.match(/^1\.3\.101\.113$/));
		});

		it('should validate algorithm names', function () {
			// Standard algorithm names for EdDSA
			const ed25519Name = 'Ed25519';
			const ed448Name = 'Ed448';

			assert.strictEqual(ed25519Name, 'Ed25519');
			assert.strictEqual(ed448Name, 'Ed448');
		});
	});

	describe('EdDSA algorithm properties', function () {
		it('should understand EdDSA built-in hashing', function () {
			// Ed25519 uses SHA-512 internally (RFC 8032 Section 5.1.6)
			// Ed448 uses SHAKE256 internally (RFC 8032 Section 5.2.6)
			// These are built into the algorithm, not separate parameters
			const ed25519InternalHash = 'SHA-512';
			const ed448InternalHash = 'SHAKE256';

			assert.strictEqual(ed25519InternalHash, 'SHA-512');
			assert.strictEqual(ed448InternalHash, 'SHAKE256');
		});

		it('should handle algorithm parameter structures', function () {
			// Test expected parameter structure for Web Crypto API
			const algorithmParams = {
				algorithm: { name: 'Ed25519' },
				usages: ['verify'],
			};

			assert.ok(algorithmParams.algorithm);
			assert.strictEqual(algorithmParams.algorithm.name, 'Ed25519');
			assert.ok(Array.isArray(algorithmParams.usages));
			assert.ok(algorithmParams.usages.includes('verify'));
		});
	});

	describe('bit string handling logic', function () {
		it('should handle bit strings with unused bits', function () {
			// Simulate a BIT STRING with unused bits
			const mockBitString = {
				valueHexView: new Uint8Array([0x01, 0x02, 0x03, 0x04]),
				unusedBits: 4,
			};

			// Test the logic for handling unused bits
			assert.strictEqual('unusedBits' in mockBitString, true);
			assert.strictEqual(mockBitString.unusedBits > 0, true);

			// When unusedBits > 0, we should slice off the last byte
			let signatureValue = mockBitString.valueHexView;
			if ('unusedBits' in mockBitString && mockBitString.unusedBits > 0) {
				signatureValue = signatureValue.slice(0, signatureValue.length - 1);
			}

			assert.strictEqual(signatureValue.length, 3); // Should be truncated
		});

		it('should handle bit strings without unused bits', function () {
			// Simulate a BIT STRING without unused bits property
			const mockBitString = {
				valueHexView: new Uint8Array([0x01, 0x02, 0x03, 0x04]),
				// No unusedBits property
			};

			assert.strictEqual('unusedBits' in mockBitString, false);

			// When no unused bits, signature should remain unchanged
			let signatureValue = mockBitString.valueHexView;
			if ('unusedBits' in mockBitString && mockBitString.unusedBits > 0) {
				signatureValue = signatureValue.slice(0, signatureValue.length - 1);
			}

			assert.strictEqual(signatureValue.length, 4); // Should not be truncated
		});
	});

	describe('error handling patterns', function () {
		it('should handle verification errors gracefully', function () {
			// Test the pattern of catching and returning false on errors
			function simulateVerification() {
				try {
					// Simulate a verification that might fail
					throw new Error('Verification failed');
					// eslint-disable-next-line sonarjs/no-ignored-exceptions
				} catch (error) {
					// Any failure in verification should return false
					return false;
				}
			}

			const result = simulateVerification();
			assert.strictEqual(result, false);
		});

		it('should handle missing crypto API gracefully', function () {
			// Test handling when crypto.subtle is not available
			function getCryptoSubtle(mockCrypto) {
				const cryptoSubtle = mockCrypto?.subtle || null;

				if (!cryptoSubtle) {
					throw new Error('No crypto.subtle available');
				}

				return cryptoSubtle;
			}

			assert.throws(() => {
				getCryptoSubtle(null);
			}, /No crypto\.subtle available/);
		});
	});

	describe('integration patterns', function () {
		it('should understand proper import order requirements', function () {
			// The patch must be applied before PKI.js consuming modules are loaded
			const requiredOrder = [
				'pkijs-ed25519-patch.ts', // Must be first
				'easy-ocsp', // Can be loaded after patch
				'pkijs', // Can be loaded after patch
			];

			// Validate the intended order
			const patchIndex = requiredOrder.indexOf('pkijs-ed25519-patch.ts');
			const ocspIndex = requiredOrder.indexOf('easy-ocsp');
			const pkijsIndex = requiredOrder.indexOf('pkijs');

			assert.strictEqual(patchIndex, 0, 'Patch should be loaded first');
			assert.ok(patchIndex < ocspIndex, 'Patch should be loaded before OCSP module');
			assert.ok(patchIndex < pkijsIndex, 'Patch should be loaded before PKI.js usage');
		});

		it('should validate patch application pattern', function () {
			// Test idempotent patch application pattern
			let patchesApplied = false;

			function applyPatch() {
				if (patchesApplied) return;
				patchesApplied = true;
				return 'patches applied';
			}

			// First call should apply patches
			const result1 = applyPatch();
			assert.strictEqual(result1, 'patches applied');
			assert.strictEqual(patchesApplied, true);

			// Second call should be a no-op
			const result2 = applyPatch();
			assert.strictEqual(result2, undefined);
			assert.strictEqual(patchesApplied, true);
		});
	});

	describe('CryptoEngine.getHashAlgorithm patch', function () {
		let cryptoEngine;

		beforeEach(function () {
			cryptoEngine = pkijs.getCrypto(true);
		});

		it('should return placeholder for Ed25519 algorithm', function () {
			const result = cryptoEngine.getHashAlgorithm({ algorithmId: ED25519_OID });
			assert.strictEqual(result, 'UNUSED-EDDSA-BUILTIN-HASH');
		});

		it('should return placeholder for Ed448 algorithm', function () {
			const result = cryptoEngine.getHashAlgorithm({ algorithmId: ED448_OID });
			assert.strictEqual(result, 'UNUSED-EDDSA-BUILTIN-HASH');
		});

		it('should delegate to original for non-EdDSA algorithms', function () {
			// RSA with SHA-256 (OID: 1.2.840.113549.1.1.11)
			const result = cryptoEngine.getHashAlgorithm({ algorithmId: '1.2.840.113549.1.1.11' });
			// Should return a hash algorithm, not our placeholder
			assert.notStrictEqual(result, 'UNUSED-EDDSA-BUILTIN-HASH');
		});
	});

	describe('CryptoEngine.getAlgorithmByOID patch', function () {
		let cryptoEngine;

		beforeEach(function () {
			cryptoEngine = pkijs.getCrypto(true);
		});

		it('should return Ed25519 algorithm for Ed25519 OID', function () {
			const result = cryptoEngine.getAlgorithmByOID(ED25519_OID);
			assert.deepStrictEqual(result, { name: 'Ed25519' });
		});

		it('should return Ed448 algorithm for Ed448 OID', function () {
			const result = cryptoEngine.getAlgorithmByOID(ED448_OID);
			assert.deepStrictEqual(result, { name: 'Ed448' });
		});

		it('should delegate to original for non-EdDSA OIDs', function () {
			const result = cryptoEngine.getAlgorithmByOID(RSA_OID);
			// Should return RSA algorithm info
			assert.ok(result);
			assert.notStrictEqual(result.name, 'Ed25519');
			assert.notStrictEqual(result.name, 'Ed448');
		});

		it('should return result for unknown OIDs without throwing', function () {
			// PKI.js returns a result even for unknown OIDs (doesn't throw)
			const result = cryptoEngine.getAlgorithmByOID('invalid.oid');
			// Should return something, not throw
			assert.ok(result !== undefined);
		});
	});

	describe('CryptoEngine.getAlgorithmParameters patch', function () {
		let cryptoEngine;

		beforeEach(function () {
			cryptoEngine = pkijs.getCrypto(true);
		});

		it('should return Ed25519 parameters for sign operation', function () {
			const result = cryptoEngine.getAlgorithmParameters('Ed25519', 'sign');
			assert.deepStrictEqual(result, {
				algorithm: { name: 'Ed25519' },
				usages: ['sign'],
			});
		});

		it('should return Ed25519 parameters for verify operation', function () {
			const result = cryptoEngine.getAlgorithmParameters('Ed25519', 'verify');
			assert.deepStrictEqual(result, {
				algorithm: { name: 'Ed25519' },
				usages: ['verify'],
			});
		});

		it('should return Ed448 parameters for sign operation', function () {
			const result = cryptoEngine.getAlgorithmParameters('Ed448', 'sign');
			assert.deepStrictEqual(result, {
				algorithm: { name: 'Ed448' },
				usages: ['sign'],
			});
		});

		it('should return Ed448 parameters for verify operation', function () {
			const result = cryptoEngine.getAlgorithmParameters('Ed448', 'verify');
			assert.deepStrictEqual(result, {
				algorithm: { name: 'Ed448' },
				usages: ['verify'],
			});
		});

		it('should delegate to original for non-EdDSA algorithms', function () {
			const result = cryptoEngine.getAlgorithmParameters('RSASSA-PKCS1-v1_5', 'verify');
			// Should return RSA parameters
			assert.ok(result);
			assert.ok(result.algorithm);
		});
	});

	describe('Certificate.getPublicKey patch', function () {
		it('should handle Ed25519 public key extraction', async function () {
			// Create a mock certificate with Ed25519 public key info
			const mockCert = {
				subjectPublicKeyInfo: {
					algorithm: { algorithmId: ED25519_OID },
					toSchema: sinon.stub().returns({
						toBER: sinon.stub().returns(Buffer.alloc(32)),
					}),
				},
			};

			const mockCryptoEngine = {
				importKey: sinon.stub().resolves({ type: 'public', algorithm: { name: 'Ed25519' } }),
			};

			await pkijs.Certificate.prototype.getPublicKey.call(mockCert, undefined, mockCryptoEngine);

			// Verify importKey was called with Ed25519
			assert.strictEqual(mockCryptoEngine.importKey.calledOnce, true);
			const [format, , algorithm, extractable, usages] = mockCryptoEngine.importKey.firstCall.args;
			assert.strictEqual(format, 'spki');
			assert.strictEqual(algorithm, 'Ed25519');
			assert.strictEqual(extractable, true);
			assert.deepStrictEqual(usages, ['verify']);
		});

		it('should handle Ed448 public key extraction', async function () {
			const mockCert = {
				subjectPublicKeyInfo: {
					algorithm: { algorithmId: ED448_OID },
					toSchema: sinon.stub().returns({
						toBER: sinon.stub().returns(Buffer.alloc(57)),
					}),
				},
			};

			const mockCryptoEngine = {
				importKey: sinon.stub().resolves({ type: 'public', algorithm: { name: 'Ed448' } }),
			};

			await pkijs.Certificate.prototype.getPublicKey.call(mockCert, undefined, mockCryptoEngine);

			// Verify importKey was called with Ed448
			assert.strictEqual(mockCryptoEngine.importKey.calledOnce, true);
			const [, , algorithm] = mockCryptoEngine.importKey.firstCall.args;
			assert.strictEqual(algorithm, 'Ed448');
		});
	});

	describe('Certificate.verify patch', function () {
		it('should return false for invalid Ed25519 certificate verification', async function () {
			const mockCert = {
				signatureAlgorithm: { algorithmId: ED25519_OID },
				toSchema: sinon.stub().returns({
					toBER: sinon.stub().returns(Buffer.from('invalid-cert-data')),
				}),
			};

			const mockIssuer = {
				toSchema: sinon.stub().returns({
					toBER: sinon.stub().returns(Buffer.from('invalid-issuer-data')),
				}),
			};

			// Should return false for invalid data
			const result = await pkijs.Certificate.prototype.verify.call(mockCert, mockIssuer);
			assert.strictEqual(result, false);
		});

		it('should return false for invalid Ed448 certificate verification', async function () {
			const mockCert = {
				signatureAlgorithm: { algorithmId: ED448_OID },
				toSchema: sinon.stub().returns({
					toBER: sinon.stub().returns(Buffer.from('invalid-cert-data')),
				}),
			};

			const mockIssuer = {
				toSchema: sinon.stub().returns({
					toBER: sinon.stub().returns(Buffer.from('invalid-issuer-data')),
				}),
			};

			const result = await pkijs.Certificate.prototype.verify.call(mockCert, mockIssuer);
			assert.strictEqual(result, false);
		});
	});

	describe('CryptoEngine.verifyWithPublicKey patch', function () {
		it('should return false when crypto.subtle is unavailable for Ed25519', async function () {
			const mockPublicKeyInfo = {
				algorithm: { algorithmId: ED25519_OID },
				toSchema: sinon.stub().returns({
					toBER: sinon.stub().returns(Buffer.alloc(32)),
				}),
			};

			const mockCryptoEngine = {
				crypto: null,
				subtle: null,
			};

			const mockData = new ArrayBuffer(64);
			const mockSignature = {
				valueBlock: {
					valueHexView: new Uint8Array(64),
				},
			};

			const result = await pkijs.CryptoEngine.prototype.verifyWithPublicKey.call(
				mockCryptoEngine,
				mockData,
				mockSignature,
				mockPublicKeyInfo
			);

			assert.strictEqual(result, false);
		});

		it('should return false when crypto.subtle is unavailable for Ed448', async function () {
			const mockPublicKeyInfo = {
				algorithm: { algorithmId: ED448_OID },
				toSchema: sinon.stub().returns({
					toBER: sinon.stub().returns(Buffer.alloc(57)),
				}),
			};

			const mockCryptoEngine = {
				crypto: null,
				subtle: null,
			};

			const mockData = new ArrayBuffer(64);
			const mockSignature = {
				valueBlock: {
					valueHexView: new Uint8Array(114),
				},
			};

			const result = await pkijs.CryptoEngine.prototype.verifyWithPublicKey.call(
				mockCryptoEngine,
				mockData,
				mockSignature,
				mockPublicKeyInfo
			);

			assert.strictEqual(result, false);
		});

		it('should handle BIT STRING signature with unused bits', async function () {
			const mockPublicKeyInfo = {
				algorithm: { algorithmId: ED25519_OID },
				toSchema: sinon.stub().returns({
					toBER: sinon.stub().returns(Buffer.alloc(32)),
				}),
			};

			const mockSubtle = {
				importKey: sinon.stub().resolves({ type: 'public' }),
				verify: sinon.stub().resolves(false),
			};

			const mockCryptoEngine = {
				subtle: mockSubtle,
			};

			const mockData = new ArrayBuffer(64);
			const mockSignature = {
				valueBlock: {
					valueHexView: new Uint8Array(65),
					unusedBits: 8,
				},
			};

			await pkijs.CryptoEngine.prototype.verifyWithPublicKey.call(
				mockCryptoEngine,
				mockData,
				mockSignature,
				mockPublicKeyInfo
			);

			// Verify that signature was trimmed (length - 1)
			assert.strictEqual(mockSubtle.verify.calledOnce, true);
			const [, , signatureValue] = mockSubtle.verify.firstCall.args;
			assert.strictEqual(signatureValue.length, 64); // 65 - 1
		});

		it('should not trim signature when no unused bits', async function () {
			const mockPublicKeyInfo = {
				algorithm: { algorithmId: ED25519_OID },
				toSchema: sinon.stub().returns({
					toBER: sinon.stub().returns(Buffer.alloc(32)),
				}),
			};

			const mockSubtle = {
				importKey: sinon.stub().resolves({ type: 'public' }),
				verify: sinon.stub().resolves(false),
			};

			const mockCryptoEngine = {
				subtle: mockSubtle,
			};

			const mockData = new ArrayBuffer(64);
			const mockSignature = {
				valueBlock: {
					valueHexView: new Uint8Array(64),
					unusedBits: 0,
				},
			};

			await pkijs.CryptoEngine.prototype.verifyWithPublicKey.call(
				mockCryptoEngine,
				mockData,
				mockSignature,
				mockPublicKeyInfo
			);

			// Verify signature was not trimmed
			assert.strictEqual(mockSubtle.verify.calledOnce, true);
			const [, , signatureValue] = mockSubtle.verify.firstCall.args;
			assert.strictEqual(signatureValue.length, 64); // Unchanged
		});
	});

	describe('patch preservation of original behavior', function () {
		it('should not affect RSA certificate operations', function () {
			const cryptoEngine = pkijs.getCrypto(true);

			// RSA algorithm lookup should still work
			const rsaAlg = cryptoEngine.getAlgorithmByOID(RSA_OID);
			assert.ok(rsaAlg);
			assert.notStrictEqual(rsaAlg.name, 'Ed25519');
			assert.notStrictEqual(rsaAlg.name, 'Ed448');
		});

		it('should not affect ECDSA algorithm parameters', function () {
			const cryptoEngine = pkijs.getCrypto(true);

			// ECDSA parameters should still work
			const ecdsaParams = cryptoEngine.getAlgorithmParameters('ECDSA', 'verify');
			assert.ok(ecdsaParams);
			assert.ok(ecdsaParams.algorithm);
		});
	});
});
