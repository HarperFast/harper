/**
 * CRL (Certificate Revocation List) verification
 */

import * as pkijs from 'pkijs';
import { loggerWithTag } from '../../utility/logging/logger.ts';
import { Resource } from '../../resources/Resource.ts';
import { transaction } from '../../resources/transaction.ts';
import type { SourceContext } from '../../resources/ResourceInterface.ts';
import {
	extractCRLDistributionPoints,
	extractSerialNumber,
	extractIssuerKeyId,
	createRevokedCertificateId,
	bufferToPem,
	createCacheKey,
	getCertificateCacheTable as getSharedCertificateCacheTable,
	pemToBuffer,
} from './verificationUtils.ts';
import { declareCRLCacheTable, declareRevokedCertificatesTable } from './verificationTables.ts';
import { ERROR_CACHE_TTL, CRL_DEFAULT_VALIDITY_PERIOD, CRL_USER_AGENT } from './verificationConfig.ts';
import type {
	CertificateVerificationResult,
	CertificateCacheEntry,
	CRLCheckResult,
	CRLConfig,
	CRLVerificationContext,
	CRLCacheEntry,
	RevokedCertificateEntry,
} from './types.ts';

/**
 * Custom error for CRL signature verification failures
 * This distinguishes security failures (invalid signatures) from operational failures (network, timeout)
 */
export class CRLSignatureVerificationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CRLSignatureVerificationError';
	}
}
import { CertificateVerificationSource } from './certificateVerificationSource.ts';

const logger = loggerWithTag('crl-verification');

// Lazy-load the certificate verification cache table with CRL source configured
let certCacheTable: ReturnType<typeof getSharedCertificateCacheTable>;
function getCertificateCacheTable() {
	if (!certCacheTable) {
		certCacheTable = getSharedCertificateCacheTable();
		// Configure the caching source using the shared CertificateVerificationSource class
		(certCacheTable as any).sourcedFrom(CertificateVerificationSource);
	}
	return certCacheTable;
}

/**
 * CRL fetching and validation source
 */
class CertificateRevocationListSource extends Resource {
	async get(id: string) {
		const context = this.getContext() as SourceContext<CRLVerificationContext>;
		const requestContext = context?.requestContext;

		if (!requestContext?.distributionPoint || !requestContext?.issuerPem) {
			throw new Error(`No CRL data provided for cache key: ${id}`);
		}

		const { distributionPoint, issuerPem: issuerPemStr, config } = requestContext;

		try {
			const result = await downloadAndParseCRL(distributionPoint, issuerPemStr, config);

			// Set expiration - use the CRL's nextUpdate time or configured TTL, whichever is sooner
			context.expiresAt = Math.min(result.next_update, Date.now() + config.cacheTtl);

			return result;
		} catch (error) {
			logger.error?.(`CRL fetch error for: ${distributionPoint} - ${error}`);

			if (error instanceof CRLSignatureVerificationError) {
				throw error;
			}

			// Check failure mode
			if (config.failureMode === 'fail-closed') {
				// Cache the error for faster recovery
				context.expiresAt = Date.now() + ERROR_CACHE_TTL;

				return {
					crl_id: id,
					distribution_point: distributionPoint,
					issuer_dn: 'unknown',
					crl_blob: Buffer.alloc(0),
					this_update: Date.now(),
					next_update: context.expiresAt,
					signature_valid: false,
				};
			}

			// Fail open - return null to not cache
			logger.warn?.('CRL fetch failed, not caching (fail-open mode)');
			return null;
		}
	}
}

// Lazy-load Harper tables
let crlCacheTable: ReturnType<typeof declareCRLCacheTable>;
let revokedCertificateTable: ReturnType<typeof declareRevokedCertificatesTable>;

function getCRLCacheTable() {
	if (!crlCacheTable) {
		crlCacheTable = declareCRLCacheTable();
		// Configure the caching source
		(crlCacheTable as any).sourcedFrom(CertificateRevocationListSource);
	}
	return crlCacheTable;
}

function getRevokedCertificateTable() {
	revokedCertificateTable ??= declareRevokedCertificatesTable();
	return revokedCertificateTable;
}

/**
 * Verify CRL status of a client certificate
 * @param certPem - Client certificate as Buffer (DER format)
 * @param issuerPem - Issuer (CA) certificate as Buffer (DER format)
 * @param config - CRL configuration
 * @param crlUrls - Optional pre-extracted CRL distribution point URLs (avoids re-parsing)
 * @returns Promise resolving to verification result
 */
