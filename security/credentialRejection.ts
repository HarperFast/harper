import { ClientError } from '../utility/errors/hdbError.ts';

/**
 * Marks an error as "the presented credential is not acceptable", as opposed to "Harper could not
 * evaluate the credential". Only the authentication code that actually reaches that conclusion sets
 * it, so provenance is asserted at the throw site rather than inferred from a status code.
 *
 * Non-enumerable and symbol-keyed: it never serializes, never reaches a client, and cannot be set by
 * anything that does not import this module.
 */
const CREDENTIAL_REJECTION = Symbol('harper.credentialRejection');

/** Tags an existing error as a positively identified credential rejection. Returns the same error. */
export function markCredentialRejection<E extends object>(error: E): E {
	Object.defineProperty(error, CREDENTIAL_REJECTION, {
		value: true,
		enumerable: false,
		configurable: true,
		writable: false,
	});
	return error;
}

/** Builds the tagged `ClientError` an authentication layer raises when it rejects a credential. */
export function credentialRejectionError(message: string, statusCode: number): ClientError {
	return markCredentialRejection(new ClientError(message, statusCode));
}

/**
 * True only for an error explicitly tagged at the point authentication decided the credential itself
 * is unacceptable.
 *
 * Provenance is never inferred from the status range. `ResourceBridge.searchByValue()` raises a
 * default-status-400 `ClientError` when a system table is missing, and `findAndValidateUser()`
 * reaches it while lazily loading the user cache — treating that 4xx as a rejected credential would
 * let a storage outage hand a Harper request to an application's own authorization (#2418).
 */
export function isCredentialRejection(error: unknown): boolean {
	return (error as Record<symbol, unknown> | null | undefined)?.[CREDENTIAL_REJECTION] === true;
}
