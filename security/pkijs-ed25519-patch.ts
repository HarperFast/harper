/**
 * PKI.js Ed25519/Ed448 Support Patch
 *
 * This module patches PKI.js to add complete Ed25519/Ed448 support for certificate
 * and OCSP response verification. While PKI.js has some Ed25519/Ed448 support,
 * it currently lacks:
 * - getHashAlgorithm() support for Ed25519/Ed448 OIDs
 * - getAlgorithmByOID() recognition of Ed25519/Ed448
 * - Certificate verification using Ed25519/Ed448 signatures
 * - OCSP response signature verification with Ed25519/Ed448
 *
 * This patch must be loaded before any module that uses PKI.js (including easy-ocsp).
 */

import * as pkijs from 'pkijs';
import { webcrypto, X509Certificate } from 'node:crypto';


// Ed25519/Ed448 OIDs (these are standardized object identifiers, not IP addresses)
const ED25519_OID = '1.3.101.112' as const; // eslint-disable-line sonarjs/no-hardcoded-ip
const ED448_OID = '1.3.101.113' as const; // eslint-disable-line sonarjs/no-hardcoded-ip
type EdDSAOID = typeof ED25519_OID | typeof ED448_OID;

// Algorithm names as constants
const ED25519_NAME = 'Ed25519' as const;
const ED448_NAME = 'Ed448' as const;
type EdDSAAlgorithmName = typeof ED25519_NAME | typeof ED448_NAME;

// Apply patches only once
let patchesApplied = false;

function isEd25519OrEd448(oid: string): oid is EdDSAOID {
	return oid === ED25519_OID || oid === ED448_OID;
}

function isEdDSAAlgorithmName(name: string): name is EdDSAAlgorithmName {
	return name === ED25519_NAME || name === ED448_NAME;
}

function getEdDSAAlgorithmName(oid: string): EdDSAAlgorithmName {
	return oid === ED25519_OID ? ED25519_NAME : ED448_NAME;
}

