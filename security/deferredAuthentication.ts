import { ClientError } from '../utility/errors/hdbError.ts';
import { serializeMessage, findBestSerializer } from '../server/serverHelpers/contentTypes.ts';
import { Headers } from '../server/serverHelpers/Headers.ts';

export { isCredentialRejection, markCredentialRejection, credentialRejectionError } from './credentialRejection.ts';

/**
 * Request-local state recorded when `security/auth.ts` accepts a syntactically valid credential it
 * cannot resolve to a Harper principal. It is deliberately not a header, not a `Request` field, and
 * not enumerable: nothing outside this module can read, forge, or clear it, and it cannot reach the
 * wire or a downstream application.
 */
const DEFERRED_CREDENTIAL_REJECTION = Symbol('harper.deferredCredentialRejection');

export type DeferredCredentialRejection = {
	/** Status the authentication middleware would have returned in-line. Always 401. */
	status: number;
	/** The rejection message that middleware would have carried, so the deferred response is identical. */
	message: string;
	/** `Basic`, `Bearer`, or whatever scheme token preceded the credential. */
	strategy: string;
};

/**
 * The status every credential rejection resolves to, whether it is answered in-line or deferred.
 * `security/auth.ts` has always answered a rejected credential with 401 regardless of the
 * underlying error's own `statusCode` (a 403 `token expired`, for instance), so pinning it here is
 * what keeps a deferred rejection byte-identical to the in-line one it replaces.
 */
const CREDENTIAL_REJECTION_STATUS = 401;

/**
 * Records that this request presented a credential Harper rejected, without deciding the request.
 * The caller leaves `request.user` unset and the inbound `Authorization` header untouched.
 *
 * Installed non-enumerable so an application catch-all that spreads or `Reflect.ownKeys`-walks the
 * request cannot observe it: object spread copies enumerable symbol-keyed properties.
 */
export function deferCredentialRejection(request: any, error: { message?: string }, strategy: string): void {
	const deferred: DeferredCredentialRejection = {
		status: CREDENTIAL_REJECTION_STATUS,
		message: error?.message ?? 'Unauthorized',
		strategy,
	};
	Object.defineProperty(request, DEFERRED_CREDENTIAL_REJECTION, {
		value: deferred,
		enumerable: false,
		configurable: true,
		writable: true,
	});
}

export function getDeferredCredentialRejection(request: any): DeferredCredentialRejection | undefined {
	return request?.[DEFERRED_CREDENTIAL_REJECTION];
}

/**
 * The response an owning layer returns once it has established Harper owns the route: exactly the
 * descriptor `security/auth.ts` used to return in-line, so the wire contract a rejected credential
 * has always produced survives the move downstream.
 *
 * Owner-specific error mapping must not run first. REST renders a thrown error as an RFC 9457
 * Problem Details document and GraphQL as `{errors:[…]}`; before deferral existed, neither ever saw
 * a rejected credential, because authentication answered `{error: message}` in the request's
 * negotiated serialization before route matching (#2418).
 *
 * Returns `undefined` when nothing was deferred, so a caller can `return settled ?? …` inline.
 */
export function settleDeferredCredentialRejection(
	request: any
): { status: number; headers: Headers; body: string | Buffer } | undefined {
	const deferred = getDeferredCredentialRejection(request);
	if (!deferred) return undefined;
	// The negotiated serializer is the same one `serializeMessage` selects below; naming it in
	// Content-Type keeps the body self-describing on a path that historically emitted none.
	const contentType = (request?.headers ? findBestSerializer(request).type : undefined) ?? 'application/json';
	return {
		status: deferred.status,
		// A real Headers, not a plain object: the authentication middleware's own 401 post-processing
		// calls `response.headers.set()` (WWW-Authenticate, or a Location when a login page is
		// configured) on whatever an owning layer returns, and a plain object has no `set`.
		headers: new Headers({ 'Content-Type': contentType }),
		body: serializeMessage({ error: deferred.message }, request) as string | Buffer,
	};
}

/**
 * Throwing form of `settleDeferredCredentialRejection`, for owners with no response descriptor to
 * return — a WebSocket upgrade closes the socket with a status-derived close code instead.
 */
export function assertNoDeferredCredentialRejection(request: any): void {
	const deferred = getDeferredCredentialRejection(request);
	if (deferred) throw new ClientError(deferred.message, deferred.status);
}