export async function verifyCRL(
	certPem: Buffer,
	issuerPem: Buffer,
	config?: CRLConfig,
	crlUrls?: string[]
): Promise<CertificateVerificationResult> {
	// Check if CRL verification is disabled
	if (config?.enabled === false) {
		return { valid: true, status: 'disabled', method: 'disabled' };
	}

	try {
		// Convert DER buffers to PEM strings for certificate parsing libraries
		// PKI.js and other certificate utilities expect PEM format for extension extraction
		const certPemStr = bufferToPem(certPem, 'CERTIFICATE');
		const issuerPemStr = bufferToPem(issuerPem, 'CERTIFICATE');

		// Extract CRL distribution points from the certificate (if not already provided)
		const distributionPoints = crlUrls ?? extractCRLDistributionPoints(certPemStr);

		if (distributionPoints.length === 0) {
			return { valid: true, status: 'no-crl-distribution-points', method: 'crl' };
		}

		// Create a cache key that includes all verification parameters
		const cacheKey = createCacheKey(certPemStr, issuerPemStr, 'crl');

		// Pass certificate data as context - Harper will make it available as requestContext in the source
		const cacheEntry = await (getCertificateCacheTable() as any).get(cacheKey, undefined, {
			certPem: certPemStr,
			issuerPem: issuerPemStr,
			distributionPoint: distributionPoints[0], // Use first distribution point for CRL fetch
			config: { crl: config ?? {} },
		} as any);

		if (!cacheEntry) {
			// This should not happen if the source is configured correctly but handle it gracefully
			logger.error?.('Cache fetch returned null - this indicates a source configuration issue');
			if (config.failureMode === 'fail-closed') {
				return { valid: false, status: 'error', error: 'Cache fetch failed', method: 'crl' };
			}

			logger.warn?.('CRL cache fetch failed, allowing connection (fail-open mode)');
			return { valid: true, status: 'error-allowed', method: 'crl' };
		}

		const cached = cacheEntry as unknown as CertificateCacheEntry;
		const wasLoadedFromSource = (cacheEntry as any).wasLoadedFromSource?.();
		logger.trace?.(`CRL ${wasLoadedFromSource ? 'source fetch' : 'cache hit'} for certificate`);

		return {
			valid: cached.status === 'good',
			status: cached.status,
			cached: !wasLoadedFromSource,
			method: cached.method || 'crl',
		};
	} catch (error) {
		logger.error?.(`CRL verification error: ${error}`);

		if (error instanceof CRLSignatureVerificationError) {
			return { valid: false, status: 'error', error: (error as Error).message, method: 'crl' };
		}

		// Check failure mode
		if (config.failureMode === 'fail-closed') {
			return { valid: false, status: 'error', error: (error as Error).message, method: 'crl' };
		}

		// Fail open - allow connection on CRL errors
		logger.warn?.('CRL check failed, allowing connection (fail-open mode)');
		return { valid: true, status: 'error-allowed', method: 'crl' };
	}
}

/**
 * Perform the actual CRL check by looking up the certificate in the revoked certificates table
 * @param certPem - Certificate in PEM format
 * @param issuerPem - Issuer certificate in PEM format
 * @param config - CRL configuration
 * @param crlUrls - Optional pre-extracted CRL distribution point URLs (avoids re-parsing)
 * @returns CRL check result
 */
export async function performCRLCheck(
	certPem: string,
	issuerPem: string,
	config: CRLConfig,
	crlUrls?: string[]
): Promise<CRLCheckResult> {
	// Extract CRL distribution points from the certificate (if not already provided)
	const distributionPoints = crlUrls ?? extractCRLDistributionPoints(certPem);

	if (distributionPoints.length === 0) {
		return { status: 'good' };
	}

	// Extract certificate identifiers for lookup
	const serialNumber = extractSerialNumber(certPem);
	const issuerKeyId = extractIssuerKeyId(issuerPem);
	const compositeId = createRevokedCertificateId(issuerKeyId, serialNumber);

	try {
		// Get the revoked certificates table
		const revokedTable = getRevokedCertificateTable();

		// Look up the certificate in the revoked list
		const revokedEntry = await (revokedTable as any).get(compositeId);

		if (revokedEntry) {
			// Check if CRL data is still valid (within grace period if expired)
			const now = Date.now();

			const entry = revokedEntry as any;
			if (entry.crl_next_update > now) {
				// CRL is still valid
				return {
					status: 'revoked',
					reason: entry.revocation_reason || 'unspecified',
					source: entry.crl_source,
				};
			} else if (entry.crl_next_update + config.gracePeriod > now) {
				// CRL is expired but within grace period
				logger.warn?.('Using expired CRL data within grace period');
				return {
					status: 'revoked',
					reason: entry.revocation_reason || 'unspecified',
					source: entry.crl_source,
				};
			} else {
				// CRL is too old, treat as unknown
				logger.warn?.('CRL data is too old, treating as unknown');
				return {
					status: 'unknown',
					reason: 'crl-expired',
				};
			}
		}

		// Certificate not found in revocation list - check if we have current CRL data
		// This requires checking if CRLs for the distribution points are up to date
		const crlStatus = await checkCRLFreshness(distributionPoints, issuerPem, config);

		if (crlStatus.upToDate) {
			// CRL was just fetched/refreshed — re-check the revoked table since it may have
			// been populated by processRevokedCertificates during the download above. Outside the verdict
			// fill's transaction: on LMDB its read snapshot predates the revocations committed since.
			const revokedEntryFresh = await (revokedTable as any).get(compositeId, {});
			if (revokedEntryFresh) {
				const entry = revokedEntryFresh as any;
				const now = Date.now();
				if (entry.crl_next_update > now || entry.crl_next_update + config.gracePeriod > now) {
					return {
						status: 'revoked',
						reason: entry.revocation_reason || 'unspecified',
						source: entry.crl_source,
					};
				}
			}
			// Certificate is not in the fresh CRL — it's good
			return {
				status: 'good',
				source: crlStatus.source,
			};
		} else {
			// CRL data is stale or missing
			logger.warn?.('CRL data is stale or missing, treating as unknown');
			return {
				status: 'unknown',
				reason: crlStatus.reason || 'crl-unavailable',
			};
		}
	} catch (error) {
		logger.error?.(`CRL lookup error: ${error}`);
		return {
			status: 'unknown',
			reason: (error as Error).message,
		};
	}
}

