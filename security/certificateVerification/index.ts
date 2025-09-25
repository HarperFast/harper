/**
 * Certificate verification for mTLS authentication
 *
 * This module provides certificate revocation checking for client certificates
 * in mutual TLS (mTLS) connections. Supports both OCSP (Online Certificate
 * Status Protocol) and CRL (Certificate Revocation List) verification methods
 * with automatic method selection.
 *
 * Features:
 * - OCSP verification with caching
 * - CRL verification with caching
 * - CRL-first with OCSP fallback for optimal performance
 * - Background CRL refresh with exponential backoff
 * - Graceful degradation during network outages
 * - Ed25519/Ed448 certificate support
 *
 * Default behavior:
 * - Verification approach: CRL-first (with OCSP fallback)
 * - CRL timeout: 10 seconds, cache TTL: 24 hours
 * - OCSP timeout: 5 seconds, cache TTL: 1 hour
 * - Failure mode: fail-open (allows connections if verification fails)
 */

import { loggerWithTag } from '../../utility/logging/logger.js';
import { extractCertificateChain, extractRevocationUrls, bufferToPem } from './verificationUtils.ts';
import { getCachedCertificateVerificationConfig, getOCSPConfig, getCRLConfig } from './verificationConfig.ts';
import { verifyOCSP } from './ocspVerification.ts';
import { verifyCRL } from './crlVerification.ts';
import type { PeerCertificate, CertificateVerificationResult } from './types.ts';

const logger = loggerWithTag('cert-verification');

/**
 * Verify certificate revocation status using OCSP and/or CRL
 * @param peerCertificate - Peer certificate object from TLS connection
 * @param mtlsConfig - The mTLS configuration from the request
 * @returns Promise resolving to verification result
 */
export async function verifyCertificate(
	peerCertificate: PeerCertificate,
	mtlsConfig?: boolean | Record<string, any> | null
): Promise<CertificateVerificationResult> {
	logger.debug?.(`verifyCertificate called for: ${peerCertificate.subject?.CN || 'unknown'}`);

	// Get the verification configuration from mtlsConfig (cached for performance)
	const config = getCachedCertificateVerificationConfig(mtlsConfig);

	// If config is false, verification is disabled
	if (config === false) {
		logger.debug?.('Certificate verification disabled');
		return { valid: true, status: 'disabled', method: 'disabled' };
	}

	// Extract certificate chain
	const certChain = extractCertificateChain(peerCertificate);
	logger.trace?.(`Certificate chain length: ${certChain.length}`);

	// Check if we have sufficient chain for verification (need certificate and issuer)
	if (certChain.length < 2 || !certChain[0].issuer) {
		logger.debug?.('Certificate chain insufficient for revocation checking - need certificate and issuer');
		return { valid: true, status: 'no-issuer-cert', method: 'disabled' };
	}

	// Extract certificate revocation URLs in single parse operation
	const certPem = bufferToPem(certChain[0].cert, 'CERTIFICATE');
	const { crlUrls, ocspUrls } = extractRevocationUrls(certPem);

	logger.debug?.(`Certificate extensions: CRL distribution points=${crlUrls.length}, OCSP URLs=${ocspUrls.length}`);

	// Try CRL first (can provide definitive results)
	if (crlUrls.length > 0) {
		const crlConfig = getCRLConfig(config);
		if (crlConfig.enabled) {
			try {
				logger.debug?.('Attempting CRL verification');
				const result = await verifyCRL(certChain[0].cert, certChain[0].issuer, crlConfig);

				// Return on definitive result (good or revoked)
				if (result.status === 'good' || result.status === 'revoked') {
					logger.debug?.(`CRL verification result: ${result.status}`);
					return result;
				}

				logger.debug?.(`CRL verification inconclusive: ${result.status}, trying OCSP fallback`);
			} catch (error) {
				logger.warn?.(`CRL verification failed: ${error}`);
			}
		} else {
			logger.debug?.('Skipping CRL - disabled in configuration');
		}
	} else {
		logger.debug?.('Skipping CRL - no distribution points in certificate');
	}

	// Fall back to OCSP if available (real-time status)
	if (ocspUrls.length > 0) {
		const ocspConfig = getOCSPConfig(config);
		if (ocspConfig.enabled) {
			try {
				logger.debug?.('Attempting OCSP verification');
				const result = await verifyOCSP(certChain[0].cert, certChain[0].issuer, ocspConfig, ocspUrls);

				// Return result (definitive or not)
				logger.debug?.(`OCSP verification result: ${result.status}`);
				return result;
			} catch (error) {
				logger.warn?.(`OCSP verification failed: ${error}`);
			}
		} else {
			logger.debug?.('Skipping OCSP - disabled in configuration');
		}
	} else {
		logger.debug?.('Skipping OCSP - no responder URLs in certificate');
	}

	// All methods tried or skipped - determine failure handling
	logger.warn?.('No verification method provided definitive result');

	if (config.failureMode === 'fail-closed') {
		return { valid: false, status: 'no-verification-available', method: 'disabled' };
	}

	return { valid: true, status: 'verification-unavailable-allowed', method: 'disabled' };
}
