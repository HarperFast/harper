import { ClientError } from '../utility/errors/hdbError.ts';

/**
 * An error carrying `credentialRejection: true` is a credential Harper, or a `server.getUser` override,
 * rejected — as opposed to an internal fault. Authentication defers a rejection to the route owner and
 * fails an internal fault closed. A protocol that authenticates after its handshake (`server.getUser(
 * username, password)` on a RESP `AUTH`, as MQTT does on CONNECT) answers a rejection with its
 * bad-credentials reply and treats anything else as a fault to close the connection on.
 *
 * Only the code that concludes the credential is unacceptable sets it; a 4xx status alone never means
 * rejection. It is a plain property rather than a module-private symbol so every copy of this module,
 * and every component compartment, reads the same tag.
 */
export interface CredentialRejection {
	readonly credentialRejection: true;
}

export function markCredentialRejection<E extends object>(error: E): E & CredentialRejection {
	Object.defineProperty(error, 'credentialRejection', {
		value: true,
		enumerable: false,
		configurable: true,
		writable: false,
	});
	return error as E & CredentialRejection;
}

export function credentialRejectionError(message: string, statusCode: number): ClientError & CredentialRejection {
	return markCredentialRejection(new ClientError(message, statusCode));
}
