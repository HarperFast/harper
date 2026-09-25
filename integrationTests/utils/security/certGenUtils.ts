/**
 * Pure Node.js X.509 certificate and CRL generation utilities
 *
 * Uses Node.js built-in webcrypto (Ed25519) + pkijs for ASN.1 encoding.
 * No openssl CLI dependency — fully portable across macOS and Linux.
 */

import { webcrypto } from 'node:crypto';
import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';

// Ed25519 OID (RFC 8410)
const ED25519_OID = '1.3.101.112';

// Standard extension OIDs
const BASIC_CONSTRAINTS_OID = '2.5.29.19';
const CRL_DISTRIBUTION_POINTS_OID = '2.5.29.31';
const AUTHORITY_INFO_ACCESS_OID = '1.3.6.1.5.5.7.1.1';
const EXT_KEY_USAGE_OID = '2.5.29.37';
const OCSP_SIGNING_OID = '1.3.6.1.5.5.7.3.9';
const CLIENT_AUTH_OID = '1.3.6.1.5.5.7.3.2';
const OCSP_ACCESS_METHOD_OID = '1.3.6.1.5.5.7.48.1';

// Configure pkijs to use Node.js webcrypto
pkijs.setEngine('node', new pkijs.CryptoEngine({ name: 'node', crypto: webcrypto as any }));

export interface Ed25519KeyPair {
	privateKey: CryptoKey;
	publicKey: CryptoKey;
	/** PKCS8 PEM string */
	privateKeyPem: string;
}

export async function generateEd25519KeyPair(): Promise<Ed25519KeyPair> {
	// Ed25519 is supported at runtime (Node 20+) but @types/node lacks dedicated types for it
	const keyPair = (await webcrypto.subtle.generateKey({ name: 'Ed25519' } as Algorithm, true, [
		'sign',
		'verify',
	])) as CryptoKeyPair;

	const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keyPair.privateKey);
	const b64 = Buffer.from(pkcs8).toString('base64');
	const lines = b64.match(/.{1,64}/g)!.join('\n');
	const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`;

	return { privateKey: keyPair.privateKey, publicKey: keyPair.publicKey, privateKeyPem };
}

/**
 * Sign a pkijs Certificate or CertificateRevocationList with an Ed25519 key.
 * Bypasses pkijs's sign() method which does not support Ed25519.
 */
async function signWithEd25519(obj: any, privateKey: CryptoKey): Promise<void> {
	const algId = new pkijs.AlgorithmIdentifier({ algorithmId: ED25519_OID });
	obj.signature = algId;
	obj.signatureAlgorithm = algId;

	const tbsBer = obj.encodeTBS().toBER();
	obj.tbsView = new Uint8Array(tbsBer);

	const sig = await webcrypto.subtle.sign('Ed25519', privateKey, tbsBer);
	obj.signatureValue = new asn1js.BitString({ valueHex: sig });
}

/** Convert a pkijs Certificate to PEM string */
export function certToPem(cert: pkijs.Certificate): string {
	const der = cert.toSchema(false).toBER();
	const b64 = Buffer.from(der).toString('base64');
	return `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/** Convert a pkijs CertificateRevocationList to PEM string */
export function crlToPem(crl: pkijs.CertificateRevocationList): string {
	const der = crl.toSchema(false).toBER();
	const b64 = Buffer.from(der).toString('base64');
	return `-----BEGIN X509 CRL-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END X509 CRL-----\n`;
}

interface CertOptions {
	serialNumber: number;
	subject: { CN: string; O?: string };
	issuer: { CN: string; O?: string };
	validDays: number;
	issuerKey: CryptoKey;
	subjectPublicKey: CryptoKey;
	isCA?: boolean;
	extensions?: pkijs.Extension[];
}

