/**
 * OCSP (Online Certificate Status Protocol) verification
 */

// Apply PKI.js Ed25519 patch before importing easy-ocsp
import './pkijs-ed25519-patch.ts';
import { getCertStatus } from 'easy-ocsp';
import { loggerWithTag } from '../../utility/logging/logger.js';
import {
	bufferToPem,
	createCacheKey,
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

// Import the shared source
import { CertificateVerificationSource } from './certificateVerificationSource.ts';

// Lazy-load the certificate verification cache table
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
 * Verify OCSP status of a client certificate
 * @param certPem - Client certificate as Buffer (DER format)
 * @param issuerPem - Issuer (CA) certificate as Buffer (DER format)
 * @param config - OCSP configuration
 * @param ocspUrls - Optional pre-extracted OCSP responder URLs (avoids re-parsing)
 * @returns Promise resolving to verification result
 */
export async function verifyOCSP(
	certPem: Buffer,
	issuerPem: Buffer,
	config?: OCSPConfig,
	ocspUrls?: string[]
): Promise<CertificateVerificationResult> {
	logger.debug?.('verifyOCSP called');

	// Check if OCSP verification is disabled
	if (config?.enabled === false) {
		logger.debug?.('OCSP verification is disabled, allowing certificate');
		return { valid: true, status: 'disabled', method: 'disabled' };
	}

	try {
		// Convert DER buffers to PEM strings for certificate parsing libraries
		// PKI.js and easy-ocsp expect PEM format for extension extraction and OCSP requests
		const certPemStr = bufferToPem(certPem, 'CERTIFICATE');
		const issuerPemStr = bufferToPem(issuerPem, 'CERTIFICATE');

		// Create a cache key that includes all verification parameters
		const cacheKey = createCacheKey(certPemStr, issuerPemStr, 'ocsp');
		logger.trace?.(`OCSP cache key: ${cacheKey}`);

		// Get the cache table - Harper will automatically handle
		// concurrent requests and cache stampede prevention
		// Pass certificate data as context - Harper will make it available as requestContext in the source
		const cacheEntry = await getCertificateCacheTable().get(cacheKey, {
			certPem: certPemStr,
			issuerPem: issuerPemStr,
			ocspUrls,
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
 * @param config - OCSP configuration
 * @param ocspUrls - Optional pre-extracted OCSP responder URLs (avoids re-parsing)
 * @returns OCSP check result
 */
export async function performOCSPCheck(certPem: string, issuerPem: string, config: any, ocspUrls?: string[]): Promise<OCSPCheckResult> {
	const timeout = config?.timeout ?? OCSP_DEFAULTS.timeout;
	logger.debug?.(`Performing OCSP check with timeout: ${timeout}`);
	logger.debug?.(`Client certificate length: ${certPem.length}, Issuer certificate length: ${issuerPem.length}`);
	logger.debug?.(`Client cert start: ${certPem.substring(0, 50)}...`);
	logger.debug?.(`Issuer cert start: ${issuerPem.substring(0, 50)}...`);

	try {
		logger.debug?.(`Calling getCertStatus with timeout: ${timeout}${ocspUrls?.length ? `, using provided URL: ${ocspUrls[0]}` : ''}`);
		const response = await getCertStatus(certPem, {
			ca: issuerPem,
			timeout,
			...(ocspUrls?.length && { ocspUrl: ocspUrls[0] })
		});
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
		logger.debug?.(`Error stack: ${err.stack}`);

		// Return appropriate error based on type
		const reason = err.name === 'AbortError' ? 'timeout' : 'ocsp-error';
		return { status: 'unknown', reason };
	}
}
