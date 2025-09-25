/**
 * Shared TypeScript interfaces and types for certificate verification
 */

import type { Context } from '../../resources/ResourceInterface.ts';

export type CertificateStatus = 'good' | 'revoked' | 'unknown';

export type VerificationMethod = 'ocsp' | 'crl';
export type VerificationResultMethod = VerificationMethod | 'disabled';

export type FailureMode = 'fail-open' | 'fail-closed';

export interface PeerCertificate {
	subject?: {
		CN?: string;
		[key: string]: any;
	};
	raw?: Buffer;
	issuerCertificate?: PeerCertificate;
}

export interface CertificateVerificationResult {
	valid: boolean;
	status: string;
	cached?: boolean;
	error?: string;
	method?: VerificationResultMethod;
}

export interface CertificateCacheEntry {
	certificate_id: string;
	status: CertificateStatus;
	reason?: string;
	checked_at: number;
	expiresAt: number;
	method: VerificationMethod;
}

export interface CRLCacheEntry {
	crl_id: string;
	distribution_point: string;
	issuer_dn: string;
	crl_blob: Buffer;
	this_update: number;
	next_update: number;
	signature_valid: boolean;
	expiresAt: number;
}

export interface RevokedCertificateEntry {
	composite_id: string; // {issuer_hash}:{serial_number}
	serial_number: string;
	issuer_key_id: string;
	revocation_date: number;
	revocation_reason?: string;
	crl_source: string; // Links to CRLCacheEntry.crl_id
	crl_next_update: number;
	expiresAt: number;
}

export interface CertificateChainEntry {
	cert: Buffer;
	issuer?: Buffer;
}

export interface OCSPCheckResult {
	status: CertificateStatus;
	reason?: string;
}

export interface CRLCheckResult {
	status: CertificateStatus;
	reason?: string;
	source?: string; // CRL distribution point URL
}

// Configuration interfaces
export interface OCSPConfig {
	enabled?: boolean;
	timeout?: number;
	cacheTtl?: number;
	errorCacheTtl?: number;
	failureMode?: FailureMode;
}

export interface CRLConfig {
	enabled?: boolean;
	timeout?: number;
	cacheTtl?: number;
	failureMode?: FailureMode;
	gracePeriod?: number;
}

export interface CertificateVerificationConfig {
	failureMode?: FailureMode;
	ocsp?: OCSPConfig;
	crl?: CRLConfig;
}

// Context types for certificate verification cache requests
export interface CertificateVerificationContext extends Context {
	certPem: string;
	issuerPem: string;
	config?: CertificateVerificationConfig;
}

export interface CRLVerificationContext extends Context {
	distributionPoint: string;
	issuerPem: string;
	config?: CRLConfig;
}

// Default configuration values
export interface VerificationDefaults {
	timeout: number;
	cacheTtl: number;
	failureMode: FailureMode;
}

export interface OCSPDefaults extends VerificationDefaults {
	errorCacheTtl: number;
}

export interface CRLDefaults extends VerificationDefaults {
	gracePeriod: number;
}
