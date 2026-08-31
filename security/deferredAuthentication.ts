import { ClientError } from '../utility/errors/hdbError.ts';

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
 * Distinguishes an ordinary credential rejection — a well-formed credential Harper does not
 * recognize — from an internal authentication fault such as unreadable JWT keys, a storage failure,
 * or a bug.
 *
 * Only the former may be deferred. Deferring a fault would let an outage quietly downgrade a Harper
 * request into one an application's own authorization decides, so anything that is not positively
 * identifiable as a client-side rejection fails closed. Harper's authentication errors carry a 4xx
 * `statusCode` (`ClientError`); an unexpected error type, a bare `Error`, and a 5xx all fall through
 * to `false`.
 */
export function isCredentialRejection(error: unknown): boolean {
	const status = (error as { statusCode?: unknown; status?: unknown })?.statusCode ?? (error as any)?.status;
	return typeof status === 'number' && status >= 400 && status < 500;
}

/**
 * Records that this request presented a credential Harper rejected, without deciding the request.
 * The caller leaves `request.user` unset and the inbound `Authorization` header untouched.
 */
export function deferCredentialRejection(request: any, error: { message?: string }, strategy: string): void {
	const deferred: DeferredCredentialRejection = {
		status: CREDENTIAL_REJECTION_STATUS,
		message: error?.message ?? 'Unauthorized',
		strategy,
	};
	request[DEFERRED_CREDENTIAL_REJECTION] = deferred;
}

export function getDeferredCredentialRejection(request: any): DeferredCredentialRejection | undefined {
	return request?.[DEFERRED_CREDENTIAL_REJECTION];
}

/**
 * Called by a layer that has just established Harper owns the route being served. A credential the
 * authentication middleware deferred is decided here — where ownership is finally known — and never
 * travels past a Harper-owned route to an application catch-all.
 *
 * Throws the same `ClientError` the authentication middleware would have produced in-line, so an
 * owning layer's existing error path renders the identical unauthorized response.
 */
export function assertNoDeferredCredentialRejection(request: any): void {
	const deferred = getDeferredCredentialRejection(request);
	if (deferred) throw new ClientError(deferred.message, deferred.status);
}
