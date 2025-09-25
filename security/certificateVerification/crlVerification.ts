/**
 * CRL (Certificate Revocation List) verification
 */

import * as pkijs from 'pkijs';
import { loggerWithTag } from '../../utility/logging/logger.js';
import { table } from '../../resources/databases.ts';
import { Resource } from '../../resources/Resource.ts';
import type { SourceContext } from '../../resources/ResourceInterface.ts';
import {
	extractCRLDistributionPoints,
	extractSerialNumber,
	extractIssuerKeyId,
	createRevokedCertificateId,
	bufferToPem,
	createCacheKey,
	createCRLCacheKey,
	getCertificateCacheTable as getSharedCertificateCacheTable,
	pemToBuffer,
} from './verificationUtils.ts';
import { CRL_DEFAULTS, ERROR_CACHE_TTL, CRL_DEFAULT_VALIDITY_PERIOD, CRL_USER_AGENT } from './verificationConfig.ts';
import type {
	CertificateVerificationResult,
	CertificateVerificationContext,
	CertificateCacheEntry,
	CRLCheckResult,
	CRLConfig,
	CRLVerificationContext,
	CRLCacheEntry,
	RevokedCertificateEntry,
} from './types.ts';

const logger = loggerWithTag('crl-verification');

/**
 * CRL fetching and validation source
 */
class CertificateRevocationListSource extends Resource {
	async get(id: string) {
		logger.debug?.(`CertificateRevocationListSource.get called for: ${id}`);

		const context = this.getContext() as SourceContext<CRLVerificationContext>;
		const requestContext = context?.requestContext;

		if (!requestContext?.distributionPoint || !requestContext?.issuerPem) {
			throw new Error(`No CRL data provided for cache key: ${id}`);
		}

		const { distributionPoint, issuerPem: issuerPemStr, config } = requestContext;
		logger.trace?.(`Downloading and validating CRL from: ${distributionPoint}`);

		try {
			const timeout = config?.timeout ?? CRL_DEFAULTS.timeout;
			const result = await downloadAndParseCRL(distributionPoint, issuerPemStr, timeout);

			const ttl = config?.cacheTtl ?? CRL_DEFAULTS.cacheTtl;

			// Set expiration on the context
			if (context) {
				// Use the CRL's nextUpdate time or configured TTL, whichever is sooner
				const crlExpiry = result.next_update;
				const configExpiry = Date.now() + ttl;
				context.expiresAt = Math.min(crlExpiry, configExpiry);
			}

			return result;
		} catch (error) {
			logger.error?.(`CRL fetch error for: ${distributionPoint} - ${error}`);

			// Check failure mode
			const failureMode = config?.failureMode ?? CRL_DEFAULTS.failureMode;
			if (failureMode === 'fail-closed') {
				// Cache the error for faster recovery
				const expiresAt = Date.now() + ERROR_CACHE_TTL;

				if (context) {
					context.expiresAt = expiresAt;
				}

				return {
					crl_id: id,
					distribution_point: distributionPoint,
					issuer_dn: 'unknown',
					crl_blob: Buffer.alloc(0),
					this_update: Date.now(),
					next_update: expiresAt,
					signature_valid: false,
					expiresAt,
				};
			}

			// Fail open - return null to not cache
			logger.warn?.('CRL fetch failed, not caching (fail-open mode)');
			return null;
		}
	}
}

/**
 * Fast lookup source for individual revoked certificates
 */
class RevokedCertificateSource extends Resource {
	async get(id: string) {
		logger.debug?.(`RevokedCertificateSource.get called for: ${id}`);

		// This source doesn't fetch from external sources - it only serves
		// as a placeholder for the table configuration. The actual lookup
		// logic is in the verifyCRL function which directly queries the table.
		return null;
	}
}

// Lazy-load Harper tables
let crlCacheTable: ReturnType<typeof table>;
let revokedCertificateTable: ReturnType<typeof table>;

