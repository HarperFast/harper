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
const ED25519_OID = '1.3.101.112'; // eslint-disable-line sonarjs/no-hardcoded-ip
const ED448_OID = '1.3.101.113'; // eslint-disable-line sonarjs/no-hardcoded-ip

// Apply patches only once
let patchesApplied = false;

function isEd25519OrEd448(oid: string): boolean {
	return oid === ED25519_OID || oid === ED448_OID;
}

function getAlgorithmName(oid: string): 'Ed25519' | 'Ed448' {
	return oid === ED25519_OID ? 'Ed25519' : 'Ed448';
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
	CryptoEngine.getHashAlgorithm = function (signatureAlgorithm: pkijs.AlgorithmIdentifier): string {
		if (isEd25519OrEd448(signatureAlgorithm.algorithmId)) {
			return 'SHA-256'; // Dummy value, not used for Ed25519/Ed448
		}
		return originals.getHashAlgorithm.call(this, signatureAlgorithm);
	};

	// Patch getAlgorithmByOID to recognize Ed25519/Ed448
	CryptoEngine.getAlgorithmByOID = function (oid: string, safety = false): any {
		if (isEd25519OrEd448(oid)) {
			return { name: getAlgorithmName(oid) };
		}
		return originals.getAlgorithmByOID.call(this, oid, safety);
	};

	// Patch getAlgorithmParameters
	CryptoEngine.getAlgorithmParameters = function (
		algorithmName: string,
		operation: string
	): pkijs.CryptoEngineAlgorithmParams {
		if (algorithmName === 'Ed25519' || algorithmName === 'Ed448') {
			return {
				algorithm: { name: algorithmName } as Algorithm,
				usages: operation === 'sign' ? ['sign'] : ['verify'],
			};
		}
		return originals.getAlgorithmParameters.call(this, algorithmName, operation);
	};

	// Patch getPublicKey for Ed25519/Ed448
	Certificate.getPublicKey = async function (
		parameters?: pkijs.CryptoEnginePublicKeyParams,
		cryptoEngine = pkijs.getCrypto(true)
	): Promise<CryptoKey> {
		const algId = this.subjectPublicKeyInfo.algorithm.algorithmId;
		if (isEd25519OrEd448(algId)) {
			const algorithmName = getAlgorithmName(algId);
			return await cryptoEngine.importKey(
				'spki',
				this.subjectPublicKeyInfo.toSchema().toBER(false),
				algorithmName,
				true,
				['verify']
			);
		}
		return originals.getPublicKey.call(this, parameters, cryptoEngine);
	};

	// Patch Certificate.verify for Ed25519/Ed448
	Certificate.verify = async function (
		issuerCertificate: pkijs.Certificate,
		cryptoEngine = pkijs.getCrypto(true)
	): Promise<boolean> {
		if (isEd25519OrEd448(this.signatureAlgorithm.algorithmId)) {
			try {
				// Use Node.js X509Certificate for Ed25519/Ed448 verification
				const certDer = this.toSchema().toBER(false);
				const issuerDer = issuerCertificate.toSchema().toBER(false);

				const nodeCert = new X509Certificate(Buffer.from(certDer));
				const nodeIssuer = new X509Certificate(Buffer.from(issuerDer));

				return nodeCert.verify(nodeIssuer.publicKey);
			} catch (error) {
				if (process.env.NODE_ENV !== 'production') {
					console.error('Ed25519 certificate verification error:', (error as Error).message);
				}
				return false;
			}
		}
		return originals.certificateVerify.call(this, issuerCertificate, cryptoEngine);
	};

	// Patch verifyWithPublicKey for OCSP response verification
	if (originals.verifyWithPublicKey) {
		CryptoEngine.verifyWithPublicKey = async function (
			data: BufferSource,
			signature: any, // pkijs.BitString
			publicKeyInfo: pkijs.PublicKeyInfo,
			signatureAlgorithm: pkijs.AlgorithmIdentifier,
			shaAlgorithm?: string
		): Promise<boolean> {
			const algId = publicKeyInfo.algorithm.algorithmId;
			if (isEd25519OrEd448(algId)) {
				const algorithmName = getAlgorithmName(algId);

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
				} catch (error) {
					if (process.env.NODE_ENV !== 'production') {
						console.error('Ed25519 verifyWithPublicKey error:', (error as Error).message);
					}
					return false;
				}
			}
			return originals.verifyWithPublicKey.call(this, data, signature, publicKeyInfo, signatureAlgorithm, shaAlgorithm);
		};
	}
}

// Apply patch on module load
applyEd25519Patch();
