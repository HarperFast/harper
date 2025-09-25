/**
 * Configuration parsing and default values for certificate verification
 */

import { loggerWithTag } from '../../utility/logging/logger.js';
import { packageJson } from '../../utility/packageUtils.js';
import type { CertificateVerificationConfig, OCSPConfig, CRLConfig, OCSPDefaults, CRLDefaults } from './types.ts';

const logger = loggerWithTag('cert-verification-config');

// Constants for hardcoded values
export const CRL_DEFAULT_VALIDITY_PERIOD = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
export const ERROR_CACHE_TTL = 300000; // 5 minutes for error caching
export const CRL_USER_AGENT = `Harper/${packageJson.version} CRL-Client`;

// Configuration cache to avoid redundant parsing on every certificate verification
// Using WeakMap to prevent memory leaks from holding strong references to config objects
// This allows garbage collection of config objects when they're no longer referenced elsewhere
const configCache = new WeakMap<Record<string, any>, CertificateVerificationConfig | false>();
let lastPrimitiveConfig: boolean | null | undefined = null;
let lastPrimitiveResult: CertificateVerificationConfig | false | null = null;

// Default configuration values for OCSP
export const OCSP_DEFAULTS: OCSPDefaults = {
	timeout: 5000, // 5 seconds
	cacheTtl: 3600000, // 1 hour
	errorCacheTtl: 300000, // 5 minutes (shorter for faster recovery)
	failureMode: 'fail-open',
};

// Default configuration values for CRL
export const CRL_DEFAULTS: CRLDefaults = {
	timeout: 10000, // 10 seconds
	cacheTtl: 86400000, // 24 hours
	failureMode: 'fail-open',
	gracePeriod: 86400000, // 24 hours after nextUpdate
};

/**
 * Cached version of getCertificateVerificationConfig to avoid redundant parsing
 * This is the recommended function to use in hot paths like certificate verification.
 *
 * MEMORY SAFETY:
 * - Uses WeakMap for object configs to prevent memory leaks
 * - Config objects can be garbage collected when no longer referenced elsewhere
 * - Primitive values (boolean, null, undefined) use simple reference equality
 * - No strong references held to config objects, preventing memory accumulation
 *
 * @param mtlsConfig - The mTLS configuration from env.get()
 * @returns Configuration object or false if verification is disabled
 */
export function getCachedCertificateVerificationConfig(
	mtlsConfig?: boolean | Record<string, any> | null
): false | CertificateVerificationConfig {
	// Handle primitive values (boolean, null, undefined) with simple caching
	if (typeof mtlsConfig === 'boolean' || mtlsConfig == null) {
		if (mtlsConfig === lastPrimitiveConfig && lastPrimitiveResult !== null) {
			logger.trace?.('Using cached certificate verification config (primitive)');
			return lastPrimitiveResult;
		}

		logger.trace?.('Parsing and caching certificate verification config (primitive)');
		lastPrimitiveConfig = mtlsConfig as boolean | null | undefined;
		lastPrimitiveResult = getCertificateVerificationConfig(mtlsConfig);
		return lastPrimitiveResult;
	}

	const cached = configCache.get(mtlsConfig);
	if (cached !== undefined) {
		logger.trace?.('Using cached certificate verification config (object)');
		return cached;
	}

	// Cache miss: parse and store the result
	logger.trace?.('Parsing and caching certificate verification config (object)');
	const result = getCertificateVerificationConfig(mtlsConfig);
	configCache.set(mtlsConfig, result);
	return result;
}

/**
 * Determine if certificate verification should be performed based on configuration
 * @param mtlsConfig - The mTLS configuration (can be boolean or object)
 * @returns Configuration object or false if verification is disabled
 */
function getCertificateVerificationConfig(
	mtlsConfig?: boolean | Record<string, any> | null
): false | CertificateVerificationConfig {
	logger.trace?.(`getCertificateVerificationConfig called with: ${JSON.stringify({ mtlsConfig })}`);

	if (!mtlsConfig) return false;
	if (mtlsConfig === true) {
		logger.debug?.('mTLS enabled with default certificate verification');
		return {
			failureMode: CRL_DEFAULTS.failureMode,
		};
	}

	const verificationConfig = mtlsConfig.certificateVerification;
	logger.trace?.(`Certificate verification config: ${JSON.stringify({ verificationConfig })}`);

	if (verificationConfig == null) {
		// Default to enabled
		return {
			failureMode: CRL_DEFAULTS.failureMode,
		};
	}
	if (verificationConfig === false) return false;

	// Return config object for true, otherwise return the parsed config object
	if (verificationConfig === true) {
		return {
			failureMode: CRL_DEFAULTS.failureMode,
		};
	}

	return parseVerificationConfig(verificationConfig);
}