function getCRLCacheTable() {
	if (!crlCacheTable) {
		crlCacheTable = table({
			table: 'hdb_crl_cache',
			database: 'system',
			attributes: [
				{
					name: 'crl_id',
					isPrimaryKey: true,
				},
				{
					name: 'distribution_point',
					indexed: true,
				},
				{
					name: 'issuer_dn',
				},
				{
					name: 'crl_blob',
				},
				{
					name: 'this_update',
				},
				{
					name: 'next_update',
				},
				{
					name: 'signature_valid',
				},
				{
					name: 'expiresAt',
					expiresAt: true,
					indexed: true,
				},
			],
		});

		// Configure the caching source
		(crlCacheTable as any).sourcedFrom(CertificateRevocationListSource);
	}
	return crlCacheTable;
}

function getRevokedCertificateTable() {
	if (!revokedCertificateTable) {
		revokedCertificateTable = table({
			table: 'hdb_revoked_certificates',
			database: 'system',
			attributes: [
				{
					name: 'composite_id',
					isPrimaryKey: true,
				},
				{
					name: 'serial_number',
					indexed: true,
				},
				{
					name: 'issuer_key_id',
					indexed: true,
				},
				{
					name: 'revocation_date',
				},
				{
					name: 'revocation_reason',
				},
				{
					name: 'crl_source',
					indexed: true, // Links to CRL cache
				},
				{
					name: 'crl_next_update',
				},
				{
					name: 'expiresAt',
					expiresAt: true,
					indexed: true,
				},
			],
		});

		// Configure the source (though it won't be used for external fetching)
		(revokedCertificateTable as any).sourcedFrom(RevokedCertificateSource);
	}
	return revokedCertificateTable;
}

// CRL Certificate Verification Source class that extends Resource
class CRLCertificateVerificationSource extends Resource {
	async get(id: string) {
		logger.debug?.(`CRLCertificateVerificationSource.get called for: ${id}`);

		// Get the certificate data from requestContext
		const context = this.getContext() as SourceContext<CertificateVerificationContext>;
		const requestContext = context?.requestContext;

		if (!requestContext || !requestContext.certPem || !requestContext.issuerPem) {
			throw new Error(`No certificate data provided for cache key: ${id}`);
		}

		const { certPem: certPemStr, issuerPem: issuerPemStr, config } = requestContext;
		const crlConfig = config?.crl ?? {};
		logger.trace?.(`Performing CRL check with config: ${JSON.stringify(crlConfig)}`);

		try {
			const result = await performCRLCheck(certPemStr, issuerPemStr, crlConfig);
			logger.debug?.(`CRL check result: ${JSON.stringify(result)}`);

			const ttl = crlConfig.cacheTtl ?? CRL_DEFAULTS.cacheTtl;

			// Set expiration on the context if available
			if (context) {
				context.expiresAt = Date.now() + ttl;
			}

			return {
				certificate_id: id,
				status: result.status,
				reason: result.reason,
				checked_at: Date.now(),
				expiresAt: Date.now() + ttl,
				method: 'crl',
			};
		} catch (error) {
			logger.error?.(`CRL verification error: ${error}`);

			// Check failure mode
			const failureMode = crlConfig.failureMode ?? CRL_DEFAULTS.failureMode;
			if (failureMode === 'fail-closed') {
				// Return an error status that will be cached for faster recovery from errors
				const expiresAt = Date.now() + ERROR_CACHE_TTL;

				if (context) {
					context.expiresAt = expiresAt;
				}

				return {
					certificate_id: id,
					status: 'unknown',
					reason: (error as Error).message,
					checked_at: Date.now(),
					expiresAt,
					method: 'crl',
				};
			}

			// Fail open - return null to not cache
			logger.warn?.('CRL check failed, allowing connection (fail-open mode)');
			return null;
		}
	}
}

// Lazy-load the certificate verification cache table
let certCacheTable: ReturnType<typeof getSharedCertificateCacheTable>;
function getCertificateCacheTable() {
	if (!certCacheTable) {
		certCacheTable = getSharedCertificateCacheTable();
		// Configure the caching source using CRLCertificateVerificationSource class
		(certCacheTable as any).sourcedFrom(CRLCertificateVerificationSource);
	}
	return certCacheTable;
}

