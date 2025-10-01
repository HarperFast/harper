/**
 * Configuration validation for certificate verification
 */

import Joi from 'joi';
import type { CertificateVerificationConfig, OCSPDefaults, CRLDefaults } from './types.ts';

export const DEFAULT_FAILURE_MODE = 'fail-closed'; // Global default for certificate verification

// Default configuration values for OCSP
export const OCSP_DEFAULTS: OCSPDefaults = {
	timeout: 5000, // 5 seconds
	cacheTtl: 3600000, // 1 hour
	errorCacheTtl: 300000, // 5 minutes (shorter for faster recovery)
	failureMode: 'fail-closed',
};

// Default configuration values for CRL
export const CRL_DEFAULTS: CRLDefaults = {
	timeout: 10000, // 10 seconds
	cacheTtl: 86400000, // 24 hours
	failureMode: 'fail-closed',
	gracePeriod: 86400000, // 24 hours after nextUpdate
};

const failureModeSchema = Joi.string().valid('fail-open', 'fail-closed');

// CRL config schema that handles boolean shorthand and object config
const crlConfigSchema = Joi.alternatives().try(
	// Boolean shorthand: false = disabled, true = enabled with defaults
	Joi.boolean().custom((value) => {
		if (value === false) {
			return { enabled: false };
		}
		// true = enabled with all defaults
		return { enabled: true, ...CRL_DEFAULTS };
	}),
	// Object config with defaults applied
	Joi.object({
		enabled: Joi.boolean().default(true),
		timeout: Joi.number().min(1000).default(CRL_DEFAULTS.timeout).messages({
			'number.min': 'CRL timeout must be at least 1000ms (1 second)',
		}),
		cacheTtl: Joi.number().min(1000).default(CRL_DEFAULTS.cacheTtl).messages({
			'number.min': 'CRL cacheTtl must be at least 1000ms (1 second)',
		}),
		failureMode: failureModeSchema.default(CRL_DEFAULTS.failureMode),
		gracePeriod: Joi.number().min(0).default(CRL_DEFAULTS.gracePeriod).messages({
			'number.min': 'CRL gracePeriod must be at least 0ms',
		}),
	})
);

// OCSP config schema that handles boolean shorthand and object config
const ocspConfigSchema = Joi.alternatives().try(
	// Boolean shorthand: false = disabled, true = enabled with defaults
	Joi.boolean().custom((value) => {
		if (value === false) {
			return { enabled: false };
		}
		// true = enabled with all defaults
		return { enabled: true, ...OCSP_DEFAULTS };
	}),
	// Object config with defaults applied
	Joi.object({
		enabled: Joi.boolean().default(true),
		timeout: Joi.number().min(1000).default(OCSP_DEFAULTS.timeout).messages({
			'number.min': 'OCSP timeout must be at least 1000ms (1 second)',
		}),
		cacheTtl: Joi.number().min(1000).default(OCSP_DEFAULTS.cacheTtl).messages({
			'number.min': 'OCSP cacheTtl must be at least 1000ms (1 second)',
		}),
		errorCacheTtl: Joi.number().min(1000).default(OCSP_DEFAULTS.errorCacheTtl).messages({
			'number.min': 'OCSP errorCacheTtl must be at least 1000ms (1 second)',
		}),
		failureMode: failureModeSchema.default(OCSP_DEFAULTS.failureMode),
	})
);

// Main certificate verification schema
// Note: crl and ocsp default to "enabled with defaults" if not provided
const certificateVerificationSchema = Joi.object({
	failureMode: failureModeSchema.default(DEFAULT_FAILURE_MODE),
	crl: crlConfigSchema.default({ enabled: true, ...CRL_DEFAULTS }),
	ocsp: ocspConfigSchema.default({ enabled: true, ...OCSP_DEFAULTS }),
});

/**
 * Validate and parse certificate verification configuration
 * @param config - Certificate verification configuration to validate
 * @returns Validated and parsed configuration object
 * @throws {Error} If configuration is invalid
 */
export function validateAndParseCertificateVerificationConfig(config: unknown): CertificateVerificationConfig {
	const { error, value } = certificateVerificationSchema.validate(config, {
		abortEarly: false,
		allowUnknown: false,
	});

	if (error) {
		const errorMessage = error.details.map((detail) => detail.message).join('; ');
		throw new Error(`Invalid certificate verification configuration: ${errorMessage}`);
	}

	// Return the validated config (Joi has already done the parsing/validation)
	return value as CertificateVerificationConfig;
}
