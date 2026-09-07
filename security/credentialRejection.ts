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
