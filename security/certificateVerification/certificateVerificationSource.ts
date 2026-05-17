/**
 * Certificate verification source that handles both CRL and OCSP methods
 */

import { Resource } from '../../resources/Resource.ts';
import type { SourceContext, Query } from '../../resources/ResourceInterface.ts';
import type { CertificateVerificationContext } from './types.ts';

// Import verification functions
let performCRLCheck: any;
let performOCSPCheck: any;

// Lazy load to avoid circular dependencies
async function loadVerificationFunctions() {
	if (!performCRLCheck) {
		const crlModule = await import('./crlVerification.js');
		performCRLCheck = (crlModule as any).performCRLCheck;
	}
	if (!performOCSPCheck) {
		const ocspModule = await import('./ocspVerification.js');
		performOCSPCheck = (ocspModule as any).performOCSPCheck;
	}
}

/**
 * Certificate Verification Source that can handle both CRL and OCSP.
 *
 * Late-bound via a Proxy because this module is loaded inside Resource.ts's
 * own static-graph SCC (via the auth.ts → server-utilities chain), so a
 * class-extends declaration at module-top would TDZ on `Resource`. The Proxy
 * defers the `extends Resource` evaluation to first construct/access.
 */
let _CertificateVerificationSource: any;
function getCertificateVerificationSource(): any {
	if (!_CertificateVerificationSource) {
		_CertificateVerificationSource = class CertificateVerificationSource extends Resource {
			async get(query: Query) {
				const id = query.id as string;

				// Get the certificate data from requestContext
				const context = this.getContext() as SourceContext<CertificateVerificationContext>;
				const requestContext = context?.requestContext;

				if (!requestContext || !requestContext.certPem || !requestContext.issuerPem) {
					// Likely a source request for an expired entry - we can't verify without cert and issuer data
					return null;
				}

				const { certPem: certPemStr, issuerPem: issuerPemStr, ocspUrls, config } = requestContext;

				// Determine method from cache key
				let method: string;
				if (id.startsWith('crl:')) {
					method = 'crl';
				} else if (id.startsWith('ocsp:')) {
					method = 'ocsp';
				} else {
					method = 'unknown';
				}

				// Load verification functions
				await loadVerificationFunctions();

				// Perform verification based on method
				let result;
				let methodConfig;

				if (method === 'crl') {
					methodConfig = config.crl;
					// Pass distributionPoint as an array if available (for CRL fetch)
					const crlUrls = requestContext.distributionPoint ? [requestContext.distributionPoint] : undefined;
					result = await performCRLCheck(certPemStr, issuerPemStr, methodConfig, crlUrls);
				} else if (method === 'ocsp') {
					methodConfig = config.ocsp;
					result = await performOCSPCheck(certPemStr, issuerPemStr, methodConfig, ocspUrls);
				} else {
					throw new Error(`Unsupported verification method: ${method} for ID: ${id}`);
				}

				// Handle result consistently
				const expiresAt = Date.now() + methodConfig.cacheTtl;

				return {
					certificate_id: id,
					status: result.status,
					reason: result.reason,
					checked_at: Date.now(),
					expiresAt,
					method,
				};
			}
		};
	}
	return _CertificateVerificationSource;
}

export const CertificateVerificationSource: any = new Proxy(function () {} as any, {
	construct(_target, args) {
		return Reflect.construct(getCertificateVerificationSource(), args);
	},
	get(_target, prop) {
		return getCertificateVerificationSource()[prop];
	},
	has(_target, prop) {
		return prop in getCertificateVerificationSource();
	},
	getPrototypeOf() {
		return getCertificateVerificationSource().prototype;
	},
});