export function applyEd25519Patch(): void {
	if (patchesApplied) return;
	patchesApplied = true;

	const CryptoEngine = pkijs.CryptoEngine.prototype;
	const Certificate = pkijs.Certificate.prototype;

	// Store original methods
	const originals = {
		getHashAlgorithm: CryptoEngine.getHashAlgorithm,
		getAlgorithmByOID: CryptoEngine.getAlgorithmByOID,
		getAlgorithmParameters: CryptoEngine.getAlgorithmParameters,
		verifyWithPublicKey: CryptoEngine.verifyWithPublicKey,
		certificateVerify: Certificate.verify,
		getPublicKey: Certificate.getPublicKey,
	};

	// Patch getHashAlgorithm - Ed25519/Ed448 don't use separate hashes
	CryptoEngine.getHashAlgorithm = function (
		...params: Parameters<typeof originals.getHashAlgorithm>
	): ReturnType<typeof originals.getHashAlgorithm> {
		const [signatureAlgorithm] = params;
		if (isEd25519OrEd448(signatureAlgorithm.algorithmId)) {
			// EdDSA signatures have built-in hash functions per RFC 8032:
			// - Ed25519 uses SHA-512 internally (Section 5.1.6)
			// - Ed448 uses SHAKE256 internally (Section 5.2.6)
			// The hash is not a parameter - it's part of the algorithm definition.
			// Returning a placeholder since PKI.js expects a string, but our patched
			// verification methods bypass any code that would use this value.
			return 'UNUSED-EDDSA-BUILTIN-HASH';
		}
		return originals.getHashAlgorithm.call(this, signatureAlgorithm);
	};

	// Patch getAlgorithmByOID to recognize Ed25519/Ed448
	CryptoEngine.getAlgorithmByOID = function (
		...params: Parameters<typeof originals.getAlgorithmByOID>
	): ReturnType<typeof originals.getAlgorithmByOID> {
		const [oid] = params;
		if (isEd25519OrEd448(oid)) {
			return { name: getEdDSAAlgorithmName(oid) };
		}
		return originals.getAlgorithmByOID.call(this, ...params);
	};

	// Patch getAlgorithmParameters
	CryptoEngine.getAlgorithmParameters = function (
		...params: Parameters<typeof originals.getAlgorithmParameters>
	): ReturnType<typeof originals.getAlgorithmParameters> {
		const [algorithmName, operation] = params;
		if (isEdDSAAlgorithmName(algorithmName)) {
			return {
				algorithm: { name: algorithmName },
				usages: operation === 'sign' ? ['sign'] : ['verify'],
			};
		}
		return originals.getAlgorithmParameters.call(this, ...params);
	};

	// Patch getPublicKey for Ed25519/Ed448
	Certificate.getPublicKey = async function (
		...params: Parameters<typeof originals.getPublicKey>
	): ReturnType<typeof originals.getPublicKey> {
		const [, cryptoEngine = pkijs.getCrypto(true)] = params;
		const algId = this.subjectPublicKeyInfo.algorithm.algorithmId;
		if (isEd25519OrEd448(algId)) {
			const algorithmName = getEdDSAAlgorithmName(algId);
			return cryptoEngine.importKey('spki', this.subjectPublicKeyInfo.toSchema().toBER(false), algorithmName, true, [
				'verify',
			]);
		}
		return originals.getPublicKey.call(this, ...params);
	};

	// Patch Certificate.verify for Ed25519/Ed448
	Certificate.verify = async function (
		...params: Parameters<typeof originals.certificateVerify>
	): ReturnType<typeof originals.certificateVerify> {
		const [issuerCertificate] = params;
		if (isEd25519OrEd448(this.signatureAlgorithm.algorithmId)) {
			try {
				// Use Node.js X509Certificate for Ed25519/Ed448 verification
				const certDer = this.toSchema().toBER(false);
				const issuerDer = issuerCertificate.toSchema().toBER(false);

				const nodeCert = new X509Certificate(Buffer.from(certDer));
				const nodeIssuer = new X509Certificate(Buffer.from(issuerDer));

				return nodeCert.verify(nodeIssuer.publicKey);
				// eslint-disable-next-line sonarjs/no-ignored-exceptions
			} catch (error) {
				// Any failure in verification should return false
				return false;
			}
		}
		return originals.certificateVerify.call(this, ...params);
	};

	// Patch verifyWithPublicKey for OCSP response verification
	if (originals.verifyWithPublicKey) {
		CryptoEngine.verifyWithPublicKey = async function (
			...params: Parameters<typeof originals.verifyWithPublicKey>
		): ReturnType<typeof originals.verifyWithPublicKey> {
			const [data, signature, publicKeyInfo] = params;
			const algId = publicKeyInfo.algorithm.algorithmId;
			if (isEd25519OrEd448(algId)) {
				const algorithmName = getEdDSAAlgorithmName(algId);

				try {
					// Get crypto.subtle from available sources
					const cryptoSubtle =
						(this as any).crypto?.subtle || (this as any).subtle || pkijs.getCrypto(true)?.subtle || webcrypto?.subtle;

					if (!cryptoSubtle) {
						throw new Error('No crypto.subtle available');
					}

					// Import the public key
					const publicKey = await cryptoSubtle.importKey(
						'spki',
						publicKeyInfo.toSchema().toBER(false),
						algorithmName,
						false,
						['verify']
					);

					// Handle BIT STRING signature value
					let signatureValue = signature.valueBlock.valueHexView;
					if (signature.valueBlock.unusedBits > 0) {
						signatureValue = signatureValue.slice(0, signatureValue.length - 1);
					}

					// Verify the signature
					return await cryptoSubtle.verify(algorithmName, publicKey, signatureValue, data);
					// eslint-disable-next-line sonarjs/no-ignored-exceptions
				} catch (error) {
					// Any failure in verification should return false
					return false;
				}
			}
			return originals.verifyWithPublicKey.call(this, ...params);
		};
	}
}

// Apply patch on module load
applyEd25519Patch();
