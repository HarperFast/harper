// Built-in components (HARPER_BUILTIN_COMPONENTS) load via native import() on the main thread too;
// importing the root 'harper' entry here would evaluate threadServer.js on the main thread.
import { credentialRejectionError } from '../../../dist/security/credentialRejection.js';

export const RESOURCE_METADATA = 'https://auth.example.test/.well-known/oauth-protected-resource/mcp';
export const VALID_TOKEN = 'stateless-valid';
export const REFUSED_BY_UNDECLARED_TOKEN = 'stateless-refused-by-undeclared';

export function handleApplication(scope) {
	scope.server.registerBearerValidator(
		async (token) =>
			token === VALID_TOKEN ? { username: 'admin', authExpiresAt: Math.floor(Date.now() / 1000) + 300 } : undefined,
		{ challenge: { resourceMetadata: RESOURCE_METADATA } }
	);
	// declares no challenge, so a token it refuses must not be pointed at the other validator's server
	scope.server.registerBearerValidator(async (token) => {
		if (token === REFUSED_BY_UNDECLARED_TOKEN) throw credentialRejectionError('token revoked', 401);
	});
}
