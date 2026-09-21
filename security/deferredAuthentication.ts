import { ClientError } from '../utility/errors/hdbError.ts';
import { serializeMessage, findBestSerializer } from '../server/serverHelpers/contentTypes.ts';
import { Headers } from '../server/serverHelpers/Headers.ts';

export { isCredentialRejection, markCredentialRejection, credentialRejectionError } from './credentialRejection.ts';

const DEFERRED_CREDENTIAL_REJECTION = Symbol('harper.deferredCredentialRejection');

export type DeferredCredentialRejection = {
	readonly status: number;
	readonly message: string;
	readonly strategy: string;
};

const CREDENTIAL_REJECTION_STATUS = 401;

/**
 * Records that this request presented a credential Harper rejected, without deciding the request.
 * The caller leaves `request.user` unset and the inbound `Authorization` header untouched.
 *
 * The immutable, non-enumerable descriptor prevents downstream middleware from clearing it and
 * keeps it out of request copies and serialization.
 */
export function deferCredentialRejection(request: any, error: { message?: string }, strategy: string): void {
	if (getDeferredCredentialRejection(request)) return;
	const deferred: DeferredCredentialRejection = Object.freeze({
		status: CREDENTIAL_REJECTION_STATUS,
		message: error?.message ?? 'Unauthorized',
		strategy,
	});
	Object.defineProperty(request, DEFERRED_CREDENTIAL_REJECTION, {
		value: deferred,
		enumerable: false,
		configurable: false,
		writable: false,
	});
}

export function getDeferredCredentialRejection(request: any): DeferredCredentialRejection | undefined {
	return request?.[DEFERRED_CREDENTIAL_REJECTION];
}

/**
 * The response an owning layer returns once it has established Harper owns the route: exactly the
 * descriptor `security/auth.ts` returns in-line, so immediate and deferred rejection share a wire
 * contract.
 *
 * Owner-specific error mapping must not run first. REST renders a thrown error as an RFC 9457
 * Problem Details document and GraphQL as `{errors:[…]}` rather than authentication's negotiated
 * `{error: message}` response. `security/auth.ts` likewise leaves a settled rejection's status and
 * challenge headers alone, so it stays byte-identical to the in-line 401 it replaced.
 *
 * Returns `undefined` when nothing was deferred, so a caller can `return settled ?? …` inline.
 */
export function settleDeferredCredentialRejection(
	request: any
): { status: number; headers: Headers; body: string | Buffer } | undefined {
	const deferred = getDeferredCredentialRejection(request);
	if (!deferred) return undefined;
	const contentType = (request?.headers ? findBestSerializer(request).type : undefined) ?? 'application/json';
	return {
		status: deferred.status,
		headers: new Headers({ 'Content-Type': contentType }),
		body: serializeMessage({ error: deferred.message }, request) as string | Buffer,
	};
}

const REJECTED_IN_PLACE = Symbol('harper.authenticationRejectedInPlace');

/**
 * Records an authentication decision the middleware answered in place, with the client-safe message
 * the HTTP response carries. A WebSocket or MQTT upgrade only awaits the chain and never reads its
 * resolved value, so a returned 401 is invisible to it; without this record such an upgrade would
 * continue with no principal on a fault that failed the equivalent HTTP request closed.
 */
export function markAuthenticationRejectedInPlace(request: any, status: number, message: string): void {
	if (request?.[REJECTED_IN_PLACE]) return;
	Object.defineProperty(request, REJECTED_IN_PLACE, {
		value: Object.freeze({ status, message }),
		enumerable: false,
		configurable: false,
		writable: false,
	});
}

export function getAuthenticationRejectedInPlace(request: any): { status: number; message: string } | undefined {
	return request?.[REJECTED_IN_PLACE];
}

export function assertNoDeferredCredentialRejection(request: any): void {
	const rejected = getDeferredCredentialRejection(request) ?? getAuthenticationRejectedInPlace(request);
	if (rejected) throw new ClientError(rejected.message, rejected.status);
}