/**
 * Check if CRL data is fresh for the given distribution points, and fetch if needed
 * @param distributionPoints - Array of CRL distribution point URLs
 * @param issuerPem - Issuer certificate for CRL signature verification
 * @param config - CRL configuration
 * @returns Status of CRL freshness
 */
async function checkCRLFreshness(
	distributionPoints: string[],
	issuerPem: string,
	config: CRLConfig
): Promise<{ upToDate: boolean; reason?: string; source?: string }> {
	const now = Date.now();

	// Check each distribution point
	for (const distributionPoint of distributionPoints) {
		try {
			// First, check if we have a cached CRL that's still valid
			const crlTable = getCRLCacheTable();
			let crlData: CRLCacheEntry | null = null;
			let cachedCRL: CRLCacheEntry | null = null;

			try {
				const cached = await (crlTable as any).get(distributionPoint);
				cachedCRL = cached as unknown as CRLCacheEntry;
				if (cachedCRL && cachedCRL.next_update > now) {
					crlData = cachedCRL;
				} else if (cachedCRL && cachedCRL.next_update + config.gracePeriod > now) {
					crlData = cachedCRL;
				}
			} catch {
				// Failed to check cache, continue
			}

			// If no valid cached CRL, download and parse fresh
			if (!crlData) {
				crlData = await downloadAndParseCRL(distributionPoint, issuerPem, config);
			}

			// Check if CRL is current
			const crlExpiry = crlData.next_update;
			if (crlExpiry > now) {
				// Store in cache for future use (only if we downloaded it fresh)
				if (!cachedCRL) {
					try {
						await (crlTable as any).put(distributionPoint, crlData, { expiresAt: crlExpiry });
					} catch {
						// Failed to cache, but continue anyway
					}
				}

				return { upToDate: true, source: distributionPoint };
			} else if (crlExpiry + config.gracePeriod > now) {
				return { upToDate: true, source: distributionPoint };
			} else {
				return { upToDate: false, reason: 'crl-expired' };
			}
		} catch (error) {
			// Signature verification failures are security failures, not operational failures
			// Rethrow them so they don't get swallowed as "unknown" status
			if (error instanceof CRLSignatureVerificationError) {
				throw error;
			}
			// Operational failures (network, timeout, parse errors) - continue to next distribution point
		}
	}

	return { upToDate: false, reason: 'no-current-crl-data' };
}

/**
 * Download and parse a CRL from a distribution point
 * @param distributionPoint - CRL URL
 * @param issuerPemStr - Issuer certificate for signature verification
 * @param config - CRL configuration (download timeout, grace period)
 * @returns Parsed CRL entry for caching
 */
