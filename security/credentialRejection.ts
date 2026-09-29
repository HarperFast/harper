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

/**
 * Whether an error is a credential Harper, or a `server.getUser` override, rejected — as opposed to an
 * internal fault. A protocol that authenticates after its handshake (`server.getUser(username,
 * password)` on a RESP `AUTH`, as MQTT does on CONNECT) answers a rejection with its bad-credentials
 * reply and treats anything else as a fault to close the connection on. Only an error tagged by
 * `markCredentialRejection`/`credentialRejectionError` qualifies; a 4xx status alone does not.
 */
export function isCredentialRejection(error: unknown): boolean {
	return (error as Record<symbol, unknown> | null | undefined)?.[CREDENTIAL_REJECTION] === true;
}
