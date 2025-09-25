/**
 * OCSP (Online Certificate Status Protocol) verification
 */

// Apply PKI.js Ed25519 patch before importing easy-ocsp
import './pkijs-ed25519-patch.ts';
import { getCertStatus, getCertURLs } from 'easy-ocsp';
import { loggerWithTag } from '../../utility/logging/logger.js';
import { Resource } from '../../resources/Resource.ts';
import type { SourceContext } from '../../resources/ResourceInterface.ts';
import {
	bufferToPem,
	createCacheKey,
	extractOCSPUrls,
	getCertificateCacheTable as getSharedCertificateCacheTable,
} from './verificationUtils.ts';
import { OCSP_DEFAULTS } from './verificationConfig.ts';
import type {
	CertificateVerificationResult,
	CertificateVerificationContext,
	CertificateCacheEntry,
	OCSPCheckResult,
	OCSPConfig,
} from './types.ts';

const logger = loggerWithTag('ocsp-verification');

// OCSP Certificate Verification Source class that extends Resource
class OCSPCertificateVerificationSource extends Resource {
	async get(id: string) {
		logger.debug?.(`OCSPCertificateVerificationSource.get called for: ${id}`);

		// Get the certificate data from requestContext
		const context = this.getContext() as SourceContext<CertificateVerificationContext>;
		const requestContext = context?.requestContext;

		if (!requestContext || !requestContext.certPem || !requestContext.issuerPem) {
			throw new Error(`No certificate data provided for cache key: ${id}`);
		}

		const { certPem: certPemStr, issuerPem: issuerPemStr, config } = requestContext;
		const ocspConfig = config?.ocsp ?? {};
		logger.trace?.(`Performing OCSP check with config: ${JSON.stringify(ocspConfig)}`);

		try {
			const timeout = ocspConfig.timeout ?? OCSP_DEFAULTS.timeout;

			const result = await Promise.race([
				performOCSPCheck(certPemStr, issuerPemStr, timeout),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error('OCSP timeout')), timeout)),
			]);

			logger.debug?.(`OCSP check result: ${JSON.stringify(result)}`);

			// Check if the result indicates an error (for fail-open/fail-closed handling)
			const isError =
				result.status === 'unknown' &&
				(result.reason === 'ocsp-error' || result.reason === 'timeout' || result.reason === 'no-ocsp-url');

			if (isError) {
				// Handle as an error for fail-open/fail-closed logic
				const failureMode = ocspConfig.failureMode ?? OCSP_DEFAULTS.failureMode;
				logger.error?.(`OCSP check failed: ${result.reason}`);

				if (failureMode === 'fail-closed') {
					// Return an error status that will be cached using error TTL
					const errorTtl = ocspConfig.errorCacheTtl ?? OCSP_DEFAULTS.errorCacheTtl;
					const expiresAt = Date.now() + errorTtl;

					if (context) {
						context.expiresAt = expiresAt;
					}

					return {
						certificate_id: id,
						status: result.status,
						reason: result.reason,
						checked_at: Date.now(),
						expiresAt,
						method: 'ocsp',
					};
				} else {
					// Fail open - return null to not cache
					logger.warn?.('OCSP check failed, allowing connection (fail-open mode)');
					return null;
				}
			}

			// Successful result - cache it
			const ttl = ocspConfig.cacheTtl ?? OCSP_DEFAULTS.cacheTtl;
			const expiresAt = Date.now() + ttl;

			// Set expiration on the context if available
			if (context) {
				context.expiresAt = expiresAt;
			}

			return {
				certificate_id: id,
				status: result.status,
				reason: result.reason,
				checked_at: Date.now(),
				expiresAt,
				method: 'ocsp',
			};
		} catch (error) {
			logger.error?.(`OCSP verification error: ${error}`);

			// Check failure mode
			const failureMode = ocspConfig.failureMode ?? OCSP_DEFAULTS.failureMode;
			if (failureMode === 'fail-closed') {
				// Return an error status that will be cached using error TTL
				const errorTtl = ocspConfig.errorCacheTtl ?? OCSP_DEFAULTS.errorCacheTtl;
				const expiresAt = Date.now() + errorTtl;

				if (context) {
					context.expiresAt = expiresAt;
				}

				return {
					certificate_id: id,
					status: 'unknown',
					reason: (error as Error).message,
					checked_at: Date.now(),
					expiresAt,
					method: 'ocsp',
				};
			}

			// Fail open - return null to not cache
			logger.warn?.('OCSP check failed, allowing connection (fail-open mode)');
			return null;
		}
	}
}

// Lazy-load the certificate verification cache table
let certCacheTable: ReturnType<typeof getSharedCertificateCacheTable>;
function getCertificateCacheTable() {
	if (!certCacheTable) {
		certCacheTable = getSharedCertificateCacheTable();
		// Configure the caching source using OCSPCertificateVerificationSource class
		(certCacheTable as any).sourcedFrom(OCSPCertificateVerificationSource);
	}
	return certCacheTable;
}