async function downloadAndParseCRL(
	distributionPoint: string,
	issuerPemStr: string,
	config: CRLConfig
): Promise<CRLCacheEntry> {
	// Download the CRL
	// Note: Using fetch here since CRL downloads are cached and infrequent
	// (typically one per CA), so this is not a hot path
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), config.timeout);

	try {
		const response = await fetch(distributionPoint, {
			signal: controller.signal,
			headers: {
				'User-Agent': CRL_USER_AGENT,
			},
		});

		clearTimeout(timeoutId);

		if (!response.ok) {
			throw new Error(`CRL download failed: ${response.status}`);
		}

		const crlBuffer = Buffer.from(await response.arrayBuffer());

		// Convert PEM to DER format if needed (PKI.js expects DER)
		let crlDerBuffer: Buffer;
		const crlText = crlBuffer.toString('utf8');
		if (crlText.includes('-----BEGIN X509 CRL-----')) {
			crlDerBuffer = Buffer.from(pemToBuffer(crlText));
		} else {
			crlDerBuffer = crlBuffer;
		}

		// Parse and validate the CRL
		const crl = pkijs.CertificateRevocationList.fromBER(crlDerBuffer as any);

		// Verify CRL signature
		const issuerCert = pkijs.Certificate.fromBER(pemToBuffer(issuerPemStr));
		const signatureValid = await crl.verify({ issuerCertificate: issuerCert });

		if (!signatureValid) {
			// Invalid signature is a security failure - always reject regardless of fail-open/fail-closed mode
			// Fail-open mode is for operational failures (network issues, timeouts), not security validation failures
			const msg = `CRL signature verification failed for: ${distributionPoint}`;
			logger.error?.(msg);
			throw new CRLSignatureVerificationError(msg);
		}

		// Extract timing information
		const thisUpdate = crl.thisUpdate.value.getTime();
		const nextUpdate = crl.nextUpdate?.value.getTime() ?? thisUpdate + CRL_DEFAULT_VALIDITY_PERIOD;

		// Extract issuer DN
		const issuerDN = issuerCert.issuer.typesAndValues.map((tv) => `${tv.type}=${tv.value.valueBlock.value}`).join(',');

		const cacheEntry: CRLCacheEntry = {
			distribution_point: distributionPoint,
			issuer_dn: issuerDN,
			crl_blob: crlBuffer,
			this_update: thisUpdate,
			next_update: nextUpdate,
			signature_valid: signatureValid,
		};

		// Process revoked certificates before returning so the revoked table is populated
		// before any subsequent lookup in performCRLCheck
		await processRevokedCertificates(crl, issuerPemStr, distributionPoint, nextUpdate, config.gracePeriod ?? 0);

		return cacheEntry;
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * Replace this CRL's rows in the revoked certificates table with its current revocations
 * @param crl - Parsed CRL object
 * @param issuerPemStr - Issuer certificate PEM
 * @param distributionPoint - CRL distribution point URL
 * @param nextUpdate - When this CRL expires
 * @param gracePeriod - How long past nextUpdate performCRLCheck still honors a revocation
 */
async function processRevokedCertificates(
	crl: pkijs.CertificateRevocationList,
	issuerPemStr: string,
	distributionPoint: string,
	nextUpdate: number,
	gracePeriod: number
): Promise<void> {
	const revokedTable = getRevokedCertificateTable();
	const issuerKeyId = extractIssuerKeyId(issuerPemStr);
	const cacheKey = distributionPoint;

	// All or nothing, so a failure leaves the previous revocations rather than a partial set that would read
	// as good. Its own transaction, not the verdict fill's, so the rows are committed before performCRLCheck
	// reads them back; the context's expiresAt is what each row stores as its expiry.
	await transaction({ expiresAt: nextUpdate + gracePeriod }, async () => {
		// Clear existing entries for this CRL: certificates removed from an updated CRL must not stay revoked
		await clearExistingCRLEntries(revokedTable, cacheKey);

		for (const revokedCert of crl.revokedCertificates ?? []) {
			// Extract serial number using PKI.js - same method as extractSerialNumber() function
			// This gives us the clean serial number without ASN.1 encoding
			const serialHex = revokedCert.userCertificate.valueBlock.valueHexView;
			if (!serialHex)
				throw new Error(`A revoked certificate in the CRL from ${distributionPoint} has no serial number`);

			const serialNumber = Array.from(serialHex)
				.map((b) => b.toString(16).padStart(2, '0'))
				.join('');

			const entry: RevokedCertificateEntry = {
				composite_id: createRevokedCertificateId(issuerKeyId, serialNumber),
				serial_number: serialNumber,
				issuer_key_id: issuerKeyId,
				revocation_date: revokedCert.revocationDate.value.getTime(),
				// For now, skip complex extension parsing and just use default reason
				revocation_reason: 'unspecified',
				crl_source: cacheKey,
				crl_next_update: nextUpdate,
			};

			await (revokedTable as any).put(entry.composite_id, entry);
		}
	});
}

/**
 * Delete the revoked certificate entries stored for a specific CRL source
 * @param revokedTable - Harper table for revoked certificates
 * @param crlSource - CRL cache key to identify entries to remove
 */
async function clearExistingCRLEntries(
	revokedTable: ReturnType<typeof getRevokedCertificateTable>,
	crlSource: string
): Promise<void> {
	// Relies on crl_source being indexed
	const compositeIds: string[] = [];
	for await (const entry of (revokedTable as any).search([{ attribute: 'crl_source', value: crlSource }])) {
		compositeIds.push((entry as any).composite_id);
	}
	for (const compositeId of compositeIds) await (revokedTable as any).delete(compositeId);
}
