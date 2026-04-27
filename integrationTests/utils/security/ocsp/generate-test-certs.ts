/**
 * Generate test certificates for OCSP integration testing
 *
 * Uses pure Node.js (webcrypto + pkijs) — no openssl CLI dependency.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as pkijs from 'pkijs';
import {
	generateEd25519KeyPair,
	createCertificate,
	makeOCSPAIAExt,
	makeExtKeyUsageExt,
	certToPem,
	OCSP_SIGNING_OID,
	CLIENT_AUTH_OID,
	type Ed25519KeyPair,
} from '../certGenUtils.js';

export interface OcspCertificates {
	/** Path to CA certificate */
	ca: string;
	/** Valid client certificate paths */
	valid: {
		/** Path to valid client certificate chain (cert + CA) */
		cert: string;
		/** Path to valid client private key */
		key: string;
	};
	/** Revoked client certificate paths */
	revoked: {
		/** Path to revoked client certificate chain (cert + CA) */
		cert: string;
		/** Path to revoked client private key */
		key: string;
	};
	/** OCSP responder certificate paths */
	ocsp: {
		/** Path to OCSP responder certificate */
		cert: string;
		/** Path to OCSP responder private key */
		key: string;
	};
}

/** In-memory cert data needed by the OCSP server */
export interface OcspServerCerts {
	caCert: pkijs.Certificate;
	ocspKeyPair: Ed25519KeyPair;
	ocspCert: pkijs.Certificate;
	/** Maps decimal serial number string → status */
	statusMap: Map<string, 'good' | 'revoked'>;
}

/**
 * Generate OCSP test certificates using pure Node.js (no openssl CLI).
 *
 * Serial numbers:
 *   1 = CA
 *   2 = OCSP responder
 *   3 = valid client
 *   4 = revoked client
 *
 * Returns both file paths (for test code) and in-memory objects (for OCSP server).
 */
export async function generateOcspCertificates(
	outputDir: string,
	ocspHost: string,
	ocspPort: number
): Promise<{ files: OcspCertificates; serverCerts: OcspServerCerts }> {
	const ocspUrl = `http://${ocspHost}:${ocspPort}`;

	// --- CA ---
	const caKey = await generateEd25519KeyPair();
	const caKeyPath = path.join(outputDir, 'harper-ca.key');
	fs.writeFileSync(caKeyPath, caKey.privateKeyPem);

	const caCert = await createCertificate({
		serialNumber: 1,
		subject: { CN: 'Harper Test CA', O: 'Harper OCSP Test' },
		issuer: { CN: 'Harper Test CA', O: 'Harper OCSP Test' },
		validDays: 365,
		issuerKey: caKey.privateKey,
		subjectPublicKey: caKey.publicKey,
		isCA: true,
	});
	const caCertPath = path.join(outputDir, 'harper-ca.crt');
	fs.writeFileSync(caCertPath, certToPem(caCert));

	// --- OCSP responder cert ---
	const ocspKey = await generateEd25519KeyPair();
	const ocspKeyPath = path.join(outputDir, 'ocsp.key');
	fs.writeFileSync(ocspKeyPath, ocspKey.privateKeyPem);

	const ocspCert = await createCertificate({
		serialNumber: 2,
		subject: { CN: 'OCSP Responder', O: 'Harper OCSP Test' },
		issuer: { CN: 'Harper Test CA', O: 'Harper OCSP Test' },
		validDays: 365,
		issuerKey: caKey.privateKey,
		subjectPublicKey: ocspKey.publicKey,
		extensions: [makeExtKeyUsageExt([OCSP_SIGNING_OID])],
	});
	const ocspCertPath = path.join(outputDir, 'ocsp.crt');
	fs.writeFileSync(ocspCertPath, certToPem(ocspCert));

	// --- Valid client cert ---
	const validKey = await generateEd25519KeyPair();
	const validKeyPath = path.join(outputDir, 'client-valid.key');
	fs.writeFileSync(validKeyPath, validKey.privateKeyPem);

	const validCert = await createCertificate({
		serialNumber: 3,
		subject: { CN: 'Valid Client', O: 'Harper OCSP Test' },
		issuer: { CN: 'Harper Test CA', O: 'Harper OCSP Test' },
		validDays: 365,
		issuerKey: caKey.privateKey,
		subjectPublicKey: validKey.publicKey,
		extensions: [makeOCSPAIAExt(ocspUrl), makeExtKeyUsageExt([CLIENT_AUTH_OID])],
	});
	const validCertPath = path.join(outputDir, 'client-valid.crt');
	fs.writeFileSync(validCertPath, certToPem(validCert));

	const validChainPath = path.join(outputDir, 'client-valid-chain.crt');
	fs.writeFileSync(validChainPath, certToPem(validCert) + certToPem(caCert));

	// --- Revoked client cert ---
	const revokedKey = await generateEd25519KeyPair();
	const revokedKeyPath = path.join(outputDir, 'client-revoked.key');
	fs.writeFileSync(revokedKeyPath, revokedKey.privateKeyPem);

	const revokedCert = await createCertificate({
		serialNumber: 4,
		subject: { CN: 'Revoked Client', O: 'Harper OCSP Test' },
		issuer: { CN: 'Harper Test CA', O: 'Harper OCSP Test' },
		validDays: 365,
		issuerKey: caKey.privateKey,
		subjectPublicKey: revokedKey.publicKey,
		extensions: [makeOCSPAIAExt(ocspUrl), makeExtKeyUsageExt([CLIENT_AUTH_OID])],
	});
	const revokedCertPath = path.join(outputDir, 'client-revoked.crt');
	fs.writeFileSync(revokedCertPath, certToPem(revokedCert));

	const revokedChainPath = path.join(outputDir, 'client-revoked-chain.crt');
	fs.writeFileSync(revokedChainPath, certToPem(revokedCert) + certToPem(caCert));

	const statusMap = new Map<string, 'good' | 'revoked'>([
		['3', 'good'], // valid client serial
		['4', 'revoked'], // revoked client serial
	]);

	return {
		files: {
			ca: caCertPath,
			valid: { cert: validChainPath, key: validKeyPath },
			revoked: { cert: revokedChainPath, key: revokedKeyPath },
			ocsp: { cert: ocspCertPath, key: ocspKeyPath },
		},
		serverCerts: {
			caCert,
			ocspKeyPair: ocspKey,
			ocspCert,
			statusMap,
		},
	};
}