/**
 * Parse and validate the certificate verification configuration
 * @param config - Raw configuration object
 * @returns Parsed and validated configuration
 */
function parseVerificationConfig(config: Record<string, any>): CertificateVerificationConfig {
	const parsed: CertificateVerificationConfig = {
		failureMode: config.failureMode ?? CRL_DEFAULTS.failureMode,
	};

	// Parse OCSP configuration
	if (config.ocsp !== undefined) {
		parsed.ocsp = parseOCSPConfig(config.ocsp);
	}

	// Parse CRL configuration
	if (config.crl !== undefined) {
		parsed.crl = parseCRLConfig(config.crl);
	}

	// Validate global failure mode
	if (parsed.failureMode && !['fail-open', 'fail-closed'].includes(parsed.failureMode)) {
		logger.warn?.(`Invalid failureMode: ${parsed.failureMode}, using default: ${CRL_DEFAULTS.failureMode}`);
		parsed.failureMode = CRL_DEFAULTS.failureMode;
	}

	return parsed;
}

/**
 * Parse OCSP-specific configuration
 * @param ocspConfig - OCSP configuration object or boolean
 * @returns Parsed OCSP configuration
 */
function parseOCSPConfig(ocspConfig: boolean | Record<string, any>): OCSPConfig {
	if (ocspConfig === false) {
		return { enabled: false };
	}

	if (ocspConfig === true || ocspConfig == null) {
		return {
			enabled: true,
			timeout: OCSP_DEFAULTS.timeout,
			cacheTtl: OCSP_DEFAULTS.cacheTtl,
			failureMode: OCSP_DEFAULTS.failureMode,
		};
	}

	return {
		enabled: ocspConfig.enabled !== false, // Default to enabled unless explicitly disabled
		timeout: ocspConfig.timeout ?? OCSP_DEFAULTS.timeout,
		cacheTtl: ocspConfig.cacheTtl ?? OCSP_DEFAULTS.cacheTtl,
		failureMode: ocspConfig.failureMode ?? OCSP_DEFAULTS.failureMode,
	};
}

/**
 * Parse CRL-specific configuration
 * @param crlConfig - CRL configuration object or boolean
 * @returns Parsed CRL configuration
 */
function parseCRLConfig(crlConfig: boolean | Record<string, any>): CRLConfig {
	if (crlConfig === false) {
		return { enabled: false };
	}

	if (crlConfig === true || crlConfig == null) {
		return {
			enabled: true,
			timeout: CRL_DEFAULTS.timeout,
			cacheTtl: CRL_DEFAULTS.cacheTtl,
			failureMode: CRL_DEFAULTS.failureMode,
			gracePeriod: CRL_DEFAULTS.gracePeriod,
		};
	}

	return {
		enabled: crlConfig.enabled !== false, // Default to enabled unless explicitly disabled
		timeout: crlConfig.timeout ?? CRL_DEFAULTS.timeout,
		cacheTtl: crlConfig.cacheTtl ?? CRL_DEFAULTS.cacheTtl,
		failureMode: crlConfig.failureMode ?? CRL_DEFAULTS.failureMode,
		gracePeriod: crlConfig.gracePeriod ?? CRL_DEFAULTS.gracePeriod,
	};
}

/**
 * Get the effective OCSP configuration with defaults applied
 * @param config - Certificate verification configuration
 * @returns OCSP configuration with defaults
 */
export function getOCSPConfig(config?: CertificateVerificationConfig): OCSPConfig {
	if (!config?.ocsp) {
		return {
			enabled: true,
			timeout: OCSP_DEFAULTS.timeout,
			cacheTtl: OCSP_DEFAULTS.cacheTtl,
			failureMode: config?.failureMode ?? OCSP_DEFAULTS.failureMode,
		};
	}

	return {
		...config.ocsp,
		failureMode: config.ocsp.failureMode ?? config.failureMode ?? OCSP_DEFAULTS.failureMode,
	};
}

/**
 * Get the effective CRL configuration with defaults applied
 * @param config - Certificate verification configuration
 * @returns CRL configuration with defaults
 */
export function getCRLConfig(config?: CertificateVerificationConfig): CRLConfig {
	if (!config?.crl) {
		return {
			enabled: true,
			timeout: CRL_DEFAULTS.timeout,
			cacheTtl: CRL_DEFAULTS.cacheTtl,
			failureMode: config?.failureMode ?? CRL_DEFAULTS.failureMode,
			gracePeriod: CRL_DEFAULTS.gracePeriod,
		};
	}

	return {
		...config.crl,
		failureMode: config.crl.failureMode ?? config.failureMode ?? CRL_DEFAULTS.failureMode,
	};
}
