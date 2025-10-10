/**
 * Configuration parsing and default values for certificate verification
 */

import { loggerWithTag } from '../../utility/logging/logger.js';
import { packageJson } from '../../utility/packageUtils.js';
import type { CertificateVerificationConfig } from './types.ts';
import { validateAndParseCertificateVerificationConfig } from './configValidation.ts';

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

// Track validation errors to prevent repeated error logging and provide graceful degradation
// Maps config object to the error that occurred during validation
const validationErrorCache = new WeakMap<Record<string, any>, Error>();
let lastPrimitiveValidationError: Error | null = null;

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
 * ERROR HANDLING:
 * - Invalid config causes validation errors to be thrown on first access
 * - Validation errors are logged once and then cached
 * - Subsequent accesses with the same invalid config return false (disabled) to prevent
 *   repeated error logging and allow the application to continue running
 * - This provides fail-safe behavior: invalid security config defaults to disabled
 *   rather than crashing on every request
 *
 * @param mtlsConfig - The mTLS configuration from env.get()
 * @returns Configuration object or false if verification is disabled or invalid
 */
export function getCachedCertificateVerificationConfig(
	mtlsConfig?: boolean | Record<string, any> | null
): false | CertificateVerificationConfig {
	// Handle primitive values (boolean, null, undefined) with simple caching
	if (typeof mtlsConfig === 'boolean' || mtlsConfig == null) {
		// Check if we've already seen a validation error for this primitive config
		if (mtlsConfig === lastPrimitiveConfig && lastPrimitiveValidationError) {
			logger.trace?.('Using cached validation error result (primitive) - returning disabled');
			return false;
		}

		if (mtlsConfig === lastPrimitiveConfig && lastPrimitiveResult !== null) {
			logger.trace?.('Using cached certificate verification config (primitive)');
			return lastPrimitiveResult;
		}

		logger.trace?.('Parsing and caching certificate verification config (primitive)');
		lastPrimitiveConfig = mtlsConfig as boolean | null | undefined;
		try {
			lastPrimitiveResult = getCertificateVerificationConfig(mtlsConfig);
			lastPrimitiveValidationError = null; // Clear any previous error
			return lastPrimitiveResult;
		} catch (error) {
			// Cache the validation error to prevent repeated logging
			lastPrimitiveValidationError = error as Error;
			logger.error?.(
				`Certificate verification config validation failed - defaulting to disabled: ${(error as Error).message}`
			);
			return false; // Fail-safe: invalid config = disabled verification
		}
	}

	// Check for cached validation error
	const cachedError = validationErrorCache.get(mtlsConfig);
	if (cachedError) {
		logger.trace?.('Using cached validation error result (object) - returning disabled');
		return false;
	}

	const cached = configCache.get(mtlsConfig);
	if (cached !== undefined) {
		logger.trace?.('Using cached certificate verification config (object)');
		return cached;
	}

	// Cache miss: parse and store the result
	logger.trace?.('Parsing and caching certificate verification config (object)');
	try {
		const result = getCertificateVerificationConfig(mtlsConfig);
		configCache.set(mtlsConfig, result);
		return result;
	} catch (error) {
		// Cache the validation error to prevent repeated logging
		validationErrorCache.set(mtlsConfig, error as Error);
		logger.error?.(
			`Certificate verification config validation failed - defaulting to disabled: ${(error as Error).message}`
		);
		return false; // Fail-safe: invalid config = disabled verification
	}
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

	const verificationConfig = mtlsConfig === true ? undefined : mtlsConfig.certificateVerification;
	logger.trace?.(`Certificate verification config: ${JSON.stringify({ verificationConfig })}`);

	// Default to disabled for initial rollout to allow intentional real-world testing
	// Users must explicitly enable certificate verification with certificateVerification: true or config object
	if (verificationConfig == null || verificationConfig === false) return false;

	// Pass through validator for enabled cases (true or object)
	// Convert true to empty object so validator applies all defaults
	// This ensures we always get a complete config with crl and ocsp defaults
	const configToValidate = verificationConfig === true ? {} : verificationConfig;

	// Let validation errors propagate up to getCachedCertificateVerificationConfig
	// which will log them once and cache the error
	return validateAndParseCertificateVerificationConfig(configToValidate);
}
