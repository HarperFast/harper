import { ClientError } from '../utility/errors/hdbError.ts';

// Explicit provenance prevents internal faults with a 4xx status from being deferred as rejected credentials.
const CREDENTIAL_REJECTION = Symbol('harper.credentialRejection');

export function markCredentialRejection<E extends object>(error: E): E {
	Object.defineProperty(error, CREDENTIAL_REJECTION, {
		value: true,
		enumerable: false,
		configurable: true,
		writable: false,
	});
	return error;
}

export function credentialRejectionError(message: string, statusCode: number): ClientError {
	return markCredentialRejection(new ClientError(message, statusCode));
}

export function isCredentialRejection(error: unknown): boolean {
	return (error as Record<symbol, unknown> | null | undefined)?.[CREDENTIAL_REJECTION] === true;
}

// Keyed by the request, paired with the error: a rejection object can be shared (frozen, module-level) across
// concurrent requests, so a tag on the error itself could name another request's validator.
const rejectingValidatorOf = new WeakMap<object, { error: unknown; resourceMetadata: string | null }>();

/**
 * Records, on a credential rejection a Bearer validator caused, the protected-resource metadata URL that
 * validator declared (`null` when it declared none), so a 401 can point the client at the authorization server
 * that refused it.
 */
export function markRejectingValidator<E>(request: object, error: E, resourceMetadata: string | undefined): E {
	if (isCredentialRejection(error))
		rejectingValidatorOf.set(request, { error, resourceMetadata: resourceMetadata ?? null });
	return error;
}

/** The metadata URL of the validator that raised `error` for `request`, `null` when it declared none, else `undefined`. */
export function rejectingValidatorMetadata(request: unknown, error: unknown): string | null | undefined {
	if (request === null || typeof request !== 'object') return undefined;
	const tagged = rejectingValidatorOf.get(request);
	return tagged && tagged.error === error ? tagged.resourceMetadata : undefined;
}
