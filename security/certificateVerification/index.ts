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
 * - Certificate verification: disabled (must be explicitly enabled)
 * - Verification approach: CRL-first (with OCSP fallback)
 * - CRL timeout: 10 seconds, cache TTL: 24 hours
 * - OCSP timeout: 5 seconds, cache TTL: 1 hour
 * - Failure mode: fail-closed (rejects connections if verification fails)
 */

import { loggerWithTag } from '../../utility/logging/logger.ts';
import { extractCertificateChain, extractRevocationUrls, bufferToPem } from './verificationUtils.ts';
import { getCachedCertificateVerificationConfig } from './verificationConfig.ts';
import { verifyOCSP } from './ocspVerification.ts';
import { verifyCRL } from './crlVerification.ts';
import { resolveTrustedIssuer } from './trustedIssuers.ts';
import type { PeerCertificate, CertificateVerificationResult, FailureMode } from './types.ts';

const logger = loggerWithTag('cert-verification');

const warnedUnresolvedLeaves = new Set<string>();
const MAX_WARNED_LEAVES = 10_000;

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

	// ahead of the chain check so an explicitly disabled control can never reject
	if (config.crl.enabled === false && config.ocsp.enabled === false) {
		logger.debug?.('Both CRL and OCSP disabled - verification disabled');
		return { valid: true, status: 'disabled', method: 'disabled' };
	}

	// Extract certificate chain
	const certChain = extractCertificateChain(peerCertificate);
	logger.trace?.(`Certificate chain length: ${certChain.length}`);

	if (certChain.length === 0) {
		return unresolvedIssuerResult(config.failureMode, peerCertificate, 'no certificate data');
	}
	// Revocation checking needs the issuer. The socket omits it on every resumed TLS session and on
	// Node 26.8.0/26.8.1 (nodejs/node#65579); recover it from the CA set that authorized the client.
	if (!certChain[0].issuer) {
		const issuer = resolveTrustedIssuer(certChain[0].cert, peerCertificate.fingerprint256);
		if (!issuer) {
			return unresolvedIssuerResult(
				config.failureMode,
				peerCertificate,
				'issuer is neither in the presented chain nor among the configured certificate authorities'
			);
		}
		logger.debug?.('Issuer certificate resolved from the configured certificate authorities');
		certChain[0].issuer = issuer;
	}

	// Extract certificate revocation URLs in single parse operation
	const certPem = bufferToPem(certChain[0].cert, 'CERTIFICATE');
	const { crlUrls, ocspUrls } = extractRevocationUrls(certPem);

	logger.debug?.(`Certificate extensions: CRL distribution points=${crlUrls.length}, OCSP URLs=${ocspUrls.length}`);

	// Try CRL first (can provide definitive results)
	if (crlUrls.length > 0) {
		if (config.crl.enabled) {
			try {
				logger.debug?.('Attempting CRL verification');
				const result = await verifyCRL(certChain[0].cert, certChain[0].issuer, config.crl, crlUrls);

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
		if (config.ocsp.enabled) {
			try {
				logger.debug?.('Attempting OCSP verification');
				const result = await verifyOCSP(certChain[0].cert, certChain[0].issuer, config.ocsp, ocspUrls);

				// Return on definitive result (good or revoked); fall through for inconclusive
				// so the failureMode logic below applies (same pattern as CRL)
				if (result.status === 'good' || result.status === 'revoked') {
					logger.debug?.(`OCSP verification result: ${result.status}`);
					return result;
				}

				logger.debug?.(`OCSP verification inconclusive: ${result.status}, applying failure mode`);
			} catch (error) {
				logger.warn?.(`OCSP verification failed: ${error}`);
			}
		} else {
			logger.debug?.('Skipping OCSP - disabled in configuration');
		}
	} else {
		logger.debug?.('Skipping OCSP - no responder URLs in certificate');
	}

	// All methods tried or skipped - apply failure mode
	if (config.failureMode === 'fail-closed') {
		return { valid: false, status: 'no-verification-available', method: 'disabled' };
	}

	return { valid: true, status: 'verification-unavailable-allowed', method: 'disabled' };
}

/**
 * Revocation status cannot be established without the issuer, so the configured failure mode
 * decides: refuse under fail-closed, allow under fail-open. Either way this is a security control
 * not running, so it is logged at warn (once per certificate) rather than debug.
 */
function unresolvedIssuerResult(
	failureMode: FailureMode | undefined,
	peerCertificate: PeerCertificate,
	reason: string
): CertificateVerificationResult {
	const valid = failureMode !== 'fail-closed';
	const leafKey = peerCertificate.fingerprint256 ?? peerCertificate.subject?.CN ?? '';
	if (!warnedUnresolvedLeaves.has(leafKey)) {
		if (warnedUnresolvedLeaves.size >= MAX_WARNED_LEAVES) warnedUnresolvedLeaves.clear();
		warnedUnresolvedLeaves.add(leafKey);
		logger.warn?.(
			`Cannot check revocation status for client certificate ${peerCertificate.subject?.CN ?? 'unknown'}: ${reason}; ${
				valid ? 'allowing connection (fail-open)' : 'rejecting connection (fail-closed)'
			}`
		);
	} else {
		logger.debug?.(`Cannot check revocation status for ${peerCertificate.subject?.CN ?? 'unknown'}: ${reason}`);
	}
	return { valid, status: 'no-issuer-cert', method: 'disabled' };
}
