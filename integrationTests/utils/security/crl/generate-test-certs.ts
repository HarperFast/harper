/**
 * Generate test certificates for CRL integration testing
 *
 * Uses pure Node.js (webcrypto + pkijs) — no openssl CLI dependency.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
	generateEd25519KeyPair,
	createCertificate,
	createCRL,
	makeCRLDistributionPointsExt,
	certToPem,
	crlToPem,
	CLIENT_AUTH_OID,
	makeExtKeyUsageExt,
	type CrlValidity,
} from '../certGenUtils.ts';

export interface CrlCertificates {
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
	/** Path to Certificate Revocation List */
	crl: string;
	/** Further CRLs signed by the same CA, keyed by the file name given in `extraCrls`; served only once copied over `crl` */
	extraCrls?: Record<string, string>;
}

/**
 * Generate CRL test certificates using pure Node.js (no openssl CLI).
 *
 * Serial numbers:
 *   1 = CA
 *   2 = valid client
 *   3 = revoked client
 *
 * `extraCrls` writes more CRLs beside `test.crl` (file name -> revoked serials), e.g. one that also lists
 * serial 2, so a test can revoke the valid client by copying it over `test.crl`.
 */
export async function generateCrlCertificates(
	outputDir: string,
	crlHost: string,
	crlPort: number,
	crlValidity?: CrlValidity,
	extraCrls?: Record<string, number[]>
): Promise<CrlCertificates> {
	const crlUrl = `http://${crlHost}:${crlPort}/test.crl`;

	// --- CA ---
	const caKey = await generateEd25519KeyPair();
	const caKeyPath = path.join(outputDir, 'harper-ca.key');
	fs.writeFileSync(caKeyPath, caKey.privateKeyPem);

	const caCert = await createCertificate({
		serialNumber: 1,
		subject: { CN: 'Harper Test CA', O: 'Harper CRL Test' },
		issuer: { CN: 'Harper Test CA', O: 'Harper CRL Test' },
		validDays: 365,
		issuerKey: caKey.privateKey,
		subjectPublicKey: caKey.publicKey,
		isCA: true,
	});
	const caCertPath = path.join(outputDir, 'harper-ca.crt');
	fs.writeFileSync(caCertPath, certToPem(caCert));

	// --- Valid client cert ---
	const validKey = await generateEd25519KeyPair();
	const validKeyPath = path.join(outputDir, 'client-valid.key');
	fs.writeFileSync(validKeyPath, validKey.privateKeyPem);

	const validCert = await createCertificate({
		serialNumber: 2,
		subject: { CN: 'Valid CRL Client', O: 'Harper CRL Test' },
		issuer: { CN: 'Harper Test CA', O: 'Harper CRL Test' },
		validDays: 30,
		issuerKey: caKey.privateKey,
		subjectPublicKey: validKey.publicKey,
		extensions: [makeCRLDistributionPointsExt(crlUrl), makeExtKeyUsageExt([CLIENT_AUTH_OID])],
	});
	const validCertPath = path.join(outputDir, 'client-valid.crt');
	fs.writeFileSync(validCertPath, certToPem(validCert));

	// Build chain: client cert + CA cert
	const validChainPath = path.join(outputDir, 'client-valid-chain.crt');
	fs.writeFileSync(validChainPath, certToPem(validCert) + certToPem(caCert));

	// --- Revoked client cert ---
	const revokedKey = await generateEd25519KeyPair();
	const revokedKeyPath = path.join(outputDir, 'client-revoked.key');
	fs.writeFileSync(revokedKeyPath, revokedKey.privateKeyPem);

	const revokedCert = await createCertificate({
		serialNumber: 3,
		subject: { CN: 'Revoked CRL Client', O: 'Harper CRL Test' },
		issuer: { CN: 'Harper Test CA', O: 'Harper CRL Test' },
		validDays: 30,
		issuerKey: caKey.privateKey,
		subjectPublicKey: revokedKey.publicKey,
		extensions: [makeCRLDistributionPointsExt(crlUrl), makeExtKeyUsageExt([CLIENT_AUTH_OID])],
	});
	const revokedCertPath = path.join(outputDir, 'client-revoked.crt');
	fs.writeFileSync(revokedCertPath, certToPem(revokedCert));

	// Build chain: client cert + CA cert
	const revokedChainPath = path.join(outputDir, 'client-revoked-chain.crt');
	fs.writeFileSync(revokedChainPath, certToPem(revokedCert) + certToPem(caCert));

	// --- CRL (serial 3 = revoked) ---
	const crl = await createCRL(caCert, caKey.privateKey, [3], crlValidity);
	const crlPath = path.join(outputDir, 'test.crl');
	fs.writeFileSync(crlPath, crlToPem(crl));

	const result: CrlCertificates = {
		ca: caCertPath,
		valid: { cert: validChainPath, key: validKeyPath },
		revoked: { cert: revokedChainPath, key: revokedKeyPath },
		crl: crlPath,
	};
	if (extraCrls) {
		result.extraCrls = {};
		for (const [fileName, serials] of Object.entries(extraCrls)) {
			const extraPath = path.join(outputDir, fileName);
			fs.writeFileSync(extraPath, crlToPem(await createCRL(caCert, caKey.privateKey, serials, crlValidity)));
			result.extraCrls[fileName] = extraPath;
		}
	}
	return result;
}
