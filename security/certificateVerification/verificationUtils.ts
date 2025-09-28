/**
 * Shared utilities for certificate verification
 */

import { createHash } from 'node:crypto';
import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';
import { loggerWithTag } from '../../utility/logging/logger.js';
import { table } from '../../resources/databases.ts';
import type { PeerCertificate, CertificateChainEntry } from './types.ts';

const logger = loggerWithTag('cert-verification-utils');

/**
 * Convert a buffer to PEM format
 * @param buffer - Certificate data as buffer
 * @param type - Certificate type (e.g., 'CERTIFICATE')
 * @returns PEM formatted string
 */
export function bufferToPem(buffer: Buffer, type: string): string {
	const base64 = buffer.toString('base64');
	const lines = [`-----BEGIN ${type}-----`];

	// Split into 64-char lines
	for (let i = 0; i < base64.length; i += 64) {
		lines.push(base64.substring(i, i + 64));
	}

	lines.push(`-----END ${type}-----`);
	return lines.join('\n');
}

/**
 * Extract certificate chain from peer certificate object
 * @param peerCertificate - Peer certificate object from TLS connection
 * @returns Certificate chain with issuer relationships
 */
export function extractCertificateChain(peerCertificate: PeerCertificate): CertificateChainEntry[] {
	const chain: CertificateChainEntry[] = [];
	let current = peerCertificate;

	while (current?.raw) {
		const entry: CertificateChainEntry = { cert: current.raw };

		// Get issuer if available and different from self
		if (current.issuerCertificate && current.issuerCertificate !== current && current.issuerCertificate.raw) {
			entry.issuer = current.issuerCertificate.raw;
		}

		chain.push(entry);

		// Move to next in chain
		if (current.issuerCertificate && current.issuerCertificate !== current) {
			current = current.issuerCertificate;
		} else {
			break;
		}
	}

	return chain;
}

/**
 * Extract CRL Distribution Points from a certificate using PKI.js
 * @param certPem - Certificate in PEM format
 * @returns Array of CRL distribution point URLs
 */
export function extractCRLDistributionPoints(certPem: string): string[] {
	try {
		// Parse the certificate using PKI.js
		const certBuffer = pemToBuffer(certPem);
		const cert = pkijs.Certificate.fromBER(certBuffer);

		// Look for CRL Distribution Points extension (OID: 2.5.29.31)
		const crlDistExt = cert.extensions?.find((ext) => ext.extnID === '2.5.29.31');

		if (!crlDistExt) {
			logger.debug?.('Certificate has no CRL Distribution Points extension');
			return [];
		}

		// Parse the extension value
		// We need to decode the extension value first
		const asn1 = asn1js.fromBER(crlDistExt.extnValue.valueBlock.valueHexView);
		if (asn1.offset === -1) {
			throw new Error('Failed to parse ASN.1 structure in CRL Distribution Points extension');
		}

		const crlDistPoints = new pkijs.CRLDistributionPoints({
			schema: asn1.result,
		});

		const distributionPoints: string[] = [];

		// Extract distribution point URLs
		for (const distPoint of crlDistPoints.distributionPoints) {
			if (distPoint.distributionPoint && Array.isArray(distPoint.distributionPoint)) {
				// Handle the actual PKI.js structure where distributionPoint is an array
				for (const dp of distPoint.distributionPoint) {
					if (dp.type === 6 && typeof dp.value === 'string') {
						// uniformResourceIdentifier
						const url = dp.value;
						if (url.startsWith('http://') || url.startsWith('https://')) {
							distributionPoints.push(url);
						}
					}
				}
			}
		}

		logger.debug?.(`Found ${distributionPoints.length} CRL distribution points: ${distributionPoints}`);
		return distributionPoints;
	} catch (error) {
		logger.error?.(`Failed to extract CRL distribution points: ${error}`);
		return [];
	}
}

/**
 * Extract both CRL and OCSP URLs from a certificate in a single parse operation
 * @param certPem - Certificate in PEM format
 * @returns Object containing arrays of CRL and OCSP URLs
 */
