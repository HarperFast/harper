/**
 * Certificate verification for mTLS authentication
 *
 * This module provides certificate revocation checking for client certificates
 * in mutual TLS (mTLS) connections. Currently supports OCSP (Online Certificate
 * Status Protocol) with the ability to add CRL (Certificate Revocation List) support.
 * Uses a system table, hdb_certificate_cache, for a certificate verification
 * status cache.
 *
 * Default configuration:
 * - Enabled by default when mTLS is configured
 * - Timeout: 5 seconds
 * - Cache TTL: 1 hour (success results)
 * - Error Cache TTL: 5 minutes (error results, for faster recovery)
 * - Failure mode: fail-open (allows connections if verification fails)
 */

// Apply PKI.js Ed25519 patch before importing easy-ocsp
import './pkijs-ed25519-patch.ts';
import { getCertStatus, getCertURLs } from 'easy-ocsp';
import { createHash } from 'node:crypto';
import { loggerWithTag } from '../utility/logging/logger.js';
import { table } from '../resources/databases.ts';
import { Resource } from '../resources/Resource.ts';
import type { SourceContext, Context } from '../resources/ResourceInterface.ts';

const logger = loggerWithTag('cert-verification');

type CertificateStatus = 'good' | 'revoked' | 'unknown';

// Context type for certificate verification cache requests
interface CertificateVerificationContext extends Context {
	certPem: string;
	issuerPem: string;
	config?: {
		timeout?: number;
		cacheTtl?: number;
		errorCacheTtl?: number;
		failureMode?: 'fail-open' | 'fail-closed';
	};
}

