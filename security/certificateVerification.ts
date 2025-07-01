/**
 * Certificate verification for mTLS authentication
 * 
 * This module provides certificate revocation checking for client certificates
 * in mutual TLS (mTLS) connections. Currently supports OCSP (Online Certificate
 * Status Protocol) with plans to add CRL (Certificate Revocation List) support.
 * Uses a system table, hdb_certificate_cache, for a certificate verification
 * status cache.
 * 
 * Default configuration:
 * - Enabled by default when mTLS is configured
 * - Timeout: 5 seconds
 * - Cache TTL: 1 hour
 * - Failure mode: fail-open (allows connections if verification fails)
 */

import { getCertStatus } from 'easy-ocsp';
import { loggerWithTag } from '../utility/logging/logger.js';
import { table } from '../resources/databases.js';
import { X509Certificate } from 'node:crypto';
import * as crypto from 'node:crypto';

const logger = loggerWithTag('cert-verification');

type CertificateStatus = 'good' | 'revoked' | 'unknown';

// Map to track pending OCSP requests to prevent duplicate checks within this thread.
// Each worker thread maintains its own map, so up to N threads may make the same
// OCSP request until one completes and populates the shared database cache.
const pendingOCSPRequests = new Map<string, Promise<CertificateVerificationResult>>();

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
	failureMode?: 'fail-open' | 'fail-closed';
}

// Default configuration values
const VERIFICATION_DEFAULTS: Required<CertificateVerificationConfig> = {
	timeout: 5000, // 5 seconds
	cacheTtl: 3600000, // 1 hour
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
	if (!mtlsConfig) return false;
	if (mtlsConfig === true) return {};
	
	const verificationConfig = mtlsConfig.certificateVerification;
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
	// Get the verification configuration from mtlsConfig
	const config = getCertificateVerificationConfig(mtlsConfig);
	
	// If config is false, verification is disabled
	if (config === false) {
		return { valid: true, status: 'disabled', method: 'disabled' };
	}
	
	// Extract certificate chain
	const certChain = extractCertificateChain(peerCertificate);
	
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
 * @returns Promise resolving to verification result
 */
export async function verifyOCSP(
	certPem: Buffer | string,
	issuerPem: Buffer | string,
	config?: CertificateVerificationConfig
): Promise<CertificateVerificationResult> {

	try {
		// Convert buffers to PEM strings if needed
		if (Buffer.isBuffer(certPem)) {
			certPem = bufferToPem(certPem, 'CERTIFICATE');
		}
		if (Buffer.isBuffer(issuerPem)) {
			issuerPem = bufferToPem(issuerPem, 'CERTIFICATE');
		}

		// Generate cache key from certificate
		const cacheKey = getCacheKey(certPem);
		
		// Check cache first
		const cacheTable = getCertificateCacheTable();
		const cached = await cacheTable.get(cacheKey) as unknown as CertificateCacheEntry | undefined;
		
		if (cached) {
			logger.trace?.(`OCSP cache hit for certificate ${cacheKey}`);
			return {
				valid: cached.status === 'good',
				status: cached.status,
				cached: true,
				method: cached.method || 'ocsp',
			};
		}

		// Check if there's already a pending OCSP request for this certificate
		const pendingRequest = pendingOCSPRequests.get(cacheKey);
		if (pendingRequest) {
			logger.debug?.(`OCSP check already in progress for certificate ${cacheKey}, waiting for result`);
			return pendingRequest;
		}

		// Perform OCSP check
		logger.debug?.(`Starting new OCSP check for certificate ${cacheKey}`);
		const timeout = config?.timeout ?? VERIFICATION_DEFAULTS.timeout;
		
		// Create a promise for this OCSP check and store it in the pending map
		const ocspPromise = (async (): Promise<CertificateVerificationResult> => {
			let verificationResult: CertificateVerificationResult;
			
			try {
				const result = await Promise.race([
					performOCSPCheck(certPem, issuerPem, timeout),
					new Promise<never>((_, reject) => 
						setTimeout(() => reject(new Error('OCSP timeout')), timeout)
					),
				]);

				// Extract the status for caching
				const { status, reason } = result;
				
				// Cache the result
				const ttl = config?.cacheTtl ?? VERIFICATION_DEFAULTS.cacheTtl;
				const cacheEntry: CertificateCacheEntry = {
					certificate_id: cacheKey,
					status,
					reason,
					checked_at: Date.now(),
					expiresAt: Date.now() + ttl,
					method: 'ocsp',
				};
				
				await cacheTable.put(cacheEntry.certificate_id, cacheEntry);

				verificationResult = {
					valid: status === 'good',
					status,
					cached: false,
					method: 'ocsp' as const,
				};
			} catch (error) {
				logger.error?.('OCSP verification error:', error);
				
				// Check failure mode
				const failureMode = config?.failureMode ?? VERIFICATION_DEFAULTS.failureMode;
				if (failureMode === 'fail-closed') {
					verificationResult = { valid: false, status: 'error', error: (error as Error).message, method: 'ocsp' };
				} else {
					// Fail open - allow connection on OCSP errors
					logger.warn?.('OCSP check failed, allowing connection (fail-open mode)');
					verificationResult = { valid: true, status: 'error-allowed', method: 'ocsp' };
				}
			} finally {
				// Always clean up the pending request
				pendingOCSPRequests.delete(cacheKey);
			}
			
			return verificationResult;
		})();
		
		// Store the promise in the pending map
		pendingOCSPRequests.set(cacheKey, ocspPromise);
		
		// Wait for and return the result
		return ocspPromise;

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
	const response = await getCertStatus(certPem, {
		ca: issuerPem,
		timeout,
	});

	// The response already has the correct structure
	if (response.status === 'good') {
		return { status: 'good' };
	} else if (response.status === 'revoked') {
		return {
			status: 'revoked',
			reason: response.revocationReason?.toString() || 'unspecified',
		};
	} else {
		return { status: 'unknown', reason: 'unknown-status' };
	}
}

/**
 * Generate a cache key from certificate
 * Uses serial number and issuer for uniqueness
 */
export function getCacheKey(certPem: string): string {
	try {
		const cert = new X509Certificate(certPem);
		// Use serial number and issuer hash as key
		const hash = crypto.createHash('sha256');
		hash.update(cert.serialNumber);
		hash.update(cert.issuer);
		return hash.digest('hex').substring(0, 16);
	} catch (error) {
		// Fallback to hashing the cert itself when certificate parsing fails
		logger.trace?.(`Failed to parse certificate for cache key: ${(error as Error).message}, using cert hash fallback`);
		return crypto.createHash('sha256').update(certPem).digest('hex').substring(0, 16);
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
	
	while (current && current.raw) {
		const entry: CertificateChainEntry = { cert: current.raw };
		
		// Get issuer if available and different from self
		if (current.issuerCertificate && 
			current.issuerCertificate !== current && 
			current.issuerCertificate.raw) {
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