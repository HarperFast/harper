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
 * Authentication answers a rejected credential with 401 regardless of the underlying error's own
 * `statusCode`, so pinning it here keeps immediate and deferred rejections byte-identical.
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
	// Name the serializer explicitly so the response body remains self-describing.
	const contentType = (request?.headers ? findBestSerializer(request).type : undefined) ?? 'application/json';
	return {
		status: deferred.status,
		// A real Headers, not a plain object: authentication stamps the #1565 identity floor onto
		// whatever an owning layer returns, and the HTTP bridges read it back through `get`.
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