// Certificate Verification Source class that extends Resource
class CertificateVerificationSource extends Resource {
	async get(id: string) {
		logger.debug?.('CertificateVerificationSource.get called for:', id);

		// Get the certificate data from requestContext
		const context = this.getContext() as SourceContext<CertificateVerificationContext>;
		const requestContext = context?.requestContext;

		if (!requestContext || !requestContext.certPem || !requestContext.issuerPem) {
			throw new Error(`No certificate data provided for cache key: ${id}`);
		}

		const { certPem, issuerPem, config } = requestContext;
		logger.trace?.('Performing OCSP check with config:', config);

		try {
			const timeout = config?.timeout ?? VERIFICATION_DEFAULTS.timeout;

			const result = await Promise.race([
				performOCSPCheck(certPem, issuerPem, timeout),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error('OCSP timeout')), timeout)),
			]);

			logger.debug?.('OCSP check result:', result);

			// Check if the result indicates an error (for fail-open/fail-closed handling)
			const isError =
				result.status === 'unknown' &&
				(result.reason === 'ocsp-error' || result.reason === 'timeout' || result.reason === 'no-ocsp-url');

			if (isError) {
				// Handle as an error for fail-open/fail-closed logic
				const failureMode = config?.failureMode ?? VERIFICATION_DEFAULTS.failureMode;
				logger.error?.('OCSP check failed:', result.reason);

				if (failureMode === 'fail-closed') {
					// Return an error status that will be cached using error TTL
					const errorTtl = config?.errorCacheTtl ?? VERIFICATION_DEFAULTS.errorCacheTtl;
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
			const ttl = config?.cacheTtl ?? VERIFICATION_DEFAULTS.cacheTtl;
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
			logger.error?.('OCSP verification error:', error);

			// Check failure mode
			const failureMode = config?.failureMode ?? VERIFICATION_DEFAULTS.failureMode;
			if (failureMode === 'fail-closed') {
				// Return an error status that will be cached using error TTL
				const errorTtl = config?.errorCacheTtl ?? VERIFICATION_DEFAULTS.errorCacheTtl;
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

interface CertificateCacheEntry {
	certificate_id: string;
	status: CertificateStatus;
	reason?: string;
	checked_at: number;
	expiresAt: number;
	method: 'ocsp' | 'crl';
}

interface CertificateVerificationResult {
	valid: boolean;
	status: string;
	cached?: boolean;
	error?: string;
	method?: 'ocsp' | 'crl' | 'disabled';
}

interface PeerCertificate {
	subject?: {
		CN?: string;
		[key: string]: any;
	};
	raw?: Buffer;
	issuerCertificate?: PeerCertificate;
}

interface OCSPCheckResult {
	status: CertificateStatus;
	reason?: string;
}

interface CertificateVerificationConfig {
	timeout?: number;
	cacheTtl?: number;
	errorCacheTtl?: number;
	failureMode?: 'fail-open' | 'fail-closed';
}

// Default configuration values
const VERIFICATION_DEFAULTS: Required<CertificateVerificationConfig> = {
	timeout: 5000, // 5 seconds
	cacheTtl: 3600000, // 1 hour
	errorCacheTtl: 300000, // 5 minutes (shorter for faster recovery)
	failureMode: 'fail-open',
};

interface CertificateChainEntry {
	cert: Buffer;
	issuer?: Buffer;
}

// Lazy-load the certificate verification cache table
let certCacheTable: ReturnType<typeof table>;
function getCertificateCacheTable() {
	if (!certCacheTable) {
		certCacheTable = table({
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

		// Configure the caching source using CertificateVerificationSource class
		(certCacheTable as any).sourcedFrom(CertificateVerificationSource);
	}
	return certCacheTable;
}

/**
 * Determine if certificate verification should be performed based on configuration
 * @param mtlsConfig - The mTLS configuration (can be boolean or object)
 * @returns Configuration object or false if verification is disabled
 */
export function getCertificateVerificationConfig(
	mtlsConfig: boolean | Record<string, any> | null | undefined
): false | CertificateVerificationConfig {
	logger.trace?.('getCertificateVerificationConfig called with:', { mtlsConfig });

	if (!mtlsConfig) return false;
	if (mtlsConfig === true) {
		logger.debug?.('mTLS enabled with default certificate verification');
		return {};
	}

	const verificationConfig = mtlsConfig.certificateVerification;
	logger.trace?.('Certificate verification config:', { verificationConfig });

	if (verificationConfig == null) return {}; // Default to enabled
	if (verificationConfig === false) return false;

	// Return empty object for true, otherwise return the config object
	return verificationConfig === true ? {} : verificationConfig;
}

/**
 * Verify certificate revocation status
 * @param peerCertificate - Peer certificate object from TLS connection
 * @param mtlsConfig - The mTLS configuration from the request
 * @returns Promise resolving to verification result
 */
export async function verifyCertificate(
	peerCertificate: PeerCertificate,
	mtlsConfig?: boolean | Record<string, any> | null
): Promise<CertificateVerificationResult> {
	logger.debug?.('verifyCertificate called for:', peerCertificate.subject?.CN || 'unknown');

	// Get the verification configuration from mtlsConfig
	const config = getCertificateVerificationConfig(mtlsConfig);

	// If config is false, verification is disabled
	if (config === false) {
		logger.debug?.('Certificate verification disabled');
		return { valid: true, status: 'disabled', method: 'disabled' };
	}

	// Extract certificate chain
	const certChain = extractCertificateChain(peerCertificate);
	logger.trace?.('Certificate chain length:', certChain.length);

	// Check if we have sufficient chain for OCSP verification
	if (certChain.length === 1 && !certChain[0].issuer) {
		logger.debug?.('Certificate without issuer - cannot perform OCSP check');
		return { valid: true, status: 'no-issuer-cert', method: 'disabled' };
	}

	// Need at least certificate and issuer for OCSP
	if (certChain.length < 2 || !certChain[0].issuer) {
		logger.debug?.('Certificate chain too short for revocation checking');
		return { valid: true, status: 'insufficient-chain', method: 'disabled' };
	}

	return verifyOCSP(certChain[0].cert, certChain[0].issuer, config);
}

/**
 * Verify OCSP status of a client certificate
 * @param certPem - Client certificate in PEM format or Buffer
 * @param issuerPem - Issuer (CA) certificate in PEM format or Buffer
 * @param config - Optional configuration object
 * @param config.timeout - OCSP request timeout in milliseconds (default: 5000)
 * @param config.cacheTtl - Cache TTL for successful results in milliseconds (default: 3600000)
 * @param config.errorCacheTtl - Cache TTL for error results in milliseconds (default: 300000)
 * @param config.failureMode - How to handle OCSP failures: 'fail-open' | 'fail-closed' (default: 'fail-open')
 * @returns Promise resolving to verification result
 */
export async function verifyOCSP(
	certPem: Buffer | string,
	issuerPem: Buffer | string,
	config?: CertificateVerificationConfig
): Promise<CertificateVerificationResult> {
	logger.debug?.('verifyOCSP called');

	try {
		// Convert buffers to PEM strings if needed
		if (Buffer.isBuffer(certPem)) {
			certPem = bufferToPem(certPem, 'CERTIFICATE');
		}
		if (Buffer.isBuffer(issuerPem)) {
			issuerPem = bufferToPem(issuerPem, 'CERTIFICATE');
		}

		// Create a cache key that includes all verification parameters
		// Use a hash to keep the key size small (primary key limit is 4KB)
		const cacheData = {
			certPem,
			issuerPem,
			method: 'ocsp',
		};
		const cacheKeyHash = createHash('sha256').update(JSON.stringify(cacheData)).digest('hex');
		// Prefix with method for clarity in cache table
		const cacheKey = `ocsp:${cacheKeyHash}`;
		logger.trace?.('OCSP cache key:', cacheKey);

		// Get the cache table - Harper will automatically handle
		// concurrent requests and cache stampede prevention
		const cacheTable = getCertificateCacheTable();

		// Pass certificate data as context - Harper will make it available as requestContext in the source
		const cacheEntry = await cacheTable.get(cacheKey, {
			certPem,
			issuerPem,
			config: config || {},
		} as CertificateVerificationContext);

		if (!cacheEntry) {
			// This should not happen if the source is configured correctly
			// but handle it gracefully
			const failureMode = config?.failureMode ?? VERIFICATION_DEFAULTS.failureMode;
			if (failureMode === 'fail-closed') {
				return { valid: false, status: 'error', error: 'Cache fetch failed', method: 'ocsp' };
			} else {
				logger.warn?.('OCSP cache fetch failed, allowing connection (fail-open mode)');
				return { valid: true, status: 'error-allowed', method: 'ocsp' };
			}
		}

		const cached = cacheEntry as unknown as CertificateCacheEntry;
		const wasLoadedFromSource = (cacheEntry as any).wasLoadedFromSource?.();
		logger.trace?.(`OCSP ${wasLoadedFromSource ? 'source fetch' : 'cache hit'} for certificate`);

		// Apply fail-open/fail-closed logic for fresh error results
		const isErrorResult =
			cached.status === 'unknown' &&
			wasLoadedFromSource &&
			(cached.reason === 'ocsp-error' || cached.reason === 'timeout' || cached.reason === 'OCSP timeout');

		if (isErrorResult) {
			const failureMode = config?.failureMode ?? VERIFICATION_DEFAULTS.failureMode;
			const isFailClosed = failureMode === 'fail-closed';

			if (!isFailClosed) {
				logger.warn?.('OCSP check failed, allowing connection (fail-open mode)');
			}

			return {
				valid: !isFailClosed,
				status: isFailClosed ? cached.status : 'error-allowed',
				cached: !wasLoadedFromSource,
				method: cached.method || 'ocsp',
			};
		}

		return {
			valid: cached.status === 'good',
			status: cached.status,
			cached: !wasLoadedFromSource,
			method: cached.method || 'ocsp',
		};
	} catch (error) {
		logger.error?.('OCSP verification error:', error);

		// Check failure mode
		const failureMode = config?.failureMode ?? VERIFICATION_DEFAULTS.failureMode;
		if (failureMode === 'fail-closed') {
			return { valid: false, status: 'error', error: (error as Error).message, method: 'ocsp' };
		} else {
			// Fail open - allow connection on OCSP errors
			logger.warn?.('OCSP check failed, allowing connection (fail-open mode)');
			return { valid: true, status: 'error-allowed', method: 'ocsp' };
		}
	}
}

/**
 * Perform the actual OCSP check using easy-ocsp
 */
async function performOCSPCheck(certPem: string, issuerPem: string, timeout: number): Promise<OCSPCheckResult> {
	logger.trace?.('Performing OCSP check with timeout:', timeout);

	// Check if certificate contains OCSP URLs
	try {
		getCertURLs(certPem);
	} catch (urlError) {
		logger.debug?.('Certificate does not contain OCSP URL:', (urlError as Error).message);
		return { status: 'unknown', reason: 'no-ocsp-url' };
	}

	try {
		const response = await getCertStatus(certPem, { ca: issuerPem, timeout });
		logger.debug?.('OCSP response:', response.status);

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
		logger.debug?.('OCSP check failed:', err.message);

		// Return appropriate error based on type
		const reason = err.name === 'AbortError' ? 'timeout' : 'ocsp-error';
		return { status: 'unknown', reason };
	}
}

/**
 * Set TTL configuration for the certificate cache
 * @param ttlConfig - Configuration for cache expiration and eviction
 */
export function setCertificateCacheTTL(ttlConfig: {
	expiration: number; // Time until stale (seconds) - required
	eviction?: number; // Time until removed (seconds)
	scanInterval?: number; // Cleanup interval (seconds)
}) {
	const cacheTable = getCertificateCacheTable();
	if (cacheTable.setTTLExpiration) {
		cacheTable.setTTLExpiration(ttlConfig);
	}
}

/**
 * Convert a buffer to PEM format
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
 * @returns Certificate chain
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