/**
 * Verify CRL status of a client certificate
 * @param certPem - Client certificate as Buffer (DER format)
 * @param issuerPem - Issuer (CA) certificate as Buffer (DER format)
 * @param config - CRL configuration
 * @returns Promise resolving to verification result
 */
export async function verifyCRL(
	certPem: Buffer,
	issuerPem: Buffer,
	config?: CRLConfig
): Promise<CertificateVerificationResult> {
	logger.debug?.('verifyCRL called');

	try {
		// Convert DER buffers to PEM strings for certificate parsing libraries
		// PKI.js and other certificate utilities expect PEM format for extension extraction
		const certPemStr = bufferToPem(certPem, 'CERTIFICATE');
		const issuerPemStr = bufferToPem(issuerPem, 'CERTIFICATE');

		// Extract CRL distribution points from the certificate
		const distributionPoints = extractCRLDistributionPoints(certPemStr);

		if (distributionPoints.length === 0) {
			logger.debug?.('Certificate has no CRL distribution points');
			return { valid: true, status: 'no-crl-distribution-points', method: 'crl' };
		}

		// Create a cache key that includes all verification parameters
		const cacheKey = createCacheKey(certPemStr, issuerPemStr, 'crl');
		logger.trace?.(`CRL cache key: ${cacheKey}`);

		// Pass certificate data as context - Harper will make it available as requestContext in the source
		const cacheEntry = await getCertificateCacheTable().get(cacheKey, {
			certPem: certPemStr,
			issuerPem: issuerPemStr,
			config: { crl: config ?? {} },
		} as CertificateVerificationContext);

		if (!cacheEntry) {
			// This should not happen if the source is configured correctly but handle it gracefully
			const failureMode = config?.failureMode ?? CRL_DEFAULTS.failureMode;
			if (failureMode === 'fail-closed') {
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

		// Check failure mode
		const failureMode = config?.failureMode ?? CRL_DEFAULTS.failureMode;
		if (failureMode === 'fail-closed') {
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
 * @returns CRL check result
 */
async function performCRLCheck(certPem: string, issuerPem: string, config: CRLConfig): Promise<CRLCheckResult> {
	// Extract CRL distribution points from the certificate
	const distributionPoints = extractCRLDistributionPoints(certPem);

	if (distributionPoints.length === 0) {
		logger.debug?.('Certificate has no CRL distribution points');
		return { status: 'good' };
	}

	// Extract certificate identifiers for lookup
	const serialNumber = extractSerialNumber(certPem);
	const issuerKeyId = extractIssuerKeyId(issuerPem);
	const compositeId = createRevokedCertificateId(issuerKeyId, serialNumber);
	logger.trace?.(`Performing CRL check for composite ID: ${compositeId}`);

	try {
		// Get the revoked certificates table
		const revokedTable = getRevokedCertificateTable();

		// Look up the certificate in the revoked list
		const revokedEntry = await revokedTable.get(compositeId);

		if (revokedEntry) {
			// Certificate is revoked
			logger.debug?.(`Certificate found in revocation list: ${JSON.stringify(revokedEntry)}`);

			// Check if CRL data is still valid (within grace period if expired)
			const gracePeriod = config.gracePeriod ?? CRL_DEFAULTS.gracePeriod;
			const now = Date.now();

			const entry = revokedEntry as any;
			if (entry.crl_next_update > now) {
				// CRL is still valid
				return {
					status: 'revoked',
					reason: entry.revocation_reason || 'unspecified',
					source: entry.crl_source,
				};
			} else if (entry.crl_next_update + gracePeriod > now) {
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
			// We have current CRL data and certificate is not in it
			logger.debug?.('Certificate not found in current CRL - status: good');
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
	const gracePeriod = config.gracePeriod ?? CRL_DEFAULTS.gracePeriod;
	const now = Date.now();

	const crlTable = getCRLCacheTable();

	// Check each distribution point
	for (const distributionPoint of distributionPoints) {
		try {
			// Create cache key for this distribution point
			const cacheKey = createCRLCacheKey(distributionPoint);

			// Use Harper's caching mechanism to get CRL data (will fetch if not cached)
			const crlEntry = await crlTable.get(cacheKey, {
				requestContext: {
					distributionPoint,
					issuerPem,
					config,
				},
			} as any);

			if (crlEntry) {
				const entry = crlEntry as any;
				if (entry.next_update > now) {
					// CRL is current
					return { upToDate: true, source: distributionPoint };
				} else if (entry.next_update + gracePeriod > now) {
					// CRL is expired but within grace period
					logger.warn?.(`Using expired CRL within grace period for: ${distributionPoint}`);
					return { upToDate: true, source: distributionPoint };
				} else {
					// CRL is too old - try to refresh it
					logger.debug?.(`CRL expired beyond grace period, attempting refresh for: ${distributionPoint}`);

					// Force a cache refresh by calling get with a new context
					try {
						const refreshedEntry = await crlTable.get(cacheKey, {
							requestContext: {
								distributionPoint,
								issuerPem,
								config,
							},
							// Force refresh by clearing any existing cache entry
							refresh: true,
						} as any);

						if (refreshedEntry && (refreshedEntry as any).next_update > now) {
							return { upToDate: true, source: distributionPoint };
						}
					} catch (refreshError) {
						logger.warn?.(`Failed to refresh expired CRL: ${distributionPoint} - ${refreshError}`);
					}
				}
			} else {
				logger.debug?.(`No CRL data found in cache for: ${distributionPoint}`);
			}
		} catch (error) {
			logger.debug?.(`Error checking CRL freshness for: ${distributionPoint} - ${error}`);
			// Continue to next distribution point
		}
	}

	return { upToDate: false, reason: 'no-current-crl-data' };
}

/**
 * Download and parse a CRL from a distribution point
 * @param distributionPoint - CRL URL
 * @param issuerPemStr - Issuer certificate for signature verification
 * @param timeout - Download timeout in milliseconds
 * @returns Parsed CRL entry for caching
 */
async function downloadAndParseCRL(
	distributionPoint: string,
	issuerPemStr: string,
	timeout: number
): Promise<CRLCacheEntry> {
	logger.debug?.(`Downloading CRL from: ${distributionPoint}`);

	// Download the CRL
	// Note: Using fetch instead of undici here (which is currently a dev dep)
	// since CRL downloads are cached and infrequent (typically one per CA),
	// so this is not a hot path
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeout);

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

		logger.debug?.(`Downloaded CRL: ${crlBuffer.length} bytes`);

		// Parse and validate the CRL
		const crl = pkijs.CertificateRevocationList.fromBER(crlBuffer);

		// Verify CRL signature
		const issuerCert = pkijs.Certificate.fromBER(pemToBuffer(issuerPemStr));
		const signatureValid = await crl.verify({ issuerCertificate: issuerCert });

		if (!signatureValid) {
			logger.warn?.(`CRL signature verification failed for: ${distributionPoint}`);
		}

		// Extract timing information
		const thisUpdate = crl.thisUpdate.value.getTime();
		const nextUpdate = crl.nextUpdate?.value.getTime() ?? thisUpdate + CRL_DEFAULT_VALIDITY_PERIOD;

		// Extract issuer DN
		const issuerDN = issuerCert.issuer.typesAndValues.map((tv) => `${tv.type}=${tv.value.valueBlock.value}`).join(',');

		const cacheKey = createCRLCacheKey(distributionPoint);

		const cacheEntry: CRLCacheEntry = {
			crl_id: cacheKey,
			distribution_point: distributionPoint,
			issuer_dn: issuerDN,
			crl_blob: crlBuffer,
			this_update: thisUpdate,
			next_update: nextUpdate,
			signature_valid: signatureValid,
			expiresAt: nextUpdate,
		};

		// Process revoked certificates in the background
		processRevokedCertificates(crl, issuerPemStr, distributionPoint, nextUpdate).catch((error) => {
			logger.error?.(`Error processing revoked certificates: ${error}`);
		});

		return cacheEntry;
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * Process revoked certificates from CRL and store them in the revoked certificates table
 * @param crl - Parsed CRL object
 * @param issuerPemStr - Issuer certificate PEM
 * @param distributionPoint - CRL distribution point URL
 * @param nextUpdate - When this CRL expires
 */
async function processRevokedCertificates(
	crl: pkijs.CertificateRevocationList,
	issuerPemStr: string,
	distributionPoint: string,
	nextUpdate: number
): Promise<void> {
	logger.debug?.(`Processing ${crl.revokedCertificates?.length || 0} revoked certificates`);

	const revokedTable = getRevokedCertificateTable();
	const issuerKeyId = extractIssuerKeyId(issuerPemStr);
	const cacheKey = createCRLCacheKey(distributionPoint);

	// Clear existing entries for this CRL to ensure data consistency
	// This prevents stale revocation data when certificates are removed from updated CRLs
	try {
		await clearExistingCRLEntries(revokedTable, cacheKey);
	} catch (error) {
		logger.warn?.(`Failed to clear existing CRL entries: ${error}`);
		// Continue with processing - partial cleanup is better than no update
	}

	// Add new revoked certificates
	if (crl.revokedCertificates) {
		for (const revokedCert of crl.revokedCertificates) {
			try {
				// Extract serial number - handle both old and new PKI.js APIs
				const serialHex =
					(revokedCert.userCertificate as any).valueBeforeDecode ||
					(revokedCert.userCertificate as any).valueBlock?.valueHexView ||
					(revokedCert.userCertificate as any).valueBlock?.valueHex;

				if (!serialHex) {
					logger.warn?.('Could not extract serial number from revoked certificate');
					continue;
				}

				const serialNumber = Array.from(new Uint8Array(serialHex))
					.map((b) => b.toString(16).padStart(2, '0'))
					.join('');

				const compositeId = createRevokedCertificateId(issuerKeyId, serialNumber);

				// Extract revocation date
				const revocationDate = revokedCert.revocationDate.value.getTime();

				// For now, skip complex extension parsing and just use default reason
				const revocationReason = 'unspecified';

				const entry: RevokedCertificateEntry = {
					composite_id: compositeId,
					serial_number: serialNumber,
					issuer_key_id: issuerKeyId,
					revocation_date: revocationDate,
					revocation_reason: revocationReason,
					crl_source: cacheKey,
					crl_next_update: nextUpdate,
					expiresAt: nextUpdate,
				};

				await revokedTable.create(entry.composite_id, entry);
			} catch (error) {
				logger.warn?.(`Failed to process revoked certificate: ${error}`);
				// Continue with other certificates
			}
		}
	}

	logger.debug?.('Completed processing revoked certificates');
}

/**
 * Clear existing revoked certificate entries for a specific CRL source
 * This ensures data consistency when CRLs are updated and certificates are removed
 * @param revokedTable - Harper table for revoked certificates
 * @param crlSource - CRL cache key to identify entries to remove
 */
async function clearExistingCRLEntries(
	revokedTable: ReturnType<typeof getRevokedCertificateTable>,
	crlSource: string
): Promise<void> {
	logger.debug?.(`Clearing existing entries for CRL: ${crlSource}`);

	// Since Harper doesn't have a direct "delete by field" operation,
	// we need to find all entries with the matching crl_source and delete them individually
	try {
		// Use Harper's search capabilities to find entries by crl_source
		// Note: This assumes the crl_source field is indexed (which it is)
		const existingEntries = (revokedTable as any).search([
			{
				attribute: 'crl_source',
				value: crlSource,
			},
		]);

		let deletedCount = 0;
		for await (const entry of existingEntries) {
			try {
				await revokedTable.delete((entry as any).composite_id);
				deletedCount++;
			} catch (deleteError) {
				logger.warn?.(`Failed to delete revoked certificate entry: ${deleteError}`);
				// Continue with other entries
			}
		}

		logger.debug?.(`Cleared ${deletedCount} existing entries for CRL: ${crlSource}`);
	} catch (searchError) {
		logger.error?.(`Failed to search for existing CRL entries: ${searchError}`);
		throw searchError;
	}
}