export function extractRevocationUrls(certPem: string): { crlUrls: string[]; ocspUrls: string[] } {
	try {
		// Parse the certificate using PKI.js (single parse for both URL types)
		const certBuffer = pemToBuffer(certPem);
		const cert = pkijs.Certificate.fromBER(certBuffer);

		const crlUrls: string[] = [];
		const ocspUrls: string[] = [];

		// Single pass through extensions to extract both CRL and OCSP URLs
		for (const ext of cert.extensions || []) {
			if (ext.extnID === '2.5.29.31') {
				// CRL Distribution Points extension
				try {
					const asn1 = asn1js.fromBER(ext.extnValue.valueBlock.valueHexView);
					if (asn1.offset !== -1) {
						const crlDistPoints = new pkijs.CRLDistributionPoints({
							schema: asn1.result,
						});

						// Extract CRL distribution point URLs
						for (const distPoint of crlDistPoints.distributionPoints) {
							if (distPoint.distributionPoint && Array.isArray(distPoint.distributionPoint)) {
								// Handle the actual PKI.js structure where distributionPoint is an array
								for (const dp of distPoint.distributionPoint) {
									if (dp.type === 6 && typeof dp.value === 'string') {
										// uniformResourceIdentifier
										const url = dp.value;
										if (url.startsWith('http://') || url.startsWith('https://')) {
											crlUrls.push(url);
										}
									}
								}
							}
						}
					}
				} catch (crlError) {
					logger.debug?.(`Failed to parse CRL Distribution Points extension: ${crlError}`);
				}
			} else if (ext.extnID === '1.3.6.1.5.5.7.1.1') {
				// Authority Information Access extension
				try {
					const asn1 = asn1js.fromBER(ext.extnValue.valueBlock.valueHexView);
					if (asn1.offset !== -1 && asn1.result instanceof asn1js.Sequence) {
						for (const accessDesc of asn1.result.valueBlock.value) {
							if (accessDesc instanceof asn1js.Sequence && accessDesc.valueBlock.value.length >= 2) {
								const accessMethod = accessDesc.valueBlock.value[0];
								const accessLocation = accessDesc.valueBlock.value[1];

								// Check if accessMethod is OCSP (OID 1.3.6.1.5.5.7.48.1)
								if (
									accessMethod instanceof asn1js.ObjectIdentifier &&
									accessMethod.valueBlock.toString() === '1.3.6.1.5.5.7.48.1'
								) {
									// Check if accessLocation is a URI (context tag 6)
									if (accessLocation.idBlock.tagNumber === 6) {
										const url = String.fromCharCode(
											...Array.from((accessLocation.valueBlock as any).valueHexView)
										);
										if (url.startsWith('http://') || url.startsWith('https://')) {
											ocspUrls.push(url);
										}
									}
								}
							}
						}
					}
				} catch (ocspError) {
					logger.debug?.(`Failed to parse Authority Information Access extension: ${ocspError}`);
				}
			}
		}

		logger.debug?.(`Found ${crlUrls.length} CRL distribution points and ${ocspUrls.length} OCSP responder URLs`);
		return { crlUrls, ocspUrls };
	} catch (error) {
		logger.error?.(`Failed to extract revocation URLs: ${error}`);
		return { crlUrls: [], ocspUrls: [] };
	}
}

/**
 * Extract OCSP responder URLs from a certificate
 * @param certPem - Certificate in PEM format
 * @returns Array of OCSP responder URLs
 */
export function extractOCSPUrls(certPem: string): string[] {
	try {
		// Parse the certificate using PKI.js
		const certBuffer = pemToBuffer(certPem);
		const cert = pkijs.Certificate.fromBER(certBuffer);

		// Look for Authority Information Access extension (OID: 1.3.6.1.5.5.7.1.1)
		const aiaExt = cert.extensions?.find((ext) => ext.extnID === '1.3.6.1.5.5.7.1.1');

		if (!aiaExt) {
			logger.debug?.('Certificate has no Authority Information Access extension');
			return [];
		}

		// Parse the extension value using asn1js
		const asn1 = asn1js.fromBER(aiaExt.extnValue.valueBlock.valueHexView);
		if (asn1.offset === -1) {
			throw new Error('Failed to parse ASN.1 structure in Authority Information Access extension');
		}

		const ocspUrls: string[] = [];

		// The AIA extension contains a sequence of AccessDescription entries
		// Each AccessDescription has: accessMethod (OID) and accessLocation (GeneralName)
		if (asn1.result instanceof asn1js.Sequence) {
			for (const accessDesc of asn1.result.valueBlock.value) {
				if (accessDesc instanceof asn1js.Sequence && accessDesc.valueBlock.value.length >= 2) {
					const accessMethod = accessDesc.valueBlock.value[0];
					const accessLocation = accessDesc.valueBlock.value[1];

					// Check if accessMethod is OCSP (OID 1.3.6.1.5.5.7.48.1)
					if (
						accessMethod instanceof asn1js.ObjectIdentifier &&
						accessMethod.valueBlock.toString() === '1.3.6.1.5.5.7.48.1'
					) {
						// Check if accessLocation is a URI (context tag 6)
						if (accessLocation.idBlock.tagNumber === 6) {
							const url = String.fromCharCode(
								...Array.from((accessLocation.valueBlock as any).valueHexView)
							);
							if (url.startsWith('http://') || url.startsWith('https://')) {
								ocspUrls.push(url);
							}
						}
					}
				}
			}
		}

		logger.debug?.(`Found ${ocspUrls.length} OCSP responder URLs: ${ocspUrls}`);
		return ocspUrls;
	} catch (error) {
		logger.error?.(`Failed to extract OCSP URLs: ${error}`);
		return [];
	}
}