/**
 * Verify OCSP status of a client certificate
 * @param certPem - Client certificate as Buffer (DER format)
 * @param issuerPem - Issuer (CA) certificate as Buffer (DER format)
 * @param config - OCSP configuration
 * @returns Promise resolving to verification result
 */
export async function verifyOCSP(
	certPem: Buffer,
	issuerPem: Buffer,
	config?: OCSPConfig,
	ocspUrls?: string[]
): Promise<CertificateVerificationResult> {
	logger.debug?.('verifyOCSP called');

	try {
		// Convert DER buffers to PEM strings for certificate parsing libraries
		// PKI.js and easy-ocsp expect PEM format for extension extraction and OCSP requests
		const certPemStr = bufferToPem(certPem, 'CERTIFICATE');
		const issuerPemStr = bufferToPem(issuerPem, 'CERTIFICATE');

		// Early validation: Check if certificate has OCSP URLs before proceeding
		const urls = ocspUrls || extractOCSPUrls(certPemStr);
		if (urls.length === 0) {
			logger.debug?.('Certificate has no OCSP responder URLs');
			return { valid: true, status: 'no-ocsp-urls', method: 'ocsp' };
		}

		// Create a cache key that includes all verification parameters
		const cacheKey = createCacheKey(certPemStr, issuerPemStr, 'ocsp');
		logger.trace?.(`OCSP cache key: ${cacheKey}`);

		// Get the cache table - Harper will automatically handle
		// concurrent requests and cache stampede prevention
		// Pass certificate data as context - Harper will make it available as requestContext in the source
		const cacheEntry = await getCertificateCacheTable().get(cacheKey, {
			certPem: certPemStr,
			issuerPem: issuerPemStr,
			config: { ocsp: config ?? {} },
		} as CertificateVerificationContext);

		if (!cacheEntry) {
			// This should not happen if the source is configured correctly
			// but handle it gracefully
			const failureMode = config?.failureMode ?? OCSP_DEFAULTS.failureMode;
			if (failureMode === 'fail-closed') {
				return { valid: false, status: 'error', error: 'Cache fetch failed', method: 'ocsp' };
			}

			logger.warn?.('OCSP cache fetch failed, allowing connection (fail-open mode)');
			return { valid: true, status: 'error-allowed', method: 'ocsp' };
		}

		const cached = cacheEntry as unknown as CertificateCacheEntry;
		const wasLoadedFromSource = (cacheEntry as any).wasLoadedFromSource?.();
		logger.trace?.(`OCSP ${wasLoadedFromSource ? 'source fetch' : 'cache hit'} for certificate`);

		return {
			valid: cached.status === 'good',
			status: cached.status,
			cached: !wasLoadedFromSource,
			method: cached.method || 'ocsp',
		};
	} catch (error) {
		logger.error?.(`OCSP verification error: ${error}`);

		// Check failure mode
		const failureMode = config?.failureMode ?? OCSP_DEFAULTS.failureMode;
		if (failureMode === 'fail-closed') {
			return { valid: false, status: 'error', error: (error as Error).message, method: 'ocsp' };
		}

		// Fail open - allow connection on OCSP errors
		logger.warn?.('OCSP check failed, allowing connection (fail-open mode)');
		return { valid: true, status: 'error-allowed', method: 'ocsp' };
	}
}

/**
 * Perform the actual OCSP check using easy-ocsp
 * @param certPem - Certificate in PEM format
 * @param issuerPem - Issuer certificate in PEM format
 * @param timeout - Timeout in milliseconds
 * @returns OCSP check result
 */
async function performOCSPCheck(certPem: string, issuerPem: string, timeout: number): Promise<OCSPCheckResult> {
	logger.trace?.(`Performing OCSP check with timeout: ${timeout}`);

	// Check if certificate contains OCSP URLs
	try {
		getCertURLs(certPem);
	} catch (urlError) {
		logger.debug?.(`Certificate does not contain OCSP URL: ${(urlError as Error).message}`);
		return { status: 'unknown', reason: 'no-ocsp-url' };
	}

	try {
		const response = await getCertStatus(certPem, { ca: issuerPem, timeout });
		logger.debug?.(`OCSP response: ${response.status}`);

		// Map response status to internal format
		switch (response.status) {
			case 'good':
				return { status: 'good' };
			case 'revoked':
				return { status: 'revoked', reason: response.revocationReason?.toString() || 'unspecified' };
			default:
				return { status: 'unknown', reason: 'unknown-status' };
		}
	} catch (error) {
		const err = error as Error;
		logger.debug?.(`OCSP check failed: ${err.message}`);

		// Return appropriate error based on type
		const reason = err.name === 'AbortError' ? 'timeout' : 'ocsp-error';
		return { status: 'unknown', reason };
	}
}
