/**
 * Certificate verification source that handles both CRL and OCSP methods
 */

import { Resource } from '../../resources/Resource.ts';
import type { SourceContext, Query } from '../../resources/ResourceInterface.ts';
import type { CertificateVerificationContext } from './types.ts';

// Lazy, memoized imports to avoid circular dependencies without re-hitting the module loader on
// every cache miss, loading only the module the request needs. We cache the module *promises*, not
// the resolved functions, and read each function off the live module object (`default` is the CJS
// module.exports) on every call: a CJS module's named exports are snapshotted into the ESM namespace
// at first import, so a cached function reference (or namespace binding) would honor a stale
// implementation forever — e.g. a test double pinned past its restore.
let crlModulePromise: Promise<any> | null = null;
let ocspModulePromise: Promise<any> | null = null;

async function loadVerificationFunctions(method?: string) {
	const crlPromise = !method || method === 'crl' ? (crlModulePromise ??= import('./crlVerification.js')) : null;
	const ocspPromise = !method || method === 'ocsp' ? (ocspModulePromise ??= import('./ocspVerification.js')) : null;
	const [crlModule, ocspModule] = await Promise.all([crlPromise, ocspPromise]);
	const crl = crlModule ? ((crlModule as any).default ?? crlModule) : null;
	const ocsp = ocspModule ? ((ocspModule as any).default ?? ocspModule) : null;
	return {
		performCRLCheck: crl?.performCRLCheck,
		performOCSPCheck: ocsp?.performOCSPCheck,
	};
}

/**
 * Certificate Verification Source that can handle both CRL and OCSP
 */
export class CertificateVerificationSource extends Resource {
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
		const { performCRLCheck, performOCSPCheck } = await loadVerificationFunctions(method);

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
}