/**
 * Convert PEM string to buffer for PKI.js parsing
 * @param pem - PEM formatted certificate
 * @returns Buffer containing certificate data
 */
export function pemToBuffer(pem: string): ArrayBuffer {
	// Remove PEM headers and whitespace
	const base64 = pem
		.replace(/-----BEGIN [^-]+-----/g, '')
		.replace(/-----END [^-]+-----/g, '')
		.replace(/\s/g, '');

	// Convert to buffer
	const binaryString = atob(base64);
	const buffer = new ArrayBuffer(binaryString.length);
	const view = new Uint8Array(buffer);

	for (let i = 0; i < binaryString.length; i++) {
		view[i] = binaryString.charCodeAt(i);
	}

	return buffer;
}

/**
 * Create a cache key for certificate verification
 * @param certPem - Certificate in PEM format
 * @param issuerPem - Issuer certificate in PEM format
 * @param method - Verification method (ocsp, crl)
 * @param additionalData - Additional data to include in hash
 * @returns Cache key string
 */
export function createCacheKey(
	certPem: string,
	issuerPem: string,
	method: 'ocsp' | 'crl',
	additionalData?: Record<string, any>
): string {
	const cacheData = {
		certPem,
		issuerPem,
		method,
		...additionalData,
	};
	const cacheKeyHash = createHash('sha256').update(JSON.stringify(cacheData)).digest('hex');
	return `${method}:${cacheKeyHash}`;
}

/**
 * Create a cache key for CRL storage
 * @param distributionPoint - CRL distribution point URL
 * @returns Cache key string
 */
export function createCRLCacheKey(distributionPoint: string): string {
	const hash = createHash('sha256').update(distributionPoint).digest('hex');
	return `crl:${hash}`;
}

/**
 * Create a composite ID for revoked certificate lookup
 * @param issuerKeyId - Issuer key identifier or DN hash
 * @param serialNumber - Certificate serial number
 * @returns Composite ID string
 */
export function createRevokedCertificateId(issuerKeyId: string, serialNumber: string): string {
	return `${issuerKeyId}:${serialNumber}`;
}

/**
 * Extract serial number from a certificate
 * @param certPem - Certificate in PEM format
 * @returns Certificate serial number as string
 */
export function extractSerialNumber(certPem: string): string {
	try {
		const certBuffer = pemToBuffer(certPem);
		const cert = pkijs.Certificate.fromBER(certBuffer);

		// Convert serial number to string
		const serialNumber = cert.serialNumber.valueBlock.valueHexView;
		return Array.from(serialNumber)
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
	} catch (error) {
		logger.error?.(`Failed to extract serial number: ${error}`);
		throw new Error(`Failed to extract certificate serial number: ${error.message}`);
	}
}

/**
 * Extract issuer key identifier from a certificate
 * @param certPem - Certificate in PEM format
 * @returns Issuer key identifier as hex string, or hash of issuer DN if not available
 */
export function extractIssuerKeyId(certPem: string): string {
	try {
		const certBuffer = pemToBuffer(certPem);
		const cert = pkijs.Certificate.fromBER(certBuffer);

		// Look for Authority Key Identifier extension (OID: 2.5.29.35)
		const akiExt = cert.extensions?.find((ext) => ext.extnID === '2.5.29.35');

		if (akiExt) {
			const aki = new pkijs.AuthorityKeyIdentifier({
				schema: akiExt.parsedValue,
			});

			if (aki.keyIdentifier) {
				const keyId = aki.keyIdentifier.valueBlock.valueHexView;
				return Array.from(keyId)
					.map((b) => b.toString(16).padStart(2, '0'))
					.join('');
			}
		}

		// Fall back to hash of issuer DN
		const issuerDN = cert.issuer.typesAndValues.map((tv) => `${tv.type}=${tv.value.valueBlock.value}`).join(',');

		return createHash('sha256').update(issuerDN).digest('hex');
	} catch (error) {
		logger.error?.(`Failed to extract issuer key ID: ${error}`);
		throw new Error(`Failed to extract issuer key ID: ${error.message}`);
	}
}

/**
 * Get shared certificate verification cache table
 * @returns Harper table instance for certificate verification cache
 */
export function getCertificateCacheTable() {
	return table({
		table: 'hdb_certificate_cache',
		database: 'system',
		attributes: [
			{
				name: 'certificate_id',
				isPrimaryKey: true,
			},
			{
				name: 'status', // 'good', 'revoked', 'unknown'
			},
			{
				name: 'reason',
			},
			{
				name: 'checked_at',
			},
			{
				name: 'expiresAt',
				expiresAt: true, // This marks it as an expiration timestamp field
				indexed: true, // Required for expiration functionality
			},
			{
				name: 'method', // 'ocsp' or 'crl'
			},
		],
	});
}