/** Create a signed Ed25519 X.509 v3 certificate */
export async function createCertificate(opts: CertOptions): Promise<pkijs.Certificate> {
	const cert = new pkijs.Certificate();
	cert.version = 2; // v3

	cert.serialNumber = new asn1js.Integer({ value: opts.serialNumber });

	const now = new Date();
	cert.notBefore.value = now;
	cert.notAfter.value = new Date(now.getTime() + opts.validDays * 24 * 60 * 60 * 1000);

	// Build subject RDN
	const buildRDN = (dn: { CN: string; O?: string }, target: pkijs.RelativeDistinguishedNames) => {
		target.typesAndValues.push(
			new pkijs.AttributeTypeAndValue({
				type: '2.5.4.3',
				value: new asn1js.Utf8String({ value: dn.CN }),
			})
		);
		if (dn.O) {
			target.typesAndValues.push(
				new pkijs.AttributeTypeAndValue({
					type: '2.5.4.10',
					value: new asn1js.Utf8String({ value: dn.O }),
				})
			);
		}
	};

	buildRDN(opts.subject, cert.subject);
	buildRDN(opts.issuer, cert.issuer);

	// Import public key into SubjectPublicKeyInfo
	const spki = await webcrypto.subtle.exportKey('spki', opts.subjectPublicKey);
	const spkiAsn1 = asn1js.fromBER(spki);
	cert.subjectPublicKeyInfo.fromSchema(spkiAsn1.result);

	// Add basic constraints extension (always present)
	cert.extensions = [];
	const bc = new pkijs.BasicConstraints({ cA: opts.isCA === true });
	cert.extensions.push(
		new pkijs.Extension({
			extnID: BASIC_CONSTRAINTS_OID,
			critical: true,
			extnValue: bc.toSchema().toBER(),
		})
	);

	// Add caller-supplied extensions
	if (opts.extensions) {
		cert.extensions.push(...opts.extensions);
	}

	await signWithEd25519(cert, opts.issuerKey);
	return cert;
}

/** Create a CRL Distribution Points extension */
export function makeCRLDistributionPointsExt(url: string): pkijs.Extension {
	const dp = new pkijs.DistributionPoint({
		distributionPoint: [new pkijs.GeneralName({ type: 6, value: url })],
	});
	const cdp = new pkijs.CRLDistributionPoints({ distributionPoints: [dp] });
	return new pkijs.Extension({
		extnID: CRL_DISTRIBUTION_POINTS_OID,
		critical: false,
		extnValue: cdp.toSchema().toBER(),
	});
}

/** Create an Authority Info Access extension with an OCSP URL */
export function makeOCSPAIAExt(url: string): pkijs.Extension {
	const desc = new pkijs.AccessDescription({
		accessMethod: OCSP_ACCESS_METHOD_OID,
		accessLocation: new pkijs.GeneralName({ type: 6, value: url }),
	});
	const aia = new pkijs.InfoAccess({ accessDescriptions: [desc] });
	return new pkijs.Extension({
		extnID: AUTHORITY_INFO_ACCESS_OID,
		critical: false,
		extnValue: aia.toSchema().toBER(),
	});
}

/** Create an Extended Key Usage extension */
export function makeExtKeyUsageExt(oids: string[]): pkijs.Extension {
	const seq = new asn1js.Sequence({
		value: oids.map((oid) => new asn1js.ObjectIdentifier({ value: oid })),
	});
	return new pkijs.Extension({
		extnID: EXT_KEY_USAGE_OID,
		critical: false,
		extnValue: seq.toBER(),
	});
}

export { OCSP_SIGNING_OID, CLIENT_AUTH_OID };

export interface CrlValidity {
	thisUpdate: Date;
	nextUpdate: Date;
}

/** Create a signed X.509v2 CRL, current for 30 days unless `validity` says otherwise */
export async function createCRL(
	issuerCert: pkijs.Certificate,
	issuerKey: CryptoKey,
	revokedSerials: number[],
	validity?: CrlValidity
): Promise<pkijs.CertificateRevocationList> {
	const crl = new pkijs.CertificateRevocationList();
	crl.version = 1; // CRLv2 = version field value 1

	// Copy issuer from CA cert subject
	crl.issuer = issuerCert.subject;

	const now = validity?.thisUpdate ?? new Date();
	const next = validity?.nextUpdate ?? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
	crl.thisUpdate = new pkijs.Time({ type: 0, value: now });
	crl.nextUpdate = new pkijs.Time({ type: 0, value: next });

	if (revokedSerials.length > 0) {
		crl.revokedCertificates = revokedSerials.map(
			(serial) =>
				new pkijs.RevokedCertificate({
					userCertificate: new asn1js.Integer({ value: serial }),
					revocationDate: new pkijs.Time({ type: 0, value: now }),
				})
		);
	}

	await signWithEd25519(crl, issuerKey);
	return crl;
}

/**
 * Sign a pkijs BasicOCSPResponse with an Ed25519 key.
 * Must be called after tbsResponseData.responses is populated.
 */
export async function signBasicOCSPResponse(
	basicResponse: pkijs.BasicOCSPResponse,
	privateKey: CryptoKey
): Promise<void> {
	const algId = new pkijs.AlgorithmIdentifier({ algorithmId: ED25519_OID });
	basicResponse.signatureAlgorithm = algId;

	// Encode the TBS response data
	const tbsDer = basicResponse.tbsResponseData.toSchema(true).toBER();
	basicResponse.tbsResponseData.tbsView = new Uint8Array(tbsDer);

	const sig = await webcrypto.subtle.sign('Ed25519', privateKey, tbsDer);
	basicResponse.signature = new asn1js.BitString({ valueHex: sig });
}
